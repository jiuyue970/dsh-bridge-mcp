import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * TypeSafe-backed concurrency judgment.
 *
 * One narrow question is asked, once per scheduling decision: "of the batches
 * currently feasible, how many tasks should start now?" Code has already fixed
 * the candidate list; the model only picks from it. Everything that decides
 * what is *allowed* (dependency order, path conflicts, mode) lives in plan.mjs
 * and is never delegated to the model.
 *
 * Every failure mode here is explicit and bounded. A missing key, a transport
 * error, or a label the model invented all resolve to a recorded serial
 * fallback rather than a retry loop.
 */
import {
  TYPESAFE_API_KEY_VAR,
  TYPESAFE_ENV_FILE_VAR,
  TYPESAFE_TIMEOUT_MS,
} from "./config.mjs";

/**
 * Resolve the API key without ever exposing it.
 *
 * Order: process environment first, then the single named variable inside the
 * env file the operator pointed at. Only that one key is extracted; no other
 * value from the file is read, copied, or logged. Returns null when nothing is
 * configured, which is a supported state, not an error.
 */
export function loadApiKey(env = process.env) {
  const direct = env[TYPESAFE_API_KEY_VAR];
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim();

  const envFile = env[TYPESAFE_ENV_FILE_VAR];
  if (typeof envFile !== "string" || envFile.trim() === "") return null;
  let contents;
  try {
    contents = readFileSync(envFile.trim(), "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = parseEnv(contents);
  } catch {
    return null;
  }
  const value = parsed[TYPESAFE_API_KEY_VAR];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Describe key availability without revealing anything about the key itself.
 * The env file path is operator-supplied configuration, so echoing it is safe.
 */
export function credentialStatus(env = process.env) {
  if (typeof env[TYPESAFE_API_KEY_VAR] === "string" && env[TYPESAFE_API_KEY_VAR].trim() !== "") {
    return { available: true, source: "env:TYPESAFE_API_KEY" };
  }
  const envFile = env[TYPESAFE_ENV_FILE_VAR];
  if (typeof envFile === "string" && envFile.trim() !== "") {
    return { available: loadApiKey(env) !== null, source: `env-file:${envFile.trim()}` };
  }
  return { available: false, source: "none" };
}

/**
 * A fixed error category plus, when it is a number, the HTTP status.
 *
 * SDK error messages can embed request headers (including the API key) and
 * response bodies, so nothing derived from `error.message` or the response is
 * ever returned or logged. Only these enumerated categories cross the boundary.
 */
function describeFailure(stage, error) {
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR" || error?.name === "TimeoutError") {
    return { category: "aborted", status: null };
  }
  const status = typeof error?.status === "number" ? error.status : null;
  if (status === null) return { category: `${stage}_error`, status: null };
  if (status === 401 || status === 403) return { category: "auth_rejected", status };
  if (status === 429) return { category: "rate_limited", status };
  if (status >= 500) return { category: "upstream_unavailable", status };
  return { category: `${stage}_http_error`, status };
}

/** Human-readable, non-sensitive rendering of a failure descriptor. */
function describeFailureText(descriptor, context) {
  const where = context ? `${context}: ` : "";
  return descriptor.status === null
    ? `${where}${descriptor.category}`
    : `${where}${descriptor.category} (HTTP ${descriptor.status})`;
}

/**
 * Ask TypeSafe how many of the feasible tasks to start now.
 *
 * `options` is the list of candidate batches in plan order. `signal` is bound to
 * the parent workflow's cancellation and deadline so a judgment in flight stops
 * promptly instead of waiting out the whole HTTP timeout. Returns an explicit
 * decision object; it never throws, because the caller must be able to record
 * *why* it fell back rather than crash mid-workflow.
 */
export async function decideConcurrency({
  options,
  state,
  log = () => {},
  clientFactory,
  signal,
}) {
  const callerAborted = () => signal?.aborted === true;
  const abortReason = () =>
    signal?.reason instanceof Error ? signal.reason.name : "cancelled";

  if (options.length === 0) {
    return { source: "code", count: 0, reason: "no feasible tasks" };
  }
  if (options.length === 1) {
    // A single feasible batch needs no model: there is nothing to choose.
    return { source: "code", count: 1, reason: "single feasible batch; no judgment needed" };
  }
  if (callerAborted()) {
    return { source: "fallback", count: 1, reason: `TypeSafe judgment skipped: ${abortReason()}` };
  }

  const key = loadApiKey();
  if (key === null) {
    return {
      source: "fallback",
      count: 1,
      reason: "no TypeSafe credential (set TYPESAFE_API_KEY or DSH_TYPESAFE_ENV_FILE)",
    };
  }

  let client;
  let choice;
  try {
    if (clientFactory) {
      const built = await clientFactory(key);
      client = built.client ?? built;
      choice = built.choice;
      if (typeof choice !== "function") throw new Error("clientFactory returned no choice builder");
    } else {
      const sdk = await import("@typesafe-ai/sdk");
      choice = sdk.choice;
      client = new sdk.TypeSafeClient({
        apiKey: key,
        logLevel: "off",
        timeout: TYPESAFE_TIMEOUT_MS,
        // One narrow judgment: the workflow deadline owns retrying, so hidden
        // SDK retries would only multiply the wait.
        retry: { maxRetries: 0 },
      });
    }
  } catch (error) {
    const descriptor = describeFailure("client_init", error);
    return {
      source: "fallback",
      count: 1,
      reason: describeFailureText(descriptor, "TypeSafe client init failed"),
    };
  }

  if (callerAborted()) {
    return { source: "fallback", count: 1, reason: `TypeSafe judgment skipped: ${abortReason()}` };
  }

  const criteria = {};
  options.forEach((batch, index) => {
    criteria[String(batch.length)] = describeBatch(batch, index);
  });

  // The per-call timeout is composed with the caller's signal so that either
  // the HTTP budget or a parent cancel/deadline ends the judgment.
  const timeoutSignal = AbortSignal.timeout(TYPESAFE_TIMEOUT_MS);
  const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

  try {
    const response = await client.systemOne(
      {
        state,
        questions: {
          concurrency: choice(
            "How many of these independent coding tasks should start running in parallel right now? " +
              "More parallelism finishes sooner but uses more resources; choose fewer when tasks look large, " +
              "risky, or likely to contend for resources even though their declared paths do not overlap.",
            criteria,
          ),
        },
      },
      { signal: requestSignal },
    );
    const answer = response?.answers?.concurrency;
    const chosen = Number(answer?.choice);
    if (!Number.isInteger(chosen) || chosen < 1 || chosen > options.length) {
      // An out-of-range or non-numeric label is a model error. Code refuses it
      // rather than clamping to a value the model did not actually choose, and
      // the raw label is never echoed because it is model output of unknown
      // provenance.
      return {
        source: "fallback",
        count: 1,
        reason: "TypeSafe returned a choice outside the offered range",
        model: typeof response?.model === "string" ? response.model : null,
      };
    }
    return {
      source: "typesafe",
      count: chosen,
      // Confidence is reported for the record; it is never treated as accuracy.
      confidence: typeof answer?.confidence === "number" ? answer.confidence : null,
      model: typeof response?.model === "string" ? response.model : null,
      usage: response?.usage ?? null,
    };
  } catch (error) {
    const descriptor = describeFailure("call", error);
    const text = describeFailureText(descriptor, "TypeSafe call failed");
    log(text);
    return { source: "fallback", count: 1, reason: text };
  }
}

/** Compact, model-facing description of one candidate batch. */
function describeBatch(batch, index) {
  const writes = [...new Set(batch.flatMap((task) => task.write_paths))];
  const reads = [...new Set(batch.flatMap((task) => task.read_paths))];
  return (
    `Start ${batch.length} task(s) now: ${batch.map((task) => task.id).join(", ")}. ` +
    `Option ${index + 1} of ${index + 1} by size. ` +
    `Declared writes: ${writes.length > 0 ? writes.join(", ") : "none"}. ` +
    `Declared reads: ${reads.slice(0, 12).join(", ")}${reads.length > 12 ? ", ..." : ""}. ` +
    `These tasks have no overlapping paths in code-verified declarations.`
  );
}
