import * as recast from "recast";
// `recast/parsers/babel-ts` parses JSX + TypeScript with location info,
// and crucially keeps the formatting-preservation metadata recast needs
// so that `recast.print(ast)` only reformats the parts we actually mutated.
import babelTsParser from "recast/parsers/babel-ts.js";
import { twMerge } from "tailwind-merge";

/**
 * Inputs are intentionally minimal:
 *   - source: the full file contents (we don't read from disk here — that's
 *     a layer up; this function stays pure)
 *   - line/col: the JSXOpeningElement's loc.start, exactly as Babel reports
 *     it (1-based line, 0-based column). The Babel data-oid plugin in
 *     Spike A stamps this same pair into the DOM, so the producer and
 *     consumer agree on the convention.
 *   - before/after: the exact static class tokens (e.g. "p-4" → "p-6").
 *     We do not parse arbitrary Tailwind expressions — that's the snap
 *     engine's job; this function is just the deterministic swap.
 */
export type MutateClassNameInput = {
  source: string;
  line: number;
  col: number;
  before: string;
  after: string;
};

/**
 * The refusal reasons are structured so the consumer (overlay UI, MCP layer)
 * can branch on them: "show user a 'this className is composed by cn()' badge",
 * "open the file at this location", etc. The `details` field is the human
 * sentence; the `reason` is the machine code.
 *
 * v0.1 only accepts a static string literal at the located JSXOpeningElement.
 * Anything dynamic — cn/clsx/twMerge/cva, template literals, conditionals,
 * spreads, or anything we don't recognize — refuses with a clear reason.
 * This is Principle 1's "determinism preconditions" enforced at the writer.
 */
export type MutateClassNameRefusalReason =
  | "dynamic-call-expression" // legacy: kept so v0.1 consumers still see structured reasons
  | "dynamic-template-literal"
  | "dynamic-conditional"
  | "dynamic-other"
  | "dynamic-uncertain-arg" // v0.2: a non-string-literal arg in a known merger
  | "dynamic-spread-arg" // v0.2: ...spread arg in a known merger
  | "dynamic-conflict" // v0.2: tailwind-merge would drop our new token
  | "unknown-merger" // v0.2: call expression that isn't cn/clsx/twMerge/etc.
  | "no-classname-attribute"
  | "no-jsx-at-location"
  | "token-not-found";

// Known classname-merger functions that combine multiple tokens at runtime.
// We only enter the safety-analyzed mutation path for these — everything
// else stays refused with `unknown-merger`.
const KNOWN_MERGERS = new Set([
  "cn",
  "clsx",
  "classnames",
  "twMerge",
  "twJoin",
]);

export type MutateClassNameResult =
  | { ok: true; output: string }
  | {
      ok: false;
      reason: MutateClassNameRefusalReason;
      details: string;
    };

export function mutateClassName(
  input: MutateClassNameInput,
): MutateClassNameResult {
  const { source, line, col, before, after } = input;

  let ast: ReturnType<typeof recast.parse>;
  try {
    ast = recast.parse(source, { parser: babelTsParser });
  } catch (err) {
    return {
      ok: false,
      reason: "dynamic-other",
      details: `parse error: ${(err as Error).message}`,
    };
  }

  // Holder object so TypeScript's control-flow analysis can narrow on
  // `.value` later — TS doesn't see through the visitor closure's
  // assignment to a plain `let`.
  const out: { value: MutateClassNameResult | null; visited: boolean } = {
    value: null,
    visited: false,
  };

  recast.visit(ast, {
    visitJSXOpeningElement(path) {
      const node = path.node;
      const loc = node.loc;
      if (!loc) {
        this.traverse(path);
        return undefined;
      }
      if (loc.start.line !== line || loc.start.column !== col) {
        this.traverse(path);
        return undefined;
      }

      out.visited = true;
      out.value = mutateOnNode(node, before, after);
      // We've found and processed our target. Don't descend further.
      return false;
    },
  });

  if (!out.visited) {
    return {
      ok: false,
      reason: "no-jsx-at-location",
      details: `No JSXOpeningElement found at ${line}:${col}`,
    };
  }

  if (!out.value) {
    return {
      ok: false,
      reason: "dynamic-other",
      details: "Internal: visitor matched but produced no result",
    };
  }

  if (out.value.ok) {
    // recast.print preserves formatting for every node we didn't touch.
    return { ok: true, output: recast.print(ast).code };
  }
  return out.value;
}

type JsxAttributeLike = {
  type: "JSXAttribute" | "JSXSpreadAttribute";
  name?: { type: string; name?: string };
  value?: JsxAttrValue;
};

type JsxAttrValue =
  | { type: "StringLiteral"; value: string; extra?: unknown }
  | { type: "Literal"; value: string; extra?: unknown }
  | { type: "JSXExpressionContainer"; expression: JsxExpr }
  | { type: string };

type JsxExpr =
  | { type: "StringLiteral"; value: string; extra?: unknown }
  | { type: "Literal"; value: string; extra?: unknown }
  | { type: "TemplateLiteral" }
  | {
      type: "CallExpression";
      callee:
        | { type: "Identifier"; name: string }
        | { type: "MemberExpression"; property?: { name?: string } };
    }
  | { type: "ConditionalExpression" }
  | { type: string };

function mutateOnNode(
  node: unknown,
  before: string,
  after: string,
): MutateClassNameResult {
  const open = node as { attributes: JsxAttributeLike[] };

  const attrs = open.attributes ?? [];
  const classNameAttr = attrs.find(
    (a) =>
      a.type === "JSXAttribute" &&
      a.name?.type === "JSXIdentifier" &&
      a.name?.name === "className",
  );

  if (!classNameAttr) {
    return {
      ok: false,
      reason: "no-classname-attribute",
      details:
        "JSX element has no className attribute (possibly composed via {...spread} or passed as a prop)",
    };
  }

  const value = classNameAttr.value;
  if (!value) {
    return {
      ok: false,
      reason: "no-classname-attribute",
      details: "className attribute has no value",
    };
  }

  // className="p-4 ..." — plain StringLiteral
  if (value.type === "StringLiteral" || value.type === "Literal") {
    const lit = value as { value: string; extra?: unknown };
    return swapAndReturn(lit, before, after);
  }

  // className={...}
  if (value.type === "JSXExpressionContainer") {
    const ec = value as { expression: JsxExpr };
    return mutateOnExpression(ec.expression, before, after);
  }

  return {
    ok: false,
    reason: "dynamic-other",
    details: `className uses unsupported value node type: ${value.type}`,
  };
}

function mutateOnExpression(
  expr: JsxExpr,
  before: string,
  after: string,
): MutateClassNameResult {
  if (expr.type === "StringLiteral" || expr.type === "Literal") {
    const lit = expr as { value: string; extra?: unknown };
    return swapAndReturn(lit, before, after);
  }
  if (expr.type === "TemplateLiteral") {
    return {
      ok: false,
      reason: "dynamic-template-literal",
      details:
        "className uses a template literal; v0.1 only mutates static string literals at the source location",
    };
  }
  if (expr.type === "CallExpression") {
    return mutateOnCallExpression(expr as unknown as CallExprLike, before, after);
  }
  if (expr.type === "ConditionalExpression") {
    return {
      ok: false,
      reason: "dynamic-conditional",
      details:
        "className uses a conditional (ternary) expression; v0.1 only mutates static string literals",
    };
  }
  return {
    ok: false,
    reason: "dynamic-other",
    details: `className uses unsupported expression type: ${expr.type}`,
  };
}

function swapAndReturn(
  lit: { value: string; extra?: unknown },
  before: string,
  after: string,
): MutateClassNameResult {
  const swapped = swapToken(lit.value, before, after);
  if (swapped === null) {
    return {
      ok: false,
      reason: "token-not-found",
      details: `Token "${before}" not found in className value "${lit.value}"`,
    };
  }
  lit.value = swapped;
  // Recast preserves the original raw source via `extra.raw`. If we mutate
  // `.value` without clearing `extra`, recast will reprint the *original*
  // string literal unchanged. Clear the `extra` so the new value is used.
  if (lit.extra) lit.extra = undefined;
  return { ok: true, output: "" };
}

// ---------------------------------------------------------------------------
// CallExpression handling (v0.2 — B1)
// ---------------------------------------------------------------------------

type CallExprLike = {
  type: "CallExpression";
  callee:
    | { type: "Identifier"; name: string }
    | {
        type: "MemberExpression";
        property?: { name?: string };
      };
  arguments: Array<{
    type: string;
    value?: string;
    extra?: unknown;
  }>;
};

/**
 * v0.2 entry into a known classname-merger call: cn(...), clsx(...),
 * twMerge(...), classnames(...), twJoin(...). The first cut of the safety
 * analysis is conservative:
 *
 *  1. Find the static StringLiteral arg containing `before`. If none, refuse.
 *  2. If ANY other arg is non-StringLiteral (conditional, identifier, nested
 *     call, spread, object), refuse with a per-shape reason. We don't try
 *     to reason about runtime branches.
 *  3. Build the would-be concatenated className with `before` swapped for
 *     `after`. Run it through tailwind-merge. If `after`'s tokens don't
 *     all survive the merge, another arg silently overrides our mutation
 *     — refuse with `dynamic-conflict`.
 *  4. Otherwise mutate the StringLiteral and let recast.print emit it.
 */
function mutateOnCallExpression(
  call: CallExprLike,
  before: string,
  after: string,
): MutateClassNameResult {
  const calleeName = getCalleeName(call.callee);
  if (!calleeName || !KNOWN_MERGERS.has(calleeName)) {
    return {
      ok: false,
      reason: "unknown-merger",
      details: `className uses ${calleeName ?? "(call)"}(...). v0.2 only mutates inside known classname mergers: ${[...KNOWN_MERGERS].join(", ")}.`,
    };
  }

  const args = call.arguments ?? [];

  let targetIdx = -1;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (
      a &&
      (a.type === "StringLiteral" || a.type === "Literal") &&
      typeof a.value === "string" &&
      tokensFromValue(a.value).includes(before)
    ) {
      targetIdx = i;
      break;
    }
  }
  if (targetIdx === -1) {
    return {
      ok: false,
      reason: "token-not-found",
      details: `Token "${before}" not present in any static string argument of ${calleeName}(...)`,
    };
  }

  // Reject anything non-static in the OTHER args. The whole point of B1
  // is to mutate ONLY when we can prove the result by static analysis.
  for (let i = 0; i < args.length; i++) {
    if (i === targetIdx) continue;
    const a = args[i];
    if (!a) continue;
    if (a.type === "StringLiteral" || a.type === "Literal") continue;
    if (a.type === "SpreadElement") {
      return {
        ok: false,
        reason: "dynamic-spread-arg",
        details: `Argument ${i} of ${calleeName}() is a spread. v0.2 cannot analyze spread contents — refuse to mutate.`,
      };
    }
    return {
      ok: false,
      reason: "dynamic-uncertain-arg",
      details: `Argument ${i} of ${calleeName}() is ${a.type}. v0.2 refuses to mutate when any other argument is non-static.`,
    };
  }

  // Build the post-mutation concatenated className and check tailwind-merge.
  const targetArg = args[targetIdx] as { value: string; extra?: unknown };
  const newTargetValue = swapToken(targetArg.value, before, after);
  if (newTargetValue === null) {
    return {
      ok: false,
      reason: "token-not-found",
      details: `Internal: target arg matched but swap couldn't find "${before}"`,
    };
  }

  const concatenated = args
    .map((a, i) =>
      i === targetIdx
        ? newTargetValue
        : ((a as { value?: string }).value ?? ""),
    )
    .join(" ")
    .trim();

  const mergedTokens = twMerge(concatenated).split(/\s+/).filter(Boolean);
  const afterTokens = after.split(/\s+/).filter(Boolean);
  for (const tok of afterTokens) {
    if (!mergedTokens.includes(tok)) {
      return {
        ok: false,
        reason: "dynamic-conflict",
        details: `Mutation would be silently overridden: tailwind-merge resolves "${concatenated}" to "${mergedTokens.join(" ")}", which doesn't include "${tok}". A later argument wins.`,
      };
    }
  }

  // Safe. Apply.
  targetArg.value = newTargetValue;
  if (targetArg.extra) targetArg.extra = undefined;
  return { ok: true, output: "" };
}

// ---------------------------------------------------------------------------
// Generic attribute mutation (v0.2 — B8)
//
// For attributes whose value is a simple string literal (src, href, alt,
// title, …), the mutation is a whole-value swap, not a token swap. This
// function does NOT handle className — that path stays in mutateClassName
// because of its tokenized semantics + safety analysis.
// ---------------------------------------------------------------------------

export type MutateAttributeInput = {
  source: string;
  line: number;
  col: number;
  attribute: string;
  /** If null, no conflict check — current value is overwritten. */
  before: string | null;
  after: string;
};

export type MutateAttributeRefusalReason =
  | "no-jsx-at-location"
  | "no-such-attribute"
  | "dynamic-value"
  | "token-not-found"
  | "parse-error";

export type MutateAttributeResult =
  | { ok: true; output: string; previousValue: string }
  | {
      ok: false;
      reason: MutateAttributeRefusalReason;
      details: string;
    };

export function mutateAttribute(
  input: MutateAttributeInput,
): MutateAttributeResult {
  const { source, line, col, attribute, before, after } = input;

  let ast: ReturnType<typeof recast.parse>;
  try {
    ast = recast.parse(source, { parser: babelTsParser });
  } catch (err) {
    return {
      ok: false,
      reason: "parse-error",
      details: (err as Error).message,
    };
  }

  const out: {
    value: MutateAttributeResult | null;
    visited: boolean;
  } = { value: null, visited: false };

  recast.visit(ast, {
    visitJSXOpeningElement(path) {
      const node = path.node;
      const loc = node.loc;
      if (!loc) {
        this.traverse(path);
        return undefined;
      }
      if (loc.start.line !== line || loc.start.column !== col) {
        this.traverse(path);
        return undefined;
      }
      out.visited = true;

      const attrs = (node.attributes ?? []) as JsxAttributeLike[];
      const targetAttr = attrs.find(
        (a) =>
          a.type === "JSXAttribute" &&
          a.name?.type === "JSXIdentifier" &&
          a.name?.name === attribute,
      );
      if (!targetAttr) {
        out.value = {
          ok: false,
          reason: "no-such-attribute",
          details: `JSX element has no \`${attribute}\` attribute`,
        };
        return false;
      }
      const v = targetAttr.value;
      if (!v) {
        out.value = {
          ok: false,
          reason: "no-such-attribute",
          details: `Attribute \`${attribute}\` has no value`,
        };
        return false;
      }

      // Locate the StringLiteral we're going to swap. Two shapes:
      //   attr="value"             → JSXAttribute.value is StringLiteral
      //   attr={"value"}           → JSXExpressionContainer wrapping StringLiteral
      let lit: { value: string; extra?: unknown } | null = null;
      if (v.type === "StringLiteral" || v.type === "Literal") {
        lit = v as { value: string; extra?: unknown };
      } else if (v.type === "JSXExpressionContainer") {
        const expr = (v as { expression: { type: string; value?: string; extra?: unknown } })
          .expression;
        if (expr.type === "StringLiteral" || expr.type === "Literal") {
          lit = expr as { value: string; extra?: unknown };
        }
      }

      if (!lit) {
        out.value = {
          ok: false,
          reason: "dynamic-value",
          details: `Attribute \`${attribute}\` value is ${(v as { type: string }).type}, not a static string literal`,
        };
        return false;
      }

      if (before !== null && lit.value !== before) {
        out.value = {
          ok: false,
          reason: "token-not-found",
          details: `Current value "${lit.value}" doesn't match expected "${before}" — file may have changed externally`,
        };
        return false;
      }

      const previousValue = lit.value;
      lit.value = after;
      if (lit.extra) lit.extra = undefined;
      out.value = {
        ok: true,
        output: "",
        previousValue,
      };
      return false;
    },
  });

  if (!out.visited) {
    return {
      ok: false,
      reason: "no-jsx-at-location",
      details: `No JSXOpeningElement found at ${line}:${col}`,
    };
  }
  if (!out.value) {
    return {
      ok: false,
      reason: "no-jsx-at-location",
      details: "Visitor matched location but produced no result",
    };
  }
  if (out.value.ok) {
    return {
      ok: true,
      output: recast.print(ast).code,
      previousValue: out.value.previousValue,
    };
  }
  return out.value;
}

function getCalleeName(
  callee: CallExprLike["callee"] | unknown,
): string | null {
  if (!callee || typeof callee !== "object") return null;
  const c = callee as {
    type: string;
    name?: string;
    property?: { name?: string };
  };
  if (c.type === "Identifier") return c.name ?? null;
  if (c.type === "MemberExpression") return c.property?.name ?? null;
  return null;
}

function tokensFromValue(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

// Swap a single occurrence of `before` with `after` in a whitespace-separated
// className value, preserving the original whitespace between tokens. Returns
// `null` if the `before` token isn't present.
function swapToken(
  value: string,
  before: string,
  after: string,
): string | null {
  const parts = value.split(/(\s+)/);
  let found = false;
  const out = parts.map((p) => {
    if (!found && p === before) {
      found = true;
      return after;
    }
    return p;
  });
  if (!found) return null;
  return out.join("");
}
