import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  stampJsx,
  toSourceId,
  findWorkspaceRoot,
  resolveWorkspaceRoot,
} from "../src/transform/stamp.ts";
import { mutateClassName } from "../src/ast/className.ts";

const ROOT = "/repo";
const FILE = "/repo/app/page.tsx";

const FIXTURE = `import styles from "./Card.module.css";
import styled from "styled-components";
export const Box = styled.div\`
  padding: 1rem;
\`;
const Dyn = styled.span\`color: \${(p: any) => p.c};\`;
export default function Page<T>() {
  return (
    <main className="p-8">
      <h1 className={"text-xl"}>Hi</h1>
      <Button className="p-4" />
      <Foo.Bar id="x">
        <img src="/a.png" alt="a" />
      </Foo.Bar>
      <div className={styles.card}>mod</div>
      <Box>styled</Box>
      <Dyn c="red">dyn</Dyn>
      <List<T> items={[]} />
      <svg:rect />
      <span data-oid="already">keep</span>
    </main>
  );
}
`;

function attrs(code: string, name: string): string[] {
  const re = new RegExp(`${name}="([^"]*)"`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) out.push(m[1]!);
  return out;
}

test("stamps host elements with data-oid and components with data-oid-call", () => {
  const r = stampJsx(FIXTURE, { filename: FILE, root: ROOT });
  assert.equal(r.changed, true);
  const oids = attrs(r.code, "data-oid");
  const calls = attrs(r.code, "data-oid-call");
  // Hosts: main, h1, img, div, svg:rect (span already stamped — untouched).
  assert.deepEqual(
    oids.filter((o) => o !== "already"),
    [
      "app/page.tsx:9:4",
      "app/page.tsx:10:6",
      "app/page.tsx:13:8",
      "app/page.tsx:15:6",
      "app/page.tsx:19:6",
    ],
  );
  // Components: Button, Foo.Bar, Box, Dyn, List<T>.
  assert.deepEqual(calls, [
    "app/page.tsx:11:6",
    "app/page.tsx:12:6",
    "app/page.tsx:16:6",
    "app/page.tsx:17:6",
    "app/page.tsx:18:6",
  ]);
  assert.equal(r.stamped, 10);
  // The user-authored data-oid survives verbatim and isn't doubled.
  assert.equal(attrs(r.code, "data-oid").filter((o) => o === "already").length, 1);
});

test("stamps the styled-components and CSS Module hints", () => {
  const r = stampJsx(FIXTURE, { filename: FILE, root: ROOT });
  assert.match(r.code, /<Box data-oid-call="app\/page.tsx:16:6" data-styled-name="Box" data-styled-tag="div">/);
  // Dyn has an interpolation → no styled hint (server can't mutate it).
  assert.doesNotMatch(r.code, /data-styled-name="Dyn"/);
  assert.match(
    r.code,
    /<div data-oid="app\/page.tsx:15:6" data-css-module-class="card" data-css-module-file=".\/Card.module.css" className=\{styles.card\}>/,
  );
});

test("generic call sites insert after the type arguments, keeping the source valid", () => {
  const r = stampJsx(FIXTURE, { filename: FILE, root: ROOT });
  assert.match(r.code, /<List<T> data-oid-call="app\/page.tsx:18:6" items=\{\[\]\} \/>/);
});

test("stamped locations round-trip into the mutator against the ORIGINAL source", () => {
  const r = stampJsx(FIXTURE, { filename: FILE, root: ROOT });
  const [, l, c] = /data-oid-call="app\/page.tsx:(\d+):(\d+)"/.exec(
    r.code.split("\n").find((ln) => ln.includes("<Button"))!,
  )!;
  const m = mutateClassName({
    source: FIXTURE,
    line: Number(l),
    col: Number(c),
    before: "p-4",
    after: "p-6",
  });
  assert.equal(m.ok, true);
  if (m.ok) assert.match(m.output, /<Button className="p-6" \/>/);
});

test("leaves files without JSX untouched and never throws on broken syntax", () => {
  const plain = stampJsx("export const a = 1;\n", { filename: FILE, root: ROOT });
  assert.equal(plain.changed, false);
  assert.equal(plain.code, "export const a = 1;\n");

  const broken = stampJsx("export default function () { return <div; }\n", {
    filename: FILE,
    root: ROOT,
  });
  assert.equal(broken.changed, false);
  assert.ok(broken.parseError);
  assert.equal(broken.code, "export default function () { return <div; }\n");
});

test("files outside the root get ../ ids (the server then refuses to write them)", () => {
  const r = stampJsx(`export const X = () => <div className="p-1" />;\n`, {
    filename: "/repo/packages/ui/Card.tsx",
    root: "/repo/apps/web",
  });
  assert.deepEqual(attrs(r.code, "data-oid"), ["../../packages/ui/Card.tsx:1:23"]);
  assert.equal(toSourceId("/repo", "/repo/src/a.tsx"), "src/a.tsx");
});

test("workspace root resolution: explicit > env > nearest marker > cwd", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ve-root-"));
  const repo = path.join(tmp, "repo");
  const app = path.join(repo, "apps", "web", "src");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(repo, "turbo.json"), "{}");
  assert.equal(findWorkspaceRoot(app), repo);
  assert.equal(resolveWorkspaceRoot({ cwd: app, env: {} }), repo);
  assert.equal(
    resolveWorkspaceRoot({ cwd: app, env: { VISUAL_EDITOR_WORKSPACE_ROOT: tmp } }),
    tmp,
  );
  assert.equal(resolveWorkspaceRoot({ cwd: app, env: {}, explicit: app }), app);
  // No marker anywhere above → falls back to cwd itself.
  const lonely = fs.mkdtempSync(path.join(os.tmpdir(), "ve-lonely-"));
  const markerless = findWorkspaceRoot(lonely);
  // os.tmpdir() might itself live inside a git repo on dev machines; only
  // assert the fallback when nothing was found.
  if (markerless === null) {
    assert.equal(resolveWorkspaceRoot({ cwd: lonely, env: {} }), lonely);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(lonely, { recursive: true, force: true });
});

test("parity: the Babel plugin and the stamper emit identical ids for the same source", async () => {
  const require = createRequire(import.meta.url);
  const babel = require("@babel/core") as typeof import("@babel/core");
  const pluginPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../babel-plugin/index.js",
  );
  const viaBabel = babel.transformSync(FIXTURE, {
    filename: FILE,
    cwd: ROOT,
    configFile: false,
    babelrc: false,
    retainLines: true,
    plugins: [
      [pluginPath, { root: ROOT }],
      require.resolve("@babel/plugin-syntax-jsx"),
      [require.resolve("@babel/plugin-syntax-typescript"), { isTSX: true }],
    ],
  })!.code!;
  const viaStamp = stampJsx(FIXTURE, { filename: FILE, root: ROOT }).code;
  for (const name of [
    "data-oid",
    "data-oid-call",
    "data-styled-name",
    "data-styled-tag",
    "data-css-module-class",
    "data-css-module-file",
  ]) {
    assert.deepEqual(
      attrs(viaBabel, name).sort(),
      attrs(viaStamp, name).sort(),
      `attribute ${name} differs between babel plugin and stamper`,
    );
  }
});
