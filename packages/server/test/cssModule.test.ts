import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectCssModule,
  mutateCssProperty,
} from "../src/css/cssModule.ts";
import { applyCssProperty } from "../src/fs/applyCssProperty.ts";

// ---------------------------------------------------------------------------
// detectCssModule — JSX-side recognition
// ---------------------------------------------------------------------------

test("detect: <div className={styles.foo}> → resolves to ./Foo.module.css + .foo", () => {
  const src = `
    import styles from "./Foo.module.css";
    export default () => <div className={styles.foo}>x</div>;
  `;
  const idx = src.indexOf("<div");
  // Find line/col of <div
  const before = src.slice(0, idx);
  const line = (before.match(/\n/g) ?? []).length + 1;
  const col = idx - (before.lastIndexOf("\n") + 1);
  const r = detectCssModule(src, line, col);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.ref.cssFile, "./Foo.module.css");
    assert.equal(r.ref.selector, ".foo");
  }
});

test("detect: refuses className=\"foo\" (string literal, not a CSS module)", () => {
  const src = `export default () => <div className="foo">x</div>;`;
  const r = detectCssModule(src, 1, src.indexOf("<div"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "dynamic-classname");
});

test("detect: refuses className={styles['foo']} (computed access)", () => {
  const src = `
    import styles from "./x.module.css";
    export default () => <div className={styles["foo"]}>x</div>;
  `;
  const idx = src.indexOf("<div");
  const before = src.slice(0, idx);
  const line = (before.match(/\n/g) ?? []).length + 1;
  const col = idx - (before.lastIndexOf("\n") + 1);
  const r = detectCssModule(src, line, col);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "dynamic-classname");
});

test("detect: refuses when import isn't a .module.css file", () => {
  const src = `
    import styles from "./Foo.css";
    export default () => <div className={styles.foo}>x</div>;
  `;
  const idx = src.indexOf("<div");
  const before = src.slice(0, idx);
  const line = (before.match(/\n/g) ?? []).length + 1;
  const col = idx - (before.lastIndexOf("\n") + 1);
  const r = detectCssModule(src, line, col);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "not-a-css-module");
});

test("detect: refuses when no JSX at the given location", () => {
  const src = `export default () => null;`;
  const r = detectCssModule(src, 1, 0);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "no-jsx-at-location");
});

test("detect: refuses when styles identifier has no matching import", () => {
  const src = `export default () => <div className={styles.foo}>x</div>;`;
  const r = detectCssModule(src, 1, src.indexOf("<div"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "unresolved-import");
});

// ---------------------------------------------------------------------------
// mutateCssProperty — postcss-level mutation
// ---------------------------------------------------------------------------

test("mutate: updates an existing property on a matching rule", () => {
  const css = `.foo {\n  padding: 1rem;\n  color: red;\n}`;
  const r = mutateCssProperty(css, ".foo", "padding", "1.5rem");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.output, /padding: 1\.5rem/);
    assert.match(r.output, /color: red/); // unchanged
    assert.equal(r.previousValue, "1rem");
  }
});

test("mutate: inserts a new property when not present on the rule", () => {
  const css = `.bar {\n  color: blue;\n}`;
  const r = mutateCssProperty(css, ".bar", "padding", "8px");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.output, /padding: 8px/);
    assert.match(r.output, /color: blue/);
    assert.equal(r.previousValue, null);
  }
});

test("mutate: refuses when selector doesn't exist", () => {
  const css = `.foo { padding: 1rem; }`;
  const r = mutateCssProperty(css, ".bar", "padding", "1rem");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "selector-not-found");
});

test("mutate: refuses on `composes:` chains (would leak through)", () => {
  const css = `
    .base { padding: 1rem; }
    .child { composes: base; color: red; }
  `;
  const r = mutateCssProperty(css, ".child", "color", "blue");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "composes-chain");
});

test("mutate: refuses invalid property names (defends against injection)", () => {
  const css = `.foo { padding: 1rem; }`;
  const r = mutateCssProperty(css, ".foo", "color; background: red", "blue");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "invalid-property");
});

test("mutate: only updates the top-level rule, ignores nested @media overrides", () => {
  const css = `.foo {
  padding: 1rem;
}
@media (min-width: 800px) {
  .foo {
    padding: 2rem;
  }
}`;
  const r = mutateCssProperty(css, ".foo", "padding", "1.5rem");
  assert.equal(r.ok, true);
  if (r.ok) {
    // The top-level .foo padding becomes 1.5rem; the @media .foo stays at 2rem.
    assert.match(r.output, /\.foo\s*\{\s*padding:\s*1\.5rem/);
    assert.match(r.output, /padding:\s*2rem/);
  }
});

// ---------------------------------------------------------------------------
// applyCssProperty — full orchestrator (fs + JSX detection + CSS mutation)
// ---------------------------------------------------------------------------

let workspace: string;

before(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "visual-edit-css-"));
});

after(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

async function writeFixture(rel: string, contents: string): Promise<void> {
  const abs = path.join(workspace, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents, "utf8");
}
async function readFixture(rel: string): Promise<string> {
  return fs.readFile(path.join(workspace, rel), "utf8");
}

// Find the (1-based line, 0-based col) of the first occurrence of `needle`
// in `src`. indexOf returns an absolute character offset; we have to
// translate to Babel's loc shape.
function locOfText(src: string, needle: string): { line: number; col: number } {
  const idx = src.indexOf(needle);
  if (idx === -1) throw new Error(`needle not found: ${needle}`);
  const before = src.slice(0, idx);
  const newlines = (before.match(/\n/g) ?? []).length;
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: newlines + 1, col: idx - lineStart };
}

test("applyCssProperty: full happy path mutates the .module.css file", async () => {
  await writeFixture(
    "components/Card.tsx",
    `import styles from "./Card.module.css";\nexport default () => <div className={styles.card}>x</div>;\n`,
  );
  await writeFixture(
    "components/Card.module.css",
    `.card {\n  padding: 1rem;\n}\n`,
  );

  const tsxSrc = await readFixture("components/Card.tsx");
  const { line, col } = locOfText(tsxSrc, "<div");
  const outcome = await applyCssProperty(
    {
      file: "components/Card.tsx",
      line,
      col,
      property: "padding",
      value: "2rem",
    },
    { workspaceRoot: workspace, dryRun: false },
  );
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.selector, ".card");
    assert.equal(outcome.previousValue, "1rem");
    const css = await readFixture("components/Card.module.css");
    assert.match(css, /padding: 2rem/);
  }
});

test("applyCssProperty: refuses when className isn't `styles.foo`", async () => {
  await writeFixture(
    "components/Plain.tsx",
    `export default () => <div className="plain">x</div>;\n`,
  );
  const plainSrc = await readFixture("components/Plain.tsx");
  const { line: pLine, col: pCol } = locOfText(plainSrc, "<div");
  const outcome = await applyCssProperty(
    {
      file: "components/Plain.tsx",
      line: pLine,
      col: pCol,
      property: "padding",
      value: "2rem",
    },
    { workspaceRoot: workspace, dryRun: false },
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "dynamic-classname");
});

test("applyCssProperty: 403 on path-outside-workspace", async () => {
  const outcome = await applyCssProperty(
    {
      file: "../../etc/passwd",
      line: 1,
      col: 0,
      property: "padding",
      value: "2rem",
    },
    { workspaceRoot: workspace, dryRun: false },
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.status, 403);
    assert.equal(outcome.reason, "path-outside-workspace");
  }
});

test("applyCssProperty: 404 when JSX file doesn't exist", async () => {
  const outcome = await applyCssProperty(
    {
      file: "components/Nope.tsx",
      line: 1,
      col: 0,
      property: "padding",
      value: "2rem",
    },
    { workspaceRoot: workspace, dryRun: false },
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.status, 404);
    assert.equal(outcome.reason, "jsx-file-not-found");
  }
});

test("applyCssProperty: dryRun returns diff but doesn't write CSS", async () => {
  await writeFixture(
    "components/Dry.tsx",
    `import styles from "./Dry.module.css";\nexport default () => <div className={styles.x}>x</div>;\n`,
  );
  const cssOriginal = `.x { padding: 1rem; }\n`;
  await writeFixture("components/Dry.module.css", cssOriginal);

  const drySrc = await readFixture("components/Dry.tsx");
  const { line: dLine, col: dCol } = locOfText(drySrc, "<div");
  const outcome = await applyCssProperty(
    {
      file: "components/Dry.tsx",
      line: dLine,
      col: dCol,
      property: "padding",
      value: "3rem",
    },
    { workspaceRoot: workspace, dryRun: true },
  );
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.match(outcome.diff, /\+.*padding: 3rem/);
  }
  assert.equal(await readFixture("components/Dry.module.css"), cssOriginal);
});
