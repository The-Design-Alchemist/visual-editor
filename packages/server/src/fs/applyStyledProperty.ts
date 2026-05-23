import * as fs from "node:fs/promises";
import { createPatch } from "diff";
import {
  detectStyledComponent,
  mutateStyledProperty,
} from "../css/styledComponents.ts";
import { resolveWithinWorkspace } from "./resolveSafe.ts";

export type ApplyStyledPropertyInput = {
  /** Workspace-relative JSX file containing both the JSX element AND the styled definition. */
  file: string;
  line: number;
  col: number;
  property: string;
  value: string;
};

export type ApplyStyledPropertyRefusalReason =
  | "invalid-input"
  | "path-outside-workspace"
  | "file-not-found"
  | "read-failed"
  | "write-failed"
  | "no-jsx-at-location"
  | "not-a-styled-component"
  | "styled-with-interpolation"
  | "styled-extension-not-supported"
  | "styled-attrs-not-supported"
  | "cross-file-styled-not-supported"
  | "component-not-found"
  | "parse-error"
  | "css-parse-error"
  | "invalid-property";

export type ApplyStyledPropertyOutcome =
  | {
      ok: true;
      diff: string;
      componentName: string;
      previousValue: string | null;
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 500;
      reason: ApplyStyledPropertyRefusalReason;
      details: string;
    };

export async function applyStyledProperty(
  input: ApplyStyledPropertyInput,
  options: { workspaceRoot: string; dryRun: boolean },
): Promise<ApplyStyledPropertyOutcome> {
  if (!isValid(input)) {
    return {
      ok: false,
      status: 400,
      reason: "invalid-input",
      details:
        "Body must be { file: string, line: number, col: number, property: string, value: string }",
    };
  }

  const absPath = resolveWithinWorkspace(options.workspaceRoot, input.file);
  if (!absPath) {
    return {
      ok: false,
      status: 403,
      reason: "path-outside-workspace",
      details: `File outside workspace: ${input.file}`,
    };
  }

  let source: string;
  try {
    source = await fs.readFile(absPath, "utf8");
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
      details: `Read failed: ${e.message}`,
    };
  }

  const detect = detectStyledComponent(source, input.line, input.col);
  if (!detect.ok) {
    return {
      ok: false,
      status: 400,
      reason: detect.reason,
      details: detect.details,
    };
  }

  const mutation = mutateStyledProperty(
    source,
    detect.ref.componentName,
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

  const diff = createPatch(input.file, source, mutation.output, "before", "after");

  if (!options.dryRun) {
    try {
      await fs.writeFile(absPath, mutation.output, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return {
        ok: false,
        status: 500,
        reason: "write-failed",
        details: `Write failed: ${e.message}`,
      };
    }
  }

  return {
    ok: true,
    diff,
    componentName: detect.ref.componentName,
    previousValue: mutation.previousValue,
  };
}

function isValid(x: unknown): x is ApplyStyledPropertyInput {
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
