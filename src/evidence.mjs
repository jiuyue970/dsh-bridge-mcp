/**
 * Structured worker evidence.
 *
 * Exit code 0 alone proves nothing: a worker can exit cleanly having done
 * nothing, or having done the wrong thing. Each worker is therefore required to
 * end with a JSON report, and only a well-formed report claiming `success`
 * releases the tasks that depend on it.
 *
 * This module parses and grades that report. It never calls a model.
 */

const OUTCOMES = new Set(["success", "failed", "blocked"]);

/** Pull the last JSON object out of a worker's final answer. */
function lastJsonObject(text) {
  // Fast path: the whole answer is JSON.
  const whole = text.trim();
  if (whole.startsWith("{")) {
    try {
      return JSON.parse(whole);
    } catch {
      // Fall through to scanning for an embedded object.
    }
  }
  // Workers sometimes narrate before the report. Scan for balanced objects and
  // take the last one that parses, which is the report by convention.
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  const candidates = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(candidates[index]);
    } catch {
      // Keep looking at earlier candidates.
    }
  }
  return null;
}

function normaliseChecks(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => ({
      command: typeof entry.command === "string" ? entry.command : null,
      exit_code: Number.isInteger(entry.exit_code) ? entry.exit_code : null,
      // Anything else the worker attached (duration, stdout tail) is preserved
      // as-is; the aggregator does not interpret it.
      detail: Object.fromEntries(
        Object.entries(entry).filter(([key]) => !["command", "exit_code"].includes(key)),
      ),
    }));
}

function normaliseStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string" && entry.trim() !== "");
}

/**
 * Parse a worker's final answer into graded evidence.
 *
 * Returns `{ ok, outcome, report, reason, raw }`. `ok` is true only when a
 * valid report claims `success`. Everything else — unparseable output, a
 * missing report, or an explicit failure — is not a pass.
 */
export function parseEvidence(answer) {
  const text = String(answer ?? "");
  const parsed = lastJsonObject(text);
  const raw = text.length > 2_000 ? `${text.slice(0, 2_000)}...` : text;

  if (parsed === null) {
    return {
      ok: false,
      outcome: "unknown",
      report: null,
      reason: "worker produced no parseable evidence report",
      raw,
    };
  }
  const outcome = parsed.outcome;
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) {
    return {
      ok: false,
      outcome: "unknown",
      report: null,
      reason: `evidence report has no valid outcome (got ${JSON.stringify(outcome)})`,
      raw,
    };
  }
  const report = {
    outcome,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    changed_files: normaliseStrings(parsed.changed_files),
    checks: normaliseChecks(parsed.checks),
    artifacts: normaliseStrings(parsed.artifacts),
    issues: normaliseStrings(parsed.issues),
  };
  if (outcome !== "success") {
    return {
      ok: false,
      outcome,
      report,
      reason: `worker reported ${outcome}`,
      raw,
    };
  }
  return { ok: true, outcome, report, reason: null, raw };
}

/**
 * Grade one finished worker job.
 *
 * Both conditions must hold: the process exited 0 and the report claims
 * success. A worker that exited 0 with no report is not a pass, and neither is
 * a success report from a worker that crashed.
 */
export function gradeJob(job, { answer, status }) {
  const exitCode = job?.exit_code ?? null;
  const exitedZero = exitCode === 0 && status === "done";
  const evidence = parseEvidence(answer);
  if (!exitedZero && evidence.outcome !== "success") {
    return {
      ok: false,
      outcome: evidence.outcome === "unknown" ? "failed" : evidence.outcome,
      report: evidence.report,
      reason: status !== "done" ? `worker ended as ${status}` : `worker exited with code ${exitCode}`,
      raw: evidence.raw,
      exit_code: exitCode,
    };
  }
  if (!exitedZero) {
    return {
      ok: false,
      outcome: "failed",
      report: evidence.report,
      reason: status !== "done" ? `worker ended as ${status}` : `worker exited with code ${exitCode}`,
      raw: evidence.raw,
      exit_code: exitCode,
    };
  }
  return { ...evidence, exit_code: exitCode };
}

/** The prompt fragment that pins the required report shape. */
export const EVIDENCE_CONTRACT =
  "Your final message must be a single JSON object and nothing else, with exactly these keys: " +
  '{"outcome":"success"|"failed"|"blocked","summary":"one or two sentences",' +
  '"changed_files":["relative/path"],"checks":[{"command":"the exact command you ran",' +
  '"exit_code":0}],"artifacts":["relative/path or none"],"issues":["anything unresolved"]}. ' +
  "Use outcome=success only when the task is genuinely complete and you verified it. " +
  "An exit code of 0 on one command is not completion. " +
  "If you could not finish, use failed or blocked and explain in issues.";
