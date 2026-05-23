import { applyToFile } from "./applyToFile.ts";
import type { ApplyOutcome, ApplyOptions } from "./applyToFile.ts";
import type { RecentApplies } from "../state/recentApplies.ts";

export type RevertInput = {
  /** Optional — when omitted, the most-recent apply is reverted. */
  file?: string;
  line?: number;
  col?: number;
};

export type RevertOutcome =
  | ApplyOutcome // delegates to applyToFile when an entry was found
  | {
      ok: false;
      status: 404;
      reason: "no-recent-apply";
      details: string;
    }
  | {
      ok: false;
      status: 400;
      reason: "invalid-input";
      details: string;
    };

/**
 * Revert a recent apply by swapping `before` and `after` and re-running
 * the deterministic mutation through `applyToFile`. The conflict path
 * (file edited externally between Apply and Revert) is the same as
 * /apply — returns 409 with `token-not-found` if the "after" token no
 * longer sits at line:col.
 *
 * On success, removes the entry from the buffer so re-reverting is not
 * an infinite loop. The user can re-apply by re-driving the gesture.
 */
export async function revertToFile(
  input: RevertInput,
  options: ApplyOptions,
  recent: RecentApplies,
): Promise<RevertOutcome> {
  // Validate the partial-key shape: either all three of file/line/col, or
  // none (revert most-recent).
  const partial =
    input.file !== undefined ||
    input.line !== undefined ||
    input.col !== undefined;
  const complete =
    typeof input.file === "string" &&
    typeof input.line === "number" &&
    typeof input.col === "number" &&
    Number.isInteger(input.line) &&
    Number.isInteger(input.col);
  if (partial && !complete) {
    return {
      ok: false,
      status: 400,
      reason: "invalid-input",
      details:
        "Either pass all of {file, line, col} or omit them to revert the most-recent apply.",
    };
  }

  const key =
    complete &&
    typeof input.file === "string" &&
    typeof input.line === "number" &&
    typeof input.col === "number"
      ? { file: input.file, line: input.line, col: input.col }
      : undefined;
  const entry = recent.find(key);
  if (!entry) {
    return {
      ok: false,
      status: 404,
      reason: "no-recent-apply",
      details: key
        ? `No recent apply found at ${key.file}:${key.line}:${key.col}`
        : "No recent applies to revert",
    };
  }

  const outcome = await applyToFile(
    {
      file: entry.file,
      line: entry.line,
      col: entry.col,
      before: entry.after, // swap
      after: entry.before,
    },
    options,
  );

  if (outcome.ok) {
    // Don't leave the entry in the buffer — that'd make repeated reverts
    // loop A→B, B→A, A→B forever.
    recent.remove(entry);
  }

  return outcome;
}
