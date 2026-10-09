import * as fs from "node:fs/promises";
import { parseSource, walk, describeJsxName } from "../transform/stamp.ts";
import { KNOWN_MERGERS } from "../ast/className.ts";
import { resolveWithinWorkspace } from "../fs/resolveSafe.ts";
import type { ClassNameInfo, ElementContext, SourceRef } from "./types.ts";

type Node = {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start: { line: number; column: number } } | null;
  [key: string]: unknown;
};

const SNIPPET_MAX_LINES = 40;
const SNIPPET_MAX_CHARS = 2400;

function clipSnippet(text: string): { snippet: string; truncated: boolean } {
  const lines = text.split("\n");
  let out = text;
  let truncated = false;
  if (lines.length > SNIPPET_MAX_LINES) {
    out = lines.slice(0, SNIPPET_MAX_LINES).join("\n");
    truncated = true;
  }
  if (out.length > SNIPPET_MAX_CHARS) {
    out = out.slice(0, SNIPPET_MAX_CHARS);
    truncated = true;
  }
  return { snippet: truncated ? `${out}\n…` : out, truncated };
}

function nameOf(n: Node | undefined): string | null {
  if (!n) return null;
  if (n.type === "Identifier") return String(n.name);
  return null;
}

/**
 * Walk outward from the element to the function that renders it:
 *   function Card() {}            → "Card"
 *   const Card = () => {}         → "Card"
 *   const Card = memo(() => {})   → "Card"   (climbs through wrapper calls)
 *   export default function () {} → "default"
 *   items.map((x) => <li/>)       → keeps climbing to the real component
 */
export function enclosingComponentName(parents: Node[]): string | null {
  for (let i = parents.length - 1; i >= 0; i--) {
    const n = parents[i]!;
    if (n.type === "FunctionDeclaration" || n.type === "ClassDeclaration") {
      const name = nameOf(n.id as Node | undefined);
      if (name) return name;
      const parent = parents[i - 1];
      return parent?.type === "ExportDefaultDeclaration" ? "default" : null;
    }
    if (n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression") {
      let j = i - 1;
      while (j >= 0 && parents[j]!.type === "CallExpression") j--;
      const owner = parents[j];
      if (owner?.type === "VariableDeclarator") {
        const name = nameOf(owner.id as Node | undefined);
        if (name) return name;
      }
      if (owner?.type === "ExportDefaultDeclaration") return "default";
      // Inline callback (e.g. inside .map) — keep climbing.
    }
  }
  return null;
}

function classNameInfo(attrs: Node[], source: string): ClassNameInfo {
  const attr = attrs.find(
    (a) =>
      a.type === "JSXAttribute" &&
      (a.name as Node | undefined)?.type === "JSXIdentifier" &&
      (a.name as Node).name === "className",
  );
  if (!attr) {
    return { kind: "none", spread: attrs.some((a) => a.type === "JSXSpreadAttribute") };
  }
  const value = attr.value as Node | undefined;
  if (!value) return { kind: "none", spread: false };
  const raw = source.slice(value.start ?? 0, value.end ?? 0);
  const tokensOf = (v: unknown) =>
    String(v ?? "")
      .split(/\s+/)
      .filter(Boolean);

  if (value.type === "StringLiteral" || value.type === "Literal") {
    return { kind: "static", tokens: tokensOf(value.value), raw };
  }
  if (value.type !== "JSXExpressionContainer") return { kind: "dynamic", raw };
  const expr = value.expression as Node | undefined;
  if (!expr) return { kind: "dynamic", raw };
  if (expr.type === "StringLiteral" || expr.type === "Literal") {
    return { kind: "static", tokens: tokensOf(expr.value), raw };
  }
  if (expr.type === "TemplateLiteral") return { kind: "template", raw };
  if (expr.type === "ConditionalExpression") return { kind: "conditional", raw };
  if (expr.type === "CallExpression") {
    const callee = expr.callee as Node | undefined;
    const calleeName =
      callee?.type === "Identifier"
        ? String(callee.name)
        : callee?.type === "MemberExpression"
          ? String((callee.property as Node | undefined)?.name ?? "")
          : "";
    if (!KNOWN_MERGERS.has(calleeName)) return { kind: "dynamic", raw };
    const args = (expr.arguments as Node[] | undefined) ?? [];
    const tokens: string[] = [];
    let dynamicArgs = 0;
    for (const a of args) {
      if (a.type === "StringLiteral" || a.type === "Literal") tokens.push(...tokensOf(a.value));
      else dynamicArgs++;
    }
    return { kind: "merger", callee: calleeName, tokens, dynamicArgs, raw };
  }
  return { kind: "dynamic", raw };
}

function editability(info: ClassNameInfo | null): { editable: boolean; reason?: string } {
  if (!info) return { editable: false, reason: "No element found at this location." };
  switch (info.kind) {
    case "static":
      return { editable: true };
    case "merger":
      return info.dynamicArgs === 0
        ? { editable: true }
        : {
            editable: false,
            reason: `className is ${info.callee}(...) with ${info.dynamicArgs} non-static argument(s); the writer refuses because it can't prove which token paints.`,
          };
    case "template":
      return { editable: false, reason: "className is a template literal." };
    case "conditional":
      return { editable: false, reason: "className is a conditional expression." };
    case "dynamic":
      return { editable: false, reason: "className is a dynamic expression the writer doesn't analyze." };
    case "none":
      return {
        editable: false,
        reason: info.spread
          ? "No className attribute here; props are spread in — the token probably lives at the call site."
          : "No className attribute on this element.",
      };
  }
}

export function notFound(ref: SourceRef, role: "host" | "call", reason: string): ElementContext {
  return {
    ref,
    role,
    found: false,
    tag: null,
    componentName: null,
    className: null,
    attributes: [],
    snippet: "",
    snippetTruncated: false,
    editable: false,
    reason,
  };
}

export function describeElementInSource(
  source: string,
  ref: SourceRef,
  role: "host" | "call",
): ElementContext {
  const { ast, error } = parseSource(source);
  if (!ast) return notFound(ref, role, `parse error: ${error}`);
  let result: ElementContext | null = null;
  walk(ast as unknown as Node, (node, parents) => {
    if (result || node.type !== "JSXOpeningElement") return;
    const loc = node.loc;
    if (!loc || loc.start.line !== ref.line || loc.start.column !== ref.col) return;
    const nameInfo = describeJsxName(node.name as Node | undefined);
    const element = parents[parents.length - 1] as Node | undefined;
    const text =
      element && typeof element.start === "number" && typeof element.end === "number"
        ? source.slice(element.start, element.end)
        : source.slice(node.start ?? 0, node.end ?? 0);
    const { snippet, truncated } = clipSnippet(text);
    const attrs = ((node.attributes as Node[] | undefined) ?? []) as Node[];
    const className = classNameInfo(attrs, source);
    const { editable, reason } = editability(className);
    result = {
      ref,
      role,
      found: true,
      tag: nameInfo?.display ?? null,
      componentName: enclosingComponentName(parents as Node[]),
      className,
      attributes: attrs.map((a) =>
        a.type === "JSXSpreadAttribute"
          ? "{...}"
          : String(((a.name as Node | undefined)?.name as string | undefined) ?? "?"),
      ),
      snippet,
      snippetTruncated: truncated,
      editable,
      ...(reason ? { reason } : {}),
    };
  });
  return result ?? notFound(ref, role, `No JSX element at ${ref.line}:${ref.col}`);
}

export async function describeElementFile(
  workspaceRoot: string,
  ref: SourceRef,
  role: "host" | "call",
): Promise<ElementContext> {
  const abs = resolveWithinWorkspace(workspaceRoot, ref.file);
  if (!abs) return notFound(ref, role, "Path is outside the workspace root.");
  let source: string;
  try {
    source = await fs.readFile(abs, "utf8");
  } catch (err) {
    return notFound(ref, role, `Could not read ${ref.file}: ${(err as Error).message}`);
  }
  return describeElementInSource(source, ref, role);
}
