#!/usr/bin/env node
// Offline checks for credential handling and the TypeSafe decision boundary.
//   node tests/choices.mjs
//
// The SDK is injected, so nothing here reaches the network. What is verified is
// the policy around the model: the key comes only from the two sanctioned
// places, and every unusable answer becomes a recorded serial fallback.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialStatus, decideConcurrency, loadApiKey } from "../src/choices.mjs";

const root = mkdtempSync(join(tmpdir(), "dsh-choices-"));

/** The `choice` builder double used by every injected client. */
const fakeChoice = (instructions, criteria) => ({ kind: "choice", instructions, criteria });

/** Build a client double returning one canned answer. */
function clientReturning(payload, { throws } = {}) {
  return async () => ({
    choice: fakeChoice,
    client: {
      systemOne: async (request) => {
        // A string is turned into a plain error; an Error is thrown as-is so a
        // test can attach a status the way a real SDK error carries one.
        if (throws) throw throws instanceof Error ? throws : new Error(throws);
        return payload(request);
      },
    },
  });
}

const task = (id) => ({ id, task: `do ${id}`, read_paths: [`src/${id}`], write_paths: [`src/${id}`] });
const options = [[task("a")], [task("a"), task("b")], [task("a"), task("b"), task("c")]];
const state = { objective: "test", mode: "workspace-write", allowed_paths: ["."] };

try {
  // --- credential resolution ----------------------------------------------
  assert.equal(loadApiKey({}), null, "no key configured must resolve to null");
  assert.equal(loadApiKey({ TYPESAFE_API_KEY: "  " }), null, "a blank key is not a key");
  assert.equal(loadApiKey({ TYPESAFE_API_KEY: "ts_env" }), "ts_env");

  // The env file is the only other sanctioned source, and only one variable is read.
  const envFile = join(root, ".env.secrets");
  writeFileSync(envFile, "TYPESAFE_API_KEY=ts_file\nUNRELATED_SECRET=do-not-read\n");
  assert.equal(loadApiKey({ DSH_TYPESAFE_ENV_FILE: envFile }), "ts_file");
  // The process environment wins over the file.
  assert.equal(
    loadApiKey({ DSH_TYPESAFE_ENV_FILE: envFile, TYPESAFE_API_KEY: "ts_env" }),
    "ts_env",
    "an explicit environment key takes precedence",
  );
  // Quoted values and comments are handled by Node's own parser.
  writeFileSync(envFile, '# comment\nTYPESAFE_API_KEY="ts_quoted"\nOTHER=nope\n');
  assert.equal(loadApiKey({ DSH_TYPESAFE_ENV_FILE: envFile }), "ts_quoted");
  // A missing or unreadable file is a null, never a crash.
  assert.equal(loadApiKey({ DSH_TYPESAFE_ENV_FILE: join(root, "absent.env") }), null);
  // A file without the key is a null too, and its other values are ignored.
  writeFileSync(envFile, "OTHER_SECRET=still-ignored\n");
  assert.equal(loadApiKey({ DSH_TYPESAFE_ENV_FILE: envFile }), null);
  chmodSync(envFile, 0o600);
  console.log("ok - the key is read only from TYPESAFE_API_KEY or the named env file");

  // credentialStatus reports availability and the file path, never the key.
  const status = credentialStatus({ DSH_TYPESAFE_ENV_FILE: envFile });
  assert.equal(status.available, false);
  assert.equal(status.source, `env-file:${envFile}`);
  assert.ok(!JSON.stringify(status).includes("still-ignored"), "no other env value may leak");
  assert.deepEqual(credentialStatus({}), { available: false, source: "none" });
  assert.equal(credentialStatus({ TYPESAFE_API_KEY: "ts_x" }).source, "env:TYPESAFE_API_KEY");
  console.log("ok - credential status never echoes key material or unrelated variables");

  // --- no key configured ---------------------------------------------------
  {
    const saved = process.env.TYPESAFE_API_KEY;
    const savedFile = process.env.DSH_TYPESAFE_ENV_FILE;
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.DSH_TYPESAFE_ENV_FILE;
    const decision = await decideConcurrency({ options, state });
    assert.equal(decision.count, 1, "a missing key must fall back to serial");
    assert.equal(decision.source, "fallback");
    assert.match(decision.reason, /no TypeSafe credential/);
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    if (savedFile !== undefined) process.env.DSH_TYPESAFE_ENV_FILE = savedFile;
    console.log("ok - a missing key degrades to a recorded serial fallback");
  }

  // --- no judgment needed for a single option -----------------------------
  {
    const decision = await decideConcurrency({ options: [[task("only")]], state });
    assert.equal(decision.source, "code");
    assert.equal(decision.count, 1);
    assert.match(decision.reason, /single feasible batch/);
    console.log("ok - one feasible batch is decided in code, with no model call");
  }

  // --- a valid choice ------------------------------------------------------
  process.env.TYPESAFE_API_KEY = "ts_test_key";
  {
    let seenCriteria = null;
    const decision = await decideConcurrency({
      options,
      state,
      clientFactory: clientReturning((request) => {
        seenCriteria = request.questions.concurrency.criteria;
        return {
          model: "jev-test",
          usage: { input_tokens: 1, output_tokens: 1 },
          answers: { concurrency: { type: "choice", choice: "3", confidence: 0.72, probabilities: {} } },
        };
      }),
    });
    assert.equal(decision.source, "typesafe");
    assert.equal(decision.count, 3);
    assert.equal(decision.confidence, 0.72);
    // Candidate labels are generated from the feasible sizes, never hard-coded.
    assert.deepEqual(Object.keys(seenCriteria), ["1", "2", "3"]);
    // The state carries the objective and task summaries, not the repository.
    assert.deepEqual(Object.keys(state).sort(), ["allowed_paths", "mode", "objective"]);
    console.log("ok - a valid TypeSafe choice is honoured with dynamically built candidates");
  }

  // --- unusable answers become fallbacks -----------------------------------
  for (const [label, payload] of [
    ["out-of-range", { answers: { concurrency: { choice: "99", confidence: 0.9 } } }],
    ["non-numeric", { answers: { concurrency: { choice: "a few", confidence: 0.9 } } }],
    ["missing", { answers: {} }],
  ]) {
    const decision = await decideConcurrency({
      options,
      state,
      clientFactory: clientReturning(() => payload),
    });
    assert.equal(decision.source, "fallback", `${label}: must fall back`);
    assert.equal(decision.count, 1, `${label}: fallback is serial`);
  }
  console.log("ok - out-of-range, non-numeric and missing choices fall back to serial");

  // --- transport failure ---------------------------------------------------
  {
    const decision = await decideConcurrency({
      options,
      state,
      clientFactory: clientReturning(null, { throws: "connect ETIMEDOUT" }),
    });
    assert.equal(decision.source, "fallback");
    assert.equal(decision.count, 1);
    // The raw SDK message is never echoed: it can carry headers or a body.
    assert.ok(!/ETIMEDOUT/.test(decision.reason), "the raw transport message must not be returned");
    assert.match(decision.reason, /TypeSafe call failed: call_error/);
    console.log("ok - an API failure falls back once, with the reason recorded");
  }

  // --- client construction failure ----------------------------------------
  {
    const decision = await decideConcurrency({
      options,
      state,
      clientFactory: async () => {
        throw new Error("bad constructor");
      },
    });
    assert.equal(decision.source, "fallback");
    assert.match(decision.reason, /TypeSafe client init failed: client_init_error/);
    console.log("ok - a client construction failure also falls back cleanly");
  }

  // --- no secret material may cross the boundary ---------------------------
  // The SDK can raise an error whose message embeds the request headers (the API
  // key) and the raw response body. None of that may reach the reason, the log,
  // or a returned choice label.
  {
    const SECRET_SENTINEL = "SECRET_SENTINEL_do_not_leak_1f4c";
    const logs = [];
    const leaky = () => {
      const error = new Error(
        `401 Unauthorized: Authorization: Bearer ${SECRET_SENTINEL} ; body={"key":"${SECRET_SENTINEL}"}`,
      );
      error.status = 401;
      return error;
    };

    for (const [label, factory] of [
      ["call", clientReturning(null, { throws: leaky() })],
      ["init", async () => { throw leaky(); }],
    ]) {
      const decision = await decideConcurrency({ options, state, clientFactory: factory, log: (line) => logs.push(String(line)) });
      assert.equal(decision.source, "fallback", `${label}: must fall back`);
      assert.equal(decision.count, 1, `${label}: fallback is serial`);
      assert.ok(
        !JSON.stringify(decision).includes(SECRET_SENTINEL),
        `${label}: the decision must not contain the sentinel`,
      );
      assert.match(decision.reason, /auth_rejected \(HTTP 401\)/, `${label}: only the category and status survive`);
    }

    // A 5xx and a bare transport failure are categorised, never echoed verbatim.
    const server = await decideConcurrency({
      options,
      state,
      clientFactory: (() => {
        const error = new Error(`500 body ${SECRET_SENTINEL}`);
        error.status = 503;
        return clientReturning(null, { throws: error });
      })(),
    });
    assert.match(server.reason, /upstream_unavailable \(HTTP 503\)/);
    assert.ok(!JSON.stringify(server).includes(SECRET_SENTINEL));

    // An unusable model choice must not echo the model's raw label either.
    const injected = await decideConcurrency({
      options,
      state,
      clientFactory: clientReturning(() => ({
        answers: { concurrency: { choice: SECRET_SENTINEL, confidence: 0.5 } },
      })),
    });
    assert.equal(injected.source, "fallback");
    assert.ok(!JSON.stringify(injected).includes(SECRET_SENTINEL), "the raw choice label must not be echoed");
    assert.match(injected.reason, /outside the offered range/);

    assert.ok(!logs.join("\n").includes(SECRET_SENTINEL), "no log line may contain the sentinel");
    console.log("ok - API failures expose only a fixed category and numeric status");
  }

  // --- an in-flight judgment is cancelled by the caller's signal -----------
  // A parent cancel or deadline must end the judgment promptly instead of
  // waiting out the full HTTP timeout.
  {
    let sawSignal = null;
    let aborted = false;
    const controller = new AbortController();
    const decisionPromise = decideConcurrency({
      options,
      state,
      signal: controller.signal,
      clientFactory: async () => ({
        choice: fakeChoice,
        client: {
          systemOne: (request, opts) =>
            new Promise((resolve, reject) => {
              sawSignal = opts?.signal;
              if (sawSignal?.aborted) {
                aborted = true;
                return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
              }
              sawSignal?.addEventListener("abort", () => {
                aborted = true;
                reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
              });
              // Never resolves on its own: only the abort can end it.
            }),
        },
      }),
    });
    await new Promise((done) => setTimeout(done, 50));
    assert.ok(sawSignal, "the request signal must be forwarded to the SDK call");
    controller.abort(new Error("workflow cancelled"));
    const decision = await decisionPromise;
    assert.equal(aborted, true, "aborting the caller signal must abort the in-flight request");
    assert.equal(decision.source, "fallback");
    assert.equal(decision.count, 1);
    assert.match(decision.reason, /aborted/);
    console.log("ok - a caller abort ends an in-flight judgment without waiting for the HTTP timeout");
  }

  // An already-aborted signal never starts a call at all.
  {
    const controller = new AbortController();
    controller.abort(new Error("deadline"));
    let called = false;
    const decision = await decideConcurrency({
      options,
      state,
      signal: controller.signal,
      clientFactory: async () => {
        called = true;
        return { choice: fakeChoice, client: { systemOne: async () => ({}) } };
      },
    });
    assert.equal(called, false, "no client may be built once the signal is already aborted");
    assert.equal(decision.source, "fallback");
    assert.match(decision.reason, /skipped/);
    console.log("ok - an already-expired deadline skips judgment entirely");
  }

  console.log("all choice and credential checks passed");
} finally {
  delete process.env.TYPESAFE_API_KEY;
  rmSync(root, { recursive: true, force: true });
}
