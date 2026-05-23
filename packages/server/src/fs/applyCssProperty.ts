import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createPatch } from "diff";
import { detectCssModule, mutateCssProperty } from "../css/cssModule.ts";
import { resolveWithinWorkspace } from "./resolveSafe.ts";

export type ApplyCssPropertyInput = {
  /** JSX file containing the JSXOpeningElement we resolve from. Workspace-relative. */
  file: string;
  /** 1-based line of the JSXOpeningElement. */
  line: number;
  /** 0-based column of the JSXOpeningElement. */
  col: number;
  /** CSS property to set, e.g. "padding". */
  property: string;
  /** New value, e.g. "1.5rem". */
  value: string;
};

export type ApplyCssPropertyRefusalReason =
  | "invalid-input"
  | "path-outside-workspace"
  | "jsx-file-not-found"
  | "css-file-not-found"
  | "read-failed"
  | "write-failed"
  | "no-jsx-at-location"
  | "no-classname-attribute"
  | "dynamic-classname"
  | "not-a-css-module"
  | "unresolved-import"
  | "parse-error"
  | "css-parse-error"
  | "selector-not-found"
  | "composes-chain"
  | "invalid-property";

export type ApplyCssPropertyOutcome =
  | {
      ok: true;
      diff: string;
      cssAbsolutePath: string;
      selector: string;
      previousValue: string | null;
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 500;
      reason: ApplyCssPropertyRefusalReason;
      details: string;
    };

export async function applyCssProperty(
  input: ApplyCssPropertyInput,
  options: { workspaceRoot: string; dryRun: boolean },
): Promise<ApplyCssPropertyOutcome> {
  if (!isValid(input)) {
    return {
      ok: false,
      status: 400,
      reason: "invalid-input",
      details:
        "Body must be { file: string, line: number, col: number, property: string, value: string }",
    };
  }

  const jsxAbs = resolveWithinWorkspace(options.workspaceRoot, input.file);
  if (!jsxAbs) {
    return {
      ok: false,
      status: 403,
      reason: "path-outside-workspace",
      details: `JSX file outside workspace: ${input.file}`,
    };
  }

  let jsxSource: string;
  try {
    jsxSource = await fs.readFile(jsxAbs, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return {
        ok: false,
        status: 404,
        reason: "jsx-file-not-found",
        details: `JSX file not found: ${input.file}`,
      };
    }
    return {
      ok: false,
      status: 500,
      reason: "read-failed",
      details: `Read JSX failed: ${e.message}`,
    };
  }

  const detect = detectCssModule(jsxSource, input.line, input.col);
  if (!detect.ok) {
    return {
      ok: false,
      status: 400,
      reason: detect.reason,
      details: detect.details,
    };
  }

  // Resolve the CSS file path relative to the JSX file's dir, then
  // re-check workspace containment.
  const cssAbsolutePath = path.resolve(
    path.dirname(jsxAbs),
    detect.ref.cssFile,
  );
  const cssRel = path.relative(options.workspaceRoot, cssAbsolutePath);
  if (cssRel.startsWith("..") || path.isAbsolute(cssRel)) {
    return {
      ok: false,
      status: 403,
      reason: "path-outside-workspace",
      details: `Resolved CSS file outside workspace: ${cssAbsolutePath}`,
    };
  }

  let cssSource: string;
  try {
    cssSource = await fs.readFile(cssAbsolutePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return {
        ok: false,
        status: 404,
        reason: "css-file-not-found",
        details: `CSS file not found: ${cssAbsolutePath}`,
      };
    }
    return {
      ok: false,
      status: 500,
      reason: "read-failed",
      details: `Read CSS failed: ${e.message}`,
    };
  }

  const mutation = mutateCssProperty(
    cssSource,
    detect.ref.selector,
    input.property,
    input.value,
  );
  if (!mutation.ok) {
    return {
      ok: false,
      status: 400,
      reason: mutation.reason,
      details: mutation.details,
    };
  }

  const diff = createPatch(cssRel, cssSource, mutation.output, "before", "after");

  if (!options.dryRun) {
    try {
      await fs.writeFile(cssAbsolutePath, mutation.output, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return {
        ok: false,
        status: 500,
        reason: "write-failed",
        details: `Write CSS failed: ${e.message}`,
      };
    }
  }

  return {
    ok: true,
    diff,
    cssAbsolutePath,
    selector: detect.ref.selector,
    previousValue: mutation.previousValue,
  };
}

function isValid(x: unknown): x is ApplyCssPropertyInput {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.file === "string" &&
    typeof o.line === "number" &&
    typeof o.col === "number" &&
    typeof o.property === "string" &&
    typeof o.value === "string" &&
    Number.isInteger(o.line) &&
    Number.isInteger(o.col) &&
    o.line > 0 &&
    o.col >= 0
  );
}
