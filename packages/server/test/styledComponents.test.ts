import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectStyledComponent,
  mutateStyledProperty,
} from "../src/css/styledComponents.ts";
import { applyStyledProperty } from "../src/fs/applyStyledProperty.ts";

function locOfText(src: string, needle: string): { line: number; col: number } {
  const idx = src.indexOf(needle);
  if (idx === -1) throw new Error(`needle not found: ${needle}`);
  const before = src.slice(0, idx);
  const newlines = (before.match(/\n/g) ?? []).length;
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: newlines + 1, col: idx - lineStart };
}

// ---------------------------------------------------------------------------
// detectStyledComponent
// ---------------------------------------------------------------------------

test("detect: <Button> with same-file `styled.button` defn → resolves componentName + htmlTag", () => {
  const src = `import styled from "styled-components";
const Button = styled.button\`
  padding: 1rem;
  color: white;
\`;
export default () => <Button>x</Button>;`;
  const { line, col } = locOfText(src, "<Button>");
  const r = detectStyledComponent(src, line, col);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.ref.componentName, "Button");
    assert.equal(r.ref.htmlTag, "button");
  }
});

test("detect: refuses lowercase tag (`<div>`) — not a styled component", () => {
  const src = `export default () => <div>x</div>;`;
  const { line, col } = locOfText(src, "<div");
  const r = detectStyledComponent(src, line, col);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "not-a-styled-component");
});

test("detect: refuses styled() extension (`styled(Base)`...)", () => {
  const src = `import styled from "styled-components";
const Base = "div";
const Card = styled(Base)\`padding: 1rem;\`;
export default () => <Card>x</Card>;`;
  const { line, col } = locOfText(src, "<Card>");
  const r = detectStyledComponent(src, line, col);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "styled-extension-not-supported");
});

test("detect: refuses .attrs() chain", () => {
  const src = `import styled from "styled-components";
const Card = styled.div.attrs({ role: "card" })\`padding: 1rem;\`;
export default () => <Card>x</Card>;`;
  const { line, col } = locOfText(src, "<Card>");
  const r = detectStyledComponent(src, line, col);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "styled-attrs-not-supported");
});

test("detect: refuses templates with `${…}` interpolations", () => {
  const src = `import styled from "styled-components";
const Card = styled.div\`
  padding: \${(p) => p.pad}rem;
\`;
export default () => <Card>x</Card>;`;
  const { line, col } = locOfText(src, "<Card>");
  const r = detectStyledComponent(src, line, col);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "styled-with-interpolation");
});

test("detect: refuses cross-file (no same-file definition)", () => {
  const src = `import { Button } from "./Button";
export default () => <Button>x</Button>;`;
  const { line, col } = locOfText(src, "<Button>");
  const r = detectStyledComponent(src, line, col);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "cross-file-styled-not-supported");
});

// ---------------------------------------------------------------------------
// mutateStyledProperty
// ---------------------------------------------------------------------------

test("mutate: updates existing property on the styled template", () => {
  const src = `import styled from "styled-components";
const Card = styled.div\`
  padding: 1rem;
  color: white;
\`;
export default () => <Card>x</Card>;`;
  const r = mutateStyledProperty(src, "Card", "padding", "2rem");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.output, /padding: 2rem/);
    assert.match(r.output, /color: white/);
    assert.equal(r.previousValue, "1rem");
  }
});

test("mutate: inserts a new property when not present", () => {
  const src = `import styled from "styled-components";
const Card = styled.div\`
  color: white;
\`;
export default () => <Card>x</Card>;`;
  const r = mutateStyledProperty(src, "Card", "padding", "8px");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.output, /padding: 8px/);
    assert.equal(r.previousValue, null);
  }
});

test("mutate: refuses when component isn't a styled template", () => {
  const src = `const Card = () => null;`;
  const r = mutateStyledProperty(src, "Card", "padding", "1rem");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "component-not-found");
});

test("mutate: refuses templates with interpolations", () => {
  const src = `import styled from "styled-components";
const Card = styled.div\`
  padding: \${(p) => p.pad}rem;
\`;`;
  const r = mutateStyledProperty(src, "Card", "color", "red");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "styled-with-interpolation");
});

test("mutate: refuses invalid property names", () => {
  const src = `import styled from "styled-components";
const Card = styled.div\`padding: 1rem;\`;`;
  const r = mutateStyledProperty(src, "Card", "color; background: red", "blue");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "invalid-property");
});

// ---------------------------------------------------------------------------
// applyStyledProperty — full orchestrator
// ---------------------------------------------------------------------------

let workspace: string;

before(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "visual-edit-styled-"));
});

after(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

async function writeFix(rel: string, contents: string): Promise<void> {
  const abs = path.join(workspace, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents, "utf8");
}

async function readFix(rel: string): Promise<string> {
  return fs.readFile(path.join(workspace, rel), "utf8");
}

test("applyStyledProperty: happy path mutates the file on disk", async () => {
  const src = `import styled from "styled-components";
const Card = styled.div\`
  padding: 1rem;
  background: white;
\`;
export default () => <Card>x</Card>;`;
  await writeFix("components/StyledCard.tsx", src);
  const { line, col } = locOfText(src, "<Card>");

  const outcome = await applyStyledProperty(
    {
      file: "components/StyledCard.tsx",
      line,
      col,
      property: "padding",
      value: "2.5rem",
    },
    { workspaceRoot: workspace, dryRun: false },
  );
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.componentName, "Card");
    assert.equal(outcome.previousValue, "1rem");
  }
  const after = await readFix("components/StyledCard.tsx");
  assert.match(after, /padding: 2\.5rem/);
  assert.match(after, /background: white/);
});

test("applyStyledProperty: 403 on path-outside-workspace", async () => {
  const outcome = await applyStyledProperty(
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

test("applyStyledProperty: dryRun returns diff but doesn't write", async () => {
  const src = `import styled from "styled-components";
const X = styled.div\`padding: 1rem;\`;
export default () => <X>x</X>;`;
  await writeFix("components/Dry.tsx", src);
  const { line, col } = locOfText(src, "<X>");
  const outcome = await applyStyledProperty(
    {
      file: "components/Dry.tsx",
      line,
      col,
      property: "padding",
      value: "3rem",
    },
    { workspaceRoot: workspace, dryRun: true },
  );
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.match(outcome.diff, /\+.*padding: 3rem/);
  }
  const after = await readFix("components/Dry.tsx");
  assert.equal(after, src); // unchanged
});
