import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as recast from "recast";
import babelTsParser from "recast/parsers/babel-ts.js";
import { mutateClassName } from "../src/ast/className.ts";

// Test helper: parse `source` and return the location of the *first*
// JSXOpeningElement whose tag name matches `tag`. Tests use this so they
// don't have to hand-compute line/col (and break every time we touch
// indentation in the fixture).
function locOf(
  source: string,
  tag: string,
): { line: number; col: number } {
  const ast = recast.parse(source, { parser: babelTsParser });
  let found: { line: number; col: number } | null = null;
  recast.visit(ast, {
    visitJSXOpeningElement(path) {
      if (found) return false;
      const node = path.node as {
        name: { type: string; name?: string };
        loc?: { start: { line: number; column: number } };
      };
      if (node.name.type === "JSXIdentifier" && node.name.name === tag) {
        if (node.loc) found = { line: node.loc.start.line, col: node.loc.start.column };
      }
      this.traverse(path);
      return undefined;
    },
  });
  if (!found) throw new Error(`No <${tag}> found in source`);
  return found;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("static StringLiteral: swap p-4 -> p-6", () => {
  const src = `export default () => <div className="p-4">hi</div>;`;
  const { line, col } = locOf(src, "div");
  const r = mutateClassName({ source: src, line, col, before: "p-4", after: "p-6" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.output, /className="p-6"/);
    assert.ok(!r.output.includes("p-4"));
  }
});

test("static StringLiteral with multiple tokens: only target swapped, others preserved", () => {
  const src = `export default () => <div className="p-4 bg-white text-sm">x</div>;`;
  const { line, col } = locOf(src, "div");
  const r = mutateClassName({ source: src, line, col, before: "p-4", after: "p-6" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.output, /className="p-6 bg-white text-sm"/);
  }
});

test("JSXExpressionContainer wrapping StringLiteral: className={\"p-4\"} swaps", () => {
  const src = `export default () => <div className={"p-4 text-sm"}>x</div>;`;
  const { line, col } = locOf(src, "div");
  const r = mutateClassName({ source: src, line, col, before: "p-4", after: "p-6" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.output, /className=\{"p-6 text-sm"\}/);
  }
});

test("preserves other JSX attributes and surrounding formatting verbatim", () => {
  const src = [
    "export default () => (",
    "  <div",
    "    id='foo'",
    "    className=\"p-4\"",
    "    data-test={42}>",
    "    body",
    "  </div>",
    ");",
    "",
  ].join("\n");
  const { line, col } = locOf(src, "div");
  const r = mutateClassName({ source: src, line, col, before: "p-4", after: "p-6" });
  assert.equal(r.ok, true);
  if (r.ok) {
    // Only the className token changed; the single-quoted id, the data-test
    // expression, the indentation, and the surrounding parens are preserved.
    assert.match(r.output, /id='foo'/);
    assert.match(r.output, /data-test=\{42\}/);
    assert.match(r.output, /className="p-6"/);
    assert.ok(!r.output.includes("p-4"));
    // No reformatting of whitespace:
    assert.match(r.output, /\n    id='foo'/);
    assert.match(r.output, /\n    className="p-6"/);
  }
});

// ---------------------------------------------------------------------------
// Refusal paths (Principle 1 — refuse dynamic contexts with a clear reason)
// ---------------------------------------------------------------------------

// v0.2 (B1): cn/clsx/twMerge calls are now MUTATABLE when the safety
// analysis proves the mutation has effect. The old `dynamic-call-expression`
// refusal is replaced by more specific reasons.

test("v0.2: cn(...) with a non-string-literal arg refuses with `dynamic-uncertain-arg`", () => {
  const src = `export default ({ on }: { on: boolean }) =>
    <div className={cn("p-4", on && "bg-white")}>x</div>;`;
  const { line, col } = locOf(src, "div");
  const r = mutateClassName({ source: src, line, col, before: "p-4", after: "p-6" });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "dynamic-uncertain-arg");
    assert.match(r.details, /cn/);
  }
});

test("v0.2: clsx(...) with all static args is mutated cleanly", () => {
  const src = `export default () => <div className={clsx("p-4", "bg-white")}>x</div>;`;
  const { line, col } = locOf(src, "div");
  const r = mutateClassName({ source: src, line, col, before: "p-4", after: "p-6" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.output, /clsx\("p-6", "bg-white"\)/);
    // The bg-white arg stays untouched.
    assert.match(r.output, /"bg-white"/);
  }
});

test("v0.2: twMerge('p-4', 'p-8') refuses with `dynamic-conflict` — p-8 would silently win", () => {
  const src = `export default () => <div className={twMerge("p-4", "p-8")}>x</div>;`;
  const { line, col } = locOf(src, "div");
  const r = mutateClassName({ source: src, line, col, before: "p-4", after: "p-6" });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "dynamic-conflict");
    // The details should mention what the merge resolved to.
    assert.match(r.details, /p-8/);
  }
});

test("v0.2: cn('p-4', 'pt-2') — partial conflict, twMerge keeps both, mutation succeeds", () => {
  const src = `export default () => <div className={cn("p-4", "pt-2")}>x</div>;`;
  const { line, col } = locOf(src, "div");
  const r = mutateClassName({ source: src, line, col, before: "p-4", after: "p-6" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.output, /cn\("p-6", "pt-2"\)/);
  }
});

test("v0.2: cn('p-4 bg-white') — multi-token arg, p-4 swapped cleanly", () => {
  const src = `export default () => <div className={cn("p-4 bg-white")}>x</div>;`;
  const { line, col } = locOf(src, "div");
  const r = mutateClassName({ source: src, line, col, before: "p-4", after: "p-6" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.output, /cn\("p-6 bg-white"\)/);
  }
});

test("v0.2: cn('text-sm', 'p-4') — token in non-first arg, located + mutated", () => {
  const src = `export default () => <div className={cn("text-sm", "p-4")}>x</div>;`;
  const { line, col } = locOf(src, "div");
  const r = mutateClassName({ source: src, line, col, before: "p-4", after: "p-6" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.output, /cn\("text-sm", "p-6"\)/);
  }
});

test("v0.2: cn('p-4', styles.foo) — identifier arg refuses with `dynamic-uncertain-arg`", () => {
  const src = `import styles from "./x.module.css";
    export default () => <div className={cn("p-4", styles.foo)}>x</div>;`;
  const { line, col } = locOf(src, "div");
  const r = mutateClassName({ source: src, line, col, before: "p-4", after: "p-6" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "dynamic-uncertain-arg");
});

test("v0.2: cn('p-4', ...rest) — spread arg refuses with `dynamic-spread-arg`", () => {
  const src = `export default (rest: string[]) => <div className={cn("p-4", ...rest)}>x</div>;`;
  const { line, col } = locOf(src, "div");
  const r = mutateClassName({ source: src, line, col, before: "p-4", after: "p-6" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "dynamic-spread-arg");
});

test("v0.2: someUnknownUtil('p-4') — not a known merger, refuses with `unknown-merger`", () => {
  const src = `export default () => <div className={someUnknownUtil("p-4")}>x</div>;`;
  const { line, col } = locOf(src, "div");
  const r = mutateClassName({ source: src, line, col, before: "p-4", after: "p-6" });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "unknown-merger");
    assert.match(r.details, /someUnknownUtil/);
  }
});

test("v0.2: cva(...)() — nested call refuses with `unknown-merger` (cva not in B1 scope)", () => {
  const src = `export default () => <div className={cva("p-4")()}>x</div>;`;
  const { line, col } = locOf(src, "div");
  const r = mutateClassName({ source: src, line, col, before: "p-4", after: "p-6" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "unknown-merger");
});

test("v0.2: classnames(...) is recognized as a merger (alias of cn/clsx)", () => {
  const src = `export default () => <div className={classnames("p-4", "rounded")}>x</div>;`;
  const { line, col } = locOf(src, "div");
  const r = mutateClassName({ source: src, line, col, before: "p-4", after: "p-6" });
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.output, /classnames\("p-6", "rounded"\)/);
});

test("v0.2: cn('p-4') with the new compound-override `after`, twMerge keeps the override", () => {
  // Padding-handle uses this pattern: emit "p-4 pt-8" so twMerge keeps
  // both, the override winning on the top side only. Verify mutation
  // inside cn(...) survives the merge check.
  const src = `export default () => <div className={cn("p-4 m-2")}>x</div>;`;
  const { line, col } = locOf(src, "div");
  const r = mutateClassName({
    source: src,
    line,
    col,
    before: "p-4",
    after: "p-4 pt-8",
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.output, /cn\("p-4 pt-8 m-2"\)/);
});

test("refuse: template literal", () => {
  const src =
    "export default ({ s }: { s: string }) => <div className={`p-4 ${s}`}>x</div>;";
  const { line, col } = locOf(src, "div");
  const r = mutateClassName({ source: src, line, col, before: "p-4", after: "p-6" });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "dynamic-template-literal");
  }
});

test("refuse: conditional/ternary expression", () => {
  const src = `export default ({ on }: { on: boolean }) =>
    <div className={on ? "p-4" : "p-8"}>x</div>;`;
  const { line, col } = locOf(src, "div");
  const r = mutateClassName({ source: src, line, col, before: "p-4", after: "p-6" });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "dynamic-conditional");
  }
});

test("refuse: spread attribute with no local className", () => {
  const src = `export default (props: object) => <div {...props}>x</div>;`;
  const { line, col } = locOf(src, "div");
  const r = mutateClassName({ source: src, line, col, before: "p-4", after: "p-6" });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "no-classname-attribute");
  }
});

test("refuse: token not present in static literal", () => {
  const src = `export default () => <div className="bg-white text-sm">x</div>;`;
  const { line, col } = locOf(src, "div");
  const r = mutateClassName({ source: src, line, col, before: "p-4", after: "p-6" });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "token-not-found");
  }
});

test("refuse: no JSX element at the given location", () => {
  const src = `export default () => <div className="p-4">x</div>;`;
  // Deliberately wrong location.
  const r = mutateClassName({
    source: src,
    line: 99,
    col: 0,
    before: "p-4",
    after: "p-6",
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "no-jsx-at-location");
  }
});

// ---------------------------------------------------------------------------
// Whole-file robustness: nearby JSX with the same `before` token is not touched
// ---------------------------------------------------------------------------

test("only mutates the JSX at the exact location, not siblings with the same className", () => {
  const src = [
    `export default () => (`,
    `  <main>`,
    `    <div className="p-4">A</div>`,
    `    <div className="p-4">B</div>`,
    `  </main>`,
    `);`,
    ``,
  ].join("\n");

  // Find both <div> locations.
  const ast = recast.parse(src, { parser: babelTsParser });
  const divLocs: { line: number; col: number }[] = [];
  recast.visit(ast, {
    visitJSXOpeningElement(path) {
      const n = path.node as {
        name: { type: string; name?: string };
        loc?: { start: { line: number; column: number } };
      };
      if (n.name.type === "JSXIdentifier" && n.name.name === "div" && n.loc) {
        divLocs.push({ line: n.loc.start.line, col: n.loc.start.column });
      }
      this.traverse(path);
      return undefined;
    },
  });
  assert.equal(divLocs.length, 2);

  // Mutate only the FIRST <div>'s className.
  const first = divLocs[0]!;
  const r = mutateClassName({
    source: src,
    line: first.line,
    col: first.col,
    before: "p-4",
    after: "p-6",
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    // First div became p-6; second div is still p-4.
    const occurrences = (r.output.match(/p-4/g) ?? []).length;
    assert.equal(occurrences, 1);
    const occurrencesNew = (r.output.match(/p-6/g) ?? []).length;
    assert.equal(occurrencesNew, 1);
    // Sibling untouched, including its line.
    assert.match(r.output, /<div className="p-4">B<\/div>/);
    assert.match(r.output, /<div className="p-6">A<\/div>/);
  }
});
