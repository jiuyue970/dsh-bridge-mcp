#!/usr/bin/env node
/**
 * Codex UserPromptSubmit hook: suggest a fresh session when a long session
 * receives a request for unrelated work.
 *
 * Every request re-sends the whole conversation, so a session that keeps
 * accepting new, unrelated work pays for all of the earlier work on every
 * turn. Measured on 2026-09-22: context climbs from about 31k tokens at the
 * first request to about 145k past the fiftieth, and eight sessions over 300
 * requests accounted for 87% of usage. Size-based auto-compaction cuts wherever
 * the size happens to cross its limit, often mid-task; the cleanest cut is at
 * a task boundary, which only a judgment about meaning can find.
 *
 * This hook only suggests. It cannot start a session: /new is the user's.
 * It stays quiet unless the session is already expensive, the judgment is
 * clear, and it has not suggested recently — a reminder that fires on every
 * follow-up teaches people to ignore it.
 *
 * It fails open. Any error, timeout, missing key, or malformed input ends with
 * no output and exit code 0, so the user's message is never delayed or blocked
 * by this hook's own problems.
 *
 * Privacy: when it does ask, it sends TypeSafe the new request and the last few
 * requests of this session, each truncated. Nothing else from the conversation
 * leaves the machine.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LIMITS = {
  /** Below this, a fresh session saves too little to be worth an interruption. */
  MIN_CONTEXT_TOKENS: 100_000,
  /** The judgment needs a baseline of what this session has been doing. */
  MIN_PRIOR_PROMPTS: 2,
  /** After a suggestion, stay quiet for this many prompts in the session. */
  COOLDOWN_PROMPTS: 8,
  /** Only suggest when the judgment is clearly "new task". */
  MIN_CONFIDENCE: 0.8,
  /** Prior requests given to the judgment as context. */
  RECENT_PROMPTS: 4,
  /** Characters kept from each request sent to the judgment. */
  PROMPT_CHARS: 400,
  /** Bytes read from the end of the transcript to find the last context size. */
  TAIL_BYTES: 512 * 1024,
  /** Budget for the whole judgment; the hook's own timeout is longer. */
  JUDGE_TIMEOUT_MS: 4_000,
  /** State files for sessions untouched this long are removed. */
  STATE_MAX_AGE_MS: 14 * 24 * 60 * 60 * 1000,
};

const QUESTION =
  "The user of a coding assistant just sent a new request in an existing conversation. " +
  "Is it a continuation of the recent work, or the start of a separate task? " +
  "Follow-ups, fixes, checks, retries, refinements, and questions about the same work are continuations, " +
  "even when brief or vague, such as asking to check the logs again. " +
  "Choose new_task only when the request clearly moves to a different objective that does not depend on the recent work.";

const CRITERIA = {
  continue: "Continues, follows up on, verifies, fixes, refines, or asks about the same work as the recent requests.",
  new_task: "Starts a different, unrelated objective that does not build on the recent requests.",
};

export function defaultStateDir() {
  return process.env.SESSION_BOUNDARY_STATE_DIR?.trim() || join(homedir(), ".codex", "session-boundary");
}

/**
 * Context size of the most recent request, from the transcript's tail.
 *
 * Transcripts of long sessions run to many megabytes, so only the tail is
 * read. The last `token_count` event carries the input size of the latest
 * request, which is exactly the per-turn cost a fresh session would reset.
 */
export function lastContextTokens(transcriptPath, tailBytes = LIMITS.TAIL_BYTES) {
  if (typeof transcriptPath !== "string" || transcriptPath === "") return null;
  let fd;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, tailBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line.includes('"token_count"')) continue;
      try {
        const event = JSON.parse(line);
        const usage = event?.payload?.info?.last_token_usage;
        if (event?.payload?.type === "token_count" && Number.isFinite(usage?.input_tokens)) {
          return usage.input_tokens;
        }
      } catch {
        // The first line of the tail may be cut mid-record; keep scanning.
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sessionKey(input) {
  const raw = input.session_id ?? (input.transcript_path ? basename(input.transcript_path) : "unknown");
  return String(raw).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

function loadState(dir, key) {
  try {
    const state = JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8"));
    if (Array.isArray(state.prompts) && Number.isInteger(state.count)) return state;
  } catch {
    // A missing or damaged state file just means a fresh start for this session.
  }
  return { prompts: [], count: 0, lastSuggestedAt: null };
}

function saveState(dir, key, state, now) {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(state));
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      try {
        if (now - statSync(path).mtimeMs > LIMITS.STATE_MAX_AGE_MS) rmSync(path);
      } catch {
        // Another hook run may have removed it first.
      }
    }
  } catch {
    // State is a convenience: losing it only resets the cooldown and history.
  }
}

const clip = (text) => String(text ?? "").trim().slice(0, LIMITS.PROMPT_CHARS);

/**
 * Decide whether to suggest a fresh session for this prompt.
 *
 * Returns the hook output object, or null for silence. The cheap checks run
 * first so the judgment — a network call — is only made when a suggestion is
 * actually possible.
 */
export async function evaluate(input, deps) {
  const { judge, stateDir = defaultStateDir(), now = Date.now(), contextTokens = lastContextTokens } = deps;
  const prompt = clip(input?.prompt);
  if (prompt === "") return { output: null, reason: "empty prompt" };

  const key = sessionKey(input);
  const state = loadState(stateDir, key);
  const prior = state.prompts.slice(-LIMITS.RECENT_PROMPTS);

  const record = (result) => {
    state.prompts = [...state.prompts, prompt].slice(-LIMITS.RECENT_PROMPTS);
    state.count += 1;
    if (result.output !== null) state.lastSuggestedAt = state.count;
    saveState(stateDir, key, state, now);
    return result;
  };

  if (prior.length < LIMITS.MIN_PRIOR_PROMPTS) return record({ output: null, reason: "not enough history" });

  const tokens = contextTokens(input.transcript_path);
  if (!Number.isFinite(tokens) || tokens < LIMITS.MIN_CONTEXT_TOKENS) {
    return record({ output: null, reason: "session not long enough", tokens });
  }
  if (state.lastSuggestedAt !== null && state.count + 1 - state.lastSuggestedAt <= LIMITS.COOLDOWN_PROMPTS) {
    return record({ output: null, reason: "cooling down", tokens });
  }

  let verdict = null;
  try {
    verdict = await judge({ recent: prior, prompt, timeoutMs: LIMITS.JUDGE_TIMEOUT_MS });
  } catch {
    verdict = null;
  }
  if (verdict === null || verdict === undefined) return record({ output: null, reason: "no judgment", tokens });
  if (verdict.choice !== "new_task") return record({ output: null, reason: "continuation", tokens, verdict });
  if (!(Number(verdict.confidence) >= LIMITS.MIN_CONFIDENCE)) {
    return record({ output: null, reason: "not confident", tokens, verdict });
  }

  const wan = Math.round(tokens / 10_000);
  return record({
    output: {
      systemMessage:
        `这条消息看起来是一件新的事，而当前会话已经较长（上一轮约 ${wan} 万 tokens）。` +
        "开新会话（/new）能明显节省额度；如果是在接着做同一件事，忽略即可。",
    },
    reason: "suggested",
    tokens,
    verdict,
  });
}

/** The production judgment: one TypeSafe choice, no retries, bounded time. */
export async function typesafeJudge({ recent, prompt, timeoutMs }) {
  const { loadApiKey } = await import(new URL("../src/choices.mjs", import.meta.url));
  const apiKey = loadApiKey();
  if (apiKey === null) return null;
  const sdk = await import("@typesafe-ai/sdk");
  const client = new sdk.TypeSafeClient({ apiKey, logLevel: "off", timeout: timeoutMs, retry: { maxRetries: 0 } });
  const response = await client.systemOne(
    {
      state: { recent_requests: recent, new_request: prompt },
      questions: { boundary: sdk.choice(QUESTION, CRITERIA) },
    },
    { signal: AbortSignal.timeout(timeoutMs) },
  );
  const answer = response?.answers?.boundary;
  if (answer === undefined || answer === null) return null;
  return { choice: answer.choice, confidence: answer.confidence };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  try {
    const input = JSON.parse(await readStdin());
    const { output } = await evaluate(input, { judge: typesafeJudge });
    if (output !== null) process.stdout.write(JSON.stringify(output));
  } catch {
    // Fail open: never block or delay the user's message over the hook's own error.
  }
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
