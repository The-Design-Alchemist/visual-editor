import * as fs from "node:fs/promises";
import { createPatch } from "diff";
import {
  mutateClassName,
  mutateAttribute,
} from "../ast/className.ts";
import type {
  MutateClassNameRefusalReason,
  MutateAttributeRefusalReason,
} from "../ast/className.ts";
import { resolveWithinWorkspace } from "./resolveSafe.ts";

export type ApplyInput = {
  /** Path relative to the configured workspace root (the same root the Babel data-oid plugin used). */
  file: string;
  /** 1-based line number, as Babel reports in `loc.start.line`. */
  line: number;
  /** 0-based column number, as Babel reports in `loc.start.column`. */
  col: number;
  /** Attribute to mutate. Default "className" — token-swap semantics. Anything else uses whole-value swap (src, href, alt, …). */
  attribute?: string;
  /** Exact static class token to swap, e.g. "p-4". For non-className attributes, this is the whole expected current value (or null to skip conflict check). */
  before: string | null;
  /** Replacement, e.g. "p-6". For non-className attributes, this is the whole new value. */
  after: string;
};

export type ApplyOutcome =
  | {
      ok: true;
      /** Unified diff between original and rewritten source. */
      diff: string;
      /** Absolute path that was written, for logging. */
      absolutePath: string;
      /** For non-className mutations called with before=null, the actual pre-mutation value. Undo uses this. */
      previousValue?: string;
    }
  | {
      ok: false;
      /** HTTP-shaped status (the http layer maps this 1:1). */
      status: 400 | 403 | 404 | 409 | 500;
      reason: ApplyRefusalReason;
      details: string;
    };

export type ApplyRefusalReason =
  | "invalid-input"
  | "path-outside-workspace"
  | "file-not-found"
  | "read-failed"
  | "write-failed"
  | MutateClassNameRefusalReason
  | MutateAttributeRefusalReason;

export type ApplyOptions = {
  workspaceRoot: string;
  /**
   * If `true`, mutate in memory and return the diff but do NOT write to disk.
   * /propose uses this; /apply doesn't.
   */
  dryRun: boolean;
};

/**
 * The single entry point for both /apply and /propose. Reads, mutates,
 * conflict-checks (the mutate step's `token-not-found` IS the conflict
 * signal — if the file moved out from under us, the `before` token won't
 * be there anymore), then either writes or skips the write.
 *
 * Returning `ApplyOutcome` instead of throwing keeps the HTTP layer
 * mechanical: every refusal carries its own status code and reason.
 */
export async function applyToFile(
  input: ApplyInput,
  options: ApplyOptions,
): Promise<ApplyOutcome> {
  if (!isValidApplyInput(input)) {
    return {
      ok: false,
      status: 400,
      reason: "invalid-input",
      details:
        "Body must be { file: string, line: number, col: number, before: string, after: string }",
    };
  }

  const absolutePath = resolveWithinWorkspace(options.workspaceRoot, input.file);
  if (!absolutePath) {
    return {
      ok: false,
      status: 403,
      reason: "path-outside-workspace",
      details: `Refusing to touch path outside workspace root: ${input.file}`,
    };
  }

  let source: string;
  try {
    source = await fs.readFile(absolutePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return {
        ok: false,
        status: 404,
        reason: "file-not-found",
        details: `File not found: ${input.file}`,
      };
    }
    return {
      ok: false,
      status: 500,
      reason: "read-failed",
      details: `Failed to read ${input.file}: ${e.message}`,
    };
  }

  const attribute = input.attribute ?? "className";
  const mutation =
    attribute === "className"
      ? mutateClassName({
          source,
          line: input.line,
          col: input.col,
          // mutateClassName requires before; reject if it's null
          before: input.before ?? "",
          after: input.after,
        })
      : mutateAttribute({
          source,
          line: input.line,
          col: input.col,
          attribute,
          before: input.before,
          after: input.after,
        });

  if (!mutation.ok) {
    // `token-not-found` is the conflict signal: the source no longer has
    // the `before` token at (line, col), most likely because the user
    // edited the file in their IDE between staging the change and applying
    // it. Map that to 409. Everything else is a "you sent us a bad
    // request" 400.
    const status = mutation.reason === "token-not-found" ? 409 : 400;
    return {
      ok: false,
      status,
      reason: mutation.reason,
      details: mutation.details,
    };
  }

  const diff = createPatch(input.file, source, mutation.output, "before", "after");

  if (!options.dryRun) {
    try {
      await fs.writeFile(absolutePath, mutation.output, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return {
        ok: false,
        status: 500,
        reason: "write-failed",
        details: `Failed to write ${input.file}: ${e.message}`,
      };
    }
  }

  // mutateAttribute reports the actual previous value (useful when caller
  // passed before=null). mutateClassName always knows `before` so we just
  // echo input.before for it.
  const previousValue =
    "previousValue" in mutation && typeof mutation.previousValue === "string"
      ? mutation.previousValue
      : (input.before ?? undefined);
  return { ok: true, diff, absolutePath, previousValue };
}

function isValidApplyInput(x: unknown): x is ApplyInput {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.file === "string" &&
    typeof o.line === "number" &&
    typeof o.col === "number" &&
    (typeof o.before === "string" || o.before === null) &&
    typeof o.after === "string" &&
    (o.attribute === undefined || typeof o.attribute === "string") &&
    Number.isInteger(o.line) &&
    Number.isInteger(o.col) &&
    o.line > 0 &&
    o.col >= 0
  );
}
