/**
 * Offline checks for the session-boundary hook.
 *
 * The judgment is always a fake here: no key is loaded and no network call is
 * made. The process-level checks strip both credential variables from the
 * child's environment, so even the real judge path can only reach its
 * "no key, stay silent" branch.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { LIMITS, evaluate, lastContextTokens } from "../hooks/session-boundary.mjs";

const root = mkdtempSync(join(tmpdir(), "session-boundary-"));
const hookPath = fileURLToPath(new URL("../hooks/session-boundary.mjs", import.meta.url));

/** A transcript whose last request carried `tokens` of context. */
function transcript(name, tokens, padLines = 0) {
  const path = join(root, `${name}.jsonl`);
  const filler = Array.from({ length: padLines }, (_, i) => JSON.stringify({ type: "event_msg", payload: { type: "noise", i, pad: "x".repeat(200) } }));
  const count = (n) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: n } } } });
  writeFileSync(path, [count(1_000), ...filler, count(tokens)].join("\n") + "\n");
  return path;
}

/** A judge that records every call and answers with a fixed verdict. */
function fakeJudge(verdict) {
  const calls = [];
  const judge = async (args) => {
    calls.push(args);
    if (verdict instanceof Error) throw verdict;
    return verdict;
  };
  return { judge, calls };
}

/** Feed a sequence of prompts to one session; returns the last result. */
async function run(session, prompts, { tokens, verdict, stateDir }) {
  const path = transcript(session, tokens);
  const fake = fakeJudge(verdict);
  let result;
  for (const prompt of prompts) {
    result = await evaluate({ session_id: session, transcript_path: path, prompt }, { judge: fake.judge, stateDir });
  }
  return { result, calls: fake.calls };
}

const NEW = { choice: "new_task", confidence: 0.95 };
const LONG = 150_000;

try {
  // 1. Without history there is no baseline, so the judgment is never asked.
  {
    const stateDir = join(root, "s1");
    const { result, calls } = await run("a", ["修复 DSH 超时", "再看看日志"], { tokens: LONG, verdict: NEW, stateDir });
    assert.equal(result.output, null);
    assert.equal(calls.length, 0, "with fewer than two prior prompts the judge must not be called");
    console.log("ok - no suggestion and no judgment before a baseline exists");
  }

  // 2. A short session is cheap; a fresh one would save little.
  {
    const stateDir = join(root, "s2");
    const { result, calls } = await run("b", ["a", "b", "写一篇小红书文案"], { tokens: 60_000, verdict: NEW, stateDir });
    assert.equal(result.output, null);
    assert.equal(result.reason, "session not long enough");
    assert.equal(calls.length, 0, "a short session must not spend a judgment");
    console.log("ok - a short session is left alone without a judgment");
  }

  // 3. Long session, clearly unrelated request: suggest a fresh session.
  {
    const stateDir = join(root, "s3");
    const { result, calls } = await run("c", ["排查 DSH 超时", "看下失败的工作流", "帮我写一篇小红书文案"], {
      tokens: LONG,
      verdict: NEW,
      stateDir,
    });
    assert.equal(calls.length, 1);
    assert.ok(result.output?.systemMessage.includes("/new"), "the suggestion names the action");
    assert.ok(result.output.systemMessage.includes("15 万"), "the suggestion states the current cost");
    console.log("ok - a long session with an unrelated request gets one suggestion");
  }

  // 4. A continuation, however vague, is never flagged.
  {
    const stateDir = join(root, "s4");
    const { result } = await run("d", ["排查 DSH 超时", "看下失败的工作流", "再帮我查一下日志"], {
      tokens: LONG,
      verdict: { choice: "continue", confidence: 0.9 },
      stateDir,
    });
    assert.equal(result.output, null);
    assert.equal(result.reason, "continuation");
    console.log("ok - a continuation stays silent");
  }

  // 5. An unsure "new task" is not enough: false alarms teach people to ignore it.
  {
    const stateDir = join(root, "s5");
    const { result } = await run("e", ["a", "b", "c"], { tokens: LONG, verdict: { choice: "new_task", confidence: 0.6 }, stateDir });
    assert.equal(result.output, null);
    assert.equal(result.reason, "not confident");
    console.log("ok - a low-confidence new_task stays silent");
  }

  // 6. After a suggestion, stay quiet for the cooldown, then judge again.
  {
    const stateDir = join(root, "s6");
    const path = transcript("f", LONG);
    const fake = fakeJudge(NEW);
    const send = (prompt) => evaluate({ session_id: "f", transcript_path: path, prompt }, { judge: fake.judge, stateDir });
    await send("a");
    await send("b");
    const first = await send("c");
    assert.ok(first.output, "the first eligible prompt is suggested");
    const callsAfterFirst = fake.calls.length;
    for (let i = 0; i < LIMITS.COOLDOWN_PROMPTS; i += 1) {
      const quiet = await send(`follow-up ${i}`);
      assert.equal(quiet.output, null, "no repeat during the cooldown");
      assert.equal(quiet.reason, "cooling down");
    }
    assert.equal(fake.calls.length, callsAfterFirst, "the cooldown also saves the judgment calls");
    const again = await send("another unrelated task");
    assert.ok(again.output, "after the cooldown a new boundary can be suggested");
    console.log("ok - one suggestion per cooldown, without spending judgments meanwhile");
  }

  // 7. A failing judgment fails open, and the prompt is still recorded.
  {
    const stateDir = join(root, "s7");
    const { result } = await run("g", ["a", "b", "c"], { tokens: LONG, verdict: new Error("network down"), stateDir });
    assert.equal(result.output, null);
    assert.equal(result.reason, "no judgment");
    const state = JSON.parse(readFileSync(join(stateDir, "g.json"), "utf8"));
    assert.equal(state.count, 3, "every prompt is counted even when the judgment fails");
    console.log("ok - a judgment failure is silent and keeps the history intact");
  }

  // 8. No key means no judgment and no suggestion.
  {
    const stateDir = join(root, "s8");
    const { result } = await run("h", ["a", "b", "c"], { tokens: LONG, verdict: null, stateDir });
    assert.equal(result.output, null);
    console.log("ok - a missing judgment (no key) is silent");
  }

  // 9. Only a bounded, truncated slice of the session is sent out.
  {
    const stateDir = join(root, "s9");
    const long = "长".repeat(LIMITS.PROMPT_CHARS + 500);
    // A "continue" verdict never starts a cooldown, so every eligible prompt is judged.
    const { calls } = await run("i", ["1", "2", "3", "4", "5", "6", long], {
      tokens: LONG,
      verdict: { choice: "continue", confidence: 0.9 },
      stateDir,
    });
    const last = calls.at(-1);
    assert.equal(last.prompt.length, LIMITS.PROMPT_CHARS, "the new request is truncated");
    assert.equal(last.recent.length, LIMITS.RECENT_PROMPTS, "only the last few requests are shared");
    assert.deepEqual(last.recent, ["3", "4", "5", "6"]);
    console.log("ok - the judgment sees a bounded, truncated slice of the session");
  }

  // 10. The context size is read from the transcript's tail.
  {
    assert.equal(lastContextTokens(transcript("j", 123_456, 3_000)), 123_456, "the last request wins over earlier ones");
    assert.equal(lastContextTokens(join(root, "missing.jsonl")), null, "a missing transcript is unknown, not zero");
    assert.equal(lastContextTokens(undefined), null);
    // A tail too small for the last record still cannot invent a number.
    assert.equal(lastContextTokens(transcript("k", 99_000), 10), null);
    console.log("ok - the context size comes from the last recorded request");
  }

  // 11. An empty prompt is ignored entirely.
  {
    const stateDir = join(root, "s11");
    const result = await evaluate({ session_id: "l", prompt: "   " }, { judge: fakeJudge(NEW).judge, stateDir });
    assert.equal(result.output, null);
    console.log("ok - an empty prompt is ignored");
  }

  // 12. As a real process, the hook never fails the prompt and stays silent without a key.
  {
    const env = { ...process.env, SESSION_BOUNDARY_STATE_DIR: join(root, "proc") };
    delete env.TYPESAFE_API_KEY;
    delete env.DSH_TYPESAFE_ENV_FILE;
    const malformed = spawnSync(process.execPath, [hookPath], { input: "not json", env, encoding: "utf8" });
    assert.equal(malformed.status, 0, "malformed input must not fail the prompt");
    assert.equal(malformed.stdout, "", "malformed input produces no output");

    const path = transcript("m", LONG);
    for (const prompt of ["排查超时", "看下工作流", "写小红书文案"]) {
      const res = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({ session_id: "m", transcript_path: path, prompt, hook_event_name: "UserPromptSubmit" }),
        env,
        encoding: "utf8",
      });
      assert.equal(res.status, 0, "the hook always exits 0");
      assert.equal(res.stdout, "", "without a key the hook stays silent");
    }
    console.log("ok - as a process it exits 0 and stays silent without a key");
  }

  console.log("all session-boundary checks passed");
} catch (error) {
  console.error("session-boundary check FAILED:", error.message);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
