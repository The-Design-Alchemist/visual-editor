import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "../src/http/server.ts";
import { RecentApplies } from "../src/state/recentApplies.ts";
import { SessionToken } from "../src/state/auth.ts";
import type { Server } from "node:http";

let server: Server;
let baseUrl: string;
let workspace: string;
const recentApplies = new RecentApplies();
const sessionToken = new SessionToken();
const TEST_TOKEN = "test-token-deadbeef-cafe-0000";
sessionToken.setInMemory(TEST_TOKEN);

before(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "visual-editor-test-"));
  server = createServer({ workspaceRoot: workspace, recentApplies, sessionToken });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (typeof addr === "object" && addr) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  } else {
    throw new Error("Could not determine bound port");
  }
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
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

// ---------------------------------------------------------------------------
// Smoke
// ---------------------------------------------------------------------------

test("GET /health returns ok", async () => {
  const r = await fetch(`${baseUrl}/health`);
  assert.equal(r.status, 200);
  const body = (await r.json()) as { ok: boolean };
  assert.equal(body.ok, true);
});

// ---------------------------------------------------------------------------
// Happy path: /apply mutates the file on disk
// ---------------------------------------------------------------------------

test("POST /apply mutates p-4 -> p-6 on disk and returns a unified diff", async () => {
  const src = `export default () => <div className="p-4">x</div>;\n`;
  await writeFixture("app/page.tsx", src);

  // <div opens at line 1, column 22 (after `export default () => `).
  // Compute it for robustness rather than hand-counting.
  const col = src.indexOf("<div");
  const r = await fetch(`${baseUrl}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify({
      file: "app/page.tsx",
      line: 1,
      col,
      before: "p-4",
      after: "p-6",
    }),
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { ok: boolean; diff: string };
  assert.equal(body.ok, true);
  assert.match(body.diff, /-.*p-4/);
  assert.match(body.diff, /\+.*p-6/);

  const onDisk = await readFixture("app/page.tsx");
  assert.match(onDisk, /className="p-6"/);
  assert.ok(!onDisk.includes("p-4"));
});

// ---------------------------------------------------------------------------
// /propose does NOT touch disk
// ---------------------------------------------------------------------------

test("POST /propose returns the diff but leaves disk untouched", async () => {
  const src = `export default () => <main className="p-4">x</main>;\n`;
  await writeFixture("proposed.tsx", src);

  const col = src.indexOf("<main");
  const r = await fetch(`${baseUrl}/propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify({
      file: "proposed.tsx",
      line: 1,
      col,
      before: "p-4",
      after: "p-6",
    }),
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { ok: boolean; diff: string };
  assert.equal(body.ok, true);
  assert.match(body.diff, /\+.*p-6/);

  // Disk unchanged.
  const onDisk = await readFixture("proposed.tsx");
  assert.equal(onDisk, src);
});

// ---------------------------------------------------------------------------
// Conflict path: file changed between staging and apply
// ---------------------------------------------------------------------------

test("POST /apply returns 409 when the source no longer contains `before` at line:col", async () => {
  // Original file would have had `p-4`, but the user already changed it
  // to `p-8` (simulating an IDE edit that happened between drag and Apply).
  const drifted = `export default () => <div className="p-8">x</div>;\n`;
  await writeFixture("conflict.tsx", drifted);

  const col = drifted.indexOf("<div");
  const r = await fetch(`${baseUrl}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify({
      file: "conflict.tsx",
      line: 1,
      col,
      before: "p-4",
      after: "p-6",
    }),
  });
  assert.equal(r.status, 409);
  const body = (await r.json()) as { ok: boolean; reason: string };
  assert.equal(body.ok, false);
  assert.equal(body.reason, "token-not-found");

  // The drifted file MUST remain untouched.
  const onDisk = await readFixture("conflict.tsx");
  assert.equal(onDisk, drifted);
});

// ---------------------------------------------------------------------------
// Refusal: dynamic className context (Principle 1)
// ---------------------------------------------------------------------------

test("POST /apply returns 400 with reason `dynamic-uncertain-arg` for cn() with a non-static other arg", async () => {
  // v0.2 (B1): cn() is now MUTATABLE when args are static. This test
  // verifies the *refusal* case where another arg is a LogicalExpression
  // (`on && "x"`) — v0.2 refuses with `dynamic-uncertain-arg` instead of
  // the old blanket `dynamic-call-expression`.
  const src = `export default () => <div className={cn("p-4", true && "x")}>x</div>;\n`;
  await writeFixture("dynamic.tsx", src);

  const col = src.indexOf("<div");
  const r = await fetch(`${baseUrl}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify({
      file: "dynamic.tsx",
      line: 1,
      col,
      before: "p-4",
      after: "p-6",
    }),
  });
  assert.equal(r.status, 400);
  const body = (await r.json()) as {
    ok: boolean;
    reason: string;
    details: string;
  };
  assert.equal(body.ok, false);
  assert.equal(body.reason, "dynamic-uncertain-arg");
  assert.match(body.details, /cn/);

  const onDisk = await readFixture("dynamic.tsx");
  assert.equal(onDisk, src); // unchanged
});

// ---------------------------------------------------------------------------
// v0.2 B8 — generic attribute mutation (src, href, alt) + /assets
// ---------------------------------------------------------------------------

test("POST /apply with attribute='src' swaps a static src= value", async () => {
  const src = `export default () => <img src="/foo.png" alt="x" />;\n`;
  await writeFixture("img-1.tsx", src);
  const col = src.indexOf("<img");
  const r = await fetch(`${baseUrl}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify({
      file: "img-1.tsx",
      line: 1,
      col,
      attribute: "src",
      before: "/foo.png",
      after: "/bar.png",
    }),
  });
  assert.equal(r.status, 200);
  const onDisk = await readFixture("img-1.tsx");
  assert.match(onDisk, /src="\/bar.png"/);
  // alt unchanged.
  assert.match(onDisk, /alt="x"/);
});

test("POST /apply attribute='src' returns 409 when current value differs (conflict)", async () => {
  const src = `export default () => <img src="/foo.png" />;\n`;
  await writeFixture("img-conflict.tsx", src);
  const col = src.indexOf("<img");
  const r = await fetch(`${baseUrl}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify({
      file: "img-conflict.tsx",
      line: 1,
      col,
      attribute: "src",
      before: "/stale.png",
      after: "/new.png",
    }),
  });
  assert.equal(r.status, 409);
  const body = (await r.json()) as { reason: string };
  assert.equal(body.reason, "token-not-found");
});

test("POST /apply attribute='src' with before=null skips conflict check (picker UX)", async () => {
  const src = `export default () => <img src="/whatever-current.png" />;\n`;
  await writeFixture("img-null-before.tsx", src);
  const col = src.indexOf("<img");
  const r = await fetch(`${baseUrl}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify({
      file: "img-null-before.tsx",
      line: 1,
      col,
      attribute: "src",
      before: null,
      after: "/picked.png",
    }),
  });
  assert.equal(r.status, 200);
  const onDisk = await readFixture("img-null-before.tsx");
  assert.match(onDisk, /src="\/picked.png"/);
});

test("POST /apply attribute='src' refuses dynamic src expression", async () => {
  const src = `export default ({ img }: { img: string }) => <img src={img} />;\n`;
  await writeFixture("img-dyn.tsx", src);
  const col = src.indexOf("<img");
  const r = await fetch(`${baseUrl}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify({
      file: "img-dyn.tsx",
      line: 1,
      col,
      attribute: "src",
      before: null,
      after: "/picked.png",
    }),
  });
  assert.equal(r.status, 400);
  const body = (await r.json()) as { reason: string };
  assert.equal(body.reason, "dynamic-value");
});

test("GET /assets returns image files under workspace public/ folder", async () => {
  // Create a couple of fake images under workspace/public.
  await fs.mkdir(path.join(workspace, "public"), { recursive: true });
  await fs.writeFile(path.join(workspace, "public", "logo.png"), "");
  await fs.writeFile(path.join(workspace, "public", "hero.jpg"), "");
  await fs.writeFile(path.join(workspace, "public", "README.md"), "");

  const r = await authedFetch("/assets");
  assert.equal(r.status, 200);
  const body = (await r.json()) as { ok: boolean; assets: string[] };
  assert.equal(body.ok, true);
  // Sorted, only images.
  assert.ok(body.assets.includes("/hero.jpg"));
  assert.ok(body.assets.includes("/logo.png"));
  assert.ok(!body.assets.includes("/README.md"));
});

test("POST /apply succeeds on cn() with all-static args (v0.2 B1)", async () => {
  const src = `export default () => <div className={cn("p-4", "rounded")}>x</div>;\n`;
  await writeFixture("cn-static.tsx", src);

  const col = src.indexOf("<div");
  const r = await fetch(`${baseUrl}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify({
      file: "cn-static.tsx",
      line: 1,
      col,
      before: "p-4",
      after: "p-6",
    }),
  });
  assert.equal(r.status, 200);
  const onDisk = await readFixture("cn-static.tsx");
  assert.match(onDisk, /cn\("p-6", "rounded"\)/);
});

// ---------------------------------------------------------------------------
// Path safety: refuse paths that escape the workspace root
// ---------------------------------------------------------------------------

test("POST /apply returns 403 when file path tries to escape the workspace via ..", async () => {
  const r = await fetch(`${baseUrl}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify({
      file: "../../../etc/passwd",
      line: 1,
      col: 0,
      before: "root",
      after: "owned",
    }),
  });
  assert.equal(r.status, 403);
  const body = (await r.json()) as { ok: boolean; reason: string };
  assert.equal(body.reason, "path-outside-workspace");
});

test("POST /apply returns 403 for absolute paths outside the workspace", async () => {
  const r = await fetch(`${baseUrl}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify({
      file: "/etc/passwd",
      line: 1,
      col: 0,
      before: "root",
      after: "owned",
    }),
  });
  assert.equal(r.status, 403);
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test("POST /apply returns 400 for missing fields", async () => {
  const r = await fetch(`${baseUrl}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify({ file: "x.tsx" }),
  });
  assert.equal(r.status, 400);
  const body = (await r.json()) as { reason: string };
  assert.equal(body.reason, "invalid-input");
});

test("POST /apply returns 400 for malformed JSON", async () => {
  const r = await fetch(`${baseUrl}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
    body: "{not-json",
  });
  assert.equal(r.status, 400);
  const body = (await r.json()) as { reason: string };
  assert.equal(body.reason, "invalid-json");
});

// ---------------------------------------------------------------------------
// Missing file
// ---------------------------------------------------------------------------

test("POST /apply returns 404 when the file does not exist", async () => {
  const r = await fetch(`${baseUrl}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify({
      file: "does-not-exist.tsx",
      line: 1,
      col: 0,
      before: "p-4",
      after: "p-6",
    }),
  });
  assert.equal(r.status, 404);
  const body = (await r.json()) as { reason: string };
  assert.equal(body.reason, "file-not-found");
});

// ---------------------------------------------------------------------------
// CORS preflight
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Auth — session token required on writes; /health and /token open
// ---------------------------------------------------------------------------

test("GET /health does NOT require the bearer token", async () => {
  const r = await fetch(`${baseUrl}/health`);
  assert.equal(r.status, 200);
});

test("GET /token returns the in-memory session token (open endpoint)", async () => {
  const r = await fetch(`${baseUrl}/token`);
  assert.equal(r.status, 200);
  const body = (await r.json()) as { token: string };
  assert.equal(body.token, TEST_TOKEN);
});

test("POST /apply returns 401 without an Authorization header", async () => {
  const r = await fetch(`${baseUrl}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      file: "x.tsx",
      line: 1,
      col: 0,
      before: "p-4",
      after: "p-6",
    }),
  });
  assert.equal(r.status, 401);
  const body = (await r.json()) as { reason: string };
  assert.equal(body.reason, "unauthorized");
});

test("POST /apply returns 401 with an incorrect bearer token", async () => {
  const r = await fetch(`${baseUrl}/apply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer wrong-token",
    },
    body: JSON.stringify({
      file: "x.tsx",
      line: 1,
      col: 0,
      before: "p-4",
      after: "p-6",
    }),
  });
  assert.equal(r.status, 401);
});

test("GET /selection also requires the bearer token", async () => {
  const r = await fetch(`${baseUrl}/selection`);
  assert.equal(r.status, 401);
});

test("OPTIONS preflight returns 204 with permissive CORS headers", async () => {
  const r = await fetch(`${baseUrl}/apply`, { method: "OPTIONS" });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.match(
    r.headers.get("access-control-allow-methods") ?? "",
    /POST/,
  );
});

// ---------------------------------------------------------------------------
// /revert + recent-applies buffer
// ---------------------------------------------------------------------------

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

async function authedFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
}

test("POST /revert with no body undoes the most-recent /apply", async () => {
  const src = `export default () => <div className="p-4">x</div>;\n`;
  await writeFixture("revert-1.tsx", src);
  const col = src.indexOf("<div");

  // Apply: p-4 → p-6
  const apply = await postJson("/apply", {
    file: "revert-1.tsx",
    line: 1,
    col,
    before: "p-4",
    after: "p-6",
  });
  assert.equal(apply.status, 200);
  assert.match(await readFixture("revert-1.tsx"), /className="p-6"/);

  // Revert with no body: undoes the most-recent apply.
  const revert = await postJson("/revert", {});
  assert.equal(revert.status, 200);
  const body = (await revert.json()) as { ok: boolean; diff: string };
  assert.equal(body.ok, true);
  assert.match(body.diff, /-.*p-6/);
  assert.match(body.diff, /\+.*p-4/);

  // File restored to original.
  assert.equal(await readFixture("revert-1.tsx"), src);
});

test("POST /revert with file/line/col targets a specific recent apply", async () => {
  // Two files, two applies. Revert by specifying the older one.
  const srcA = `export default () => <div className="p-4">A</div>;\n`;
  const srcB = `export default () => <span className="m-2">B</span>;\n`;
  await writeFixture("revert-a.tsx", srcA);
  await writeFixture("revert-b.tsx", srcB);

  await postJson("/apply", {
    file: "revert-a.tsx",
    line: 1,
    col: srcA.indexOf("<div"),
    before: "p-4",
    after: "p-6",
  });
  await postJson("/apply", {
    file: "revert-b.tsx",
    line: 1,
    col: srcB.indexOf("<span"),
    before: "m-2",
    after: "m-4",
  });

  // Revert the EARLIER apply (file A), not the latest.
  const revert = await postJson("/revert", {
    file: "revert-a.tsx",
    line: 1,
    col: srcA.indexOf("<div"),
  });
  assert.equal(revert.status, 200);

  assert.equal(await readFixture("revert-a.tsx"), srcA);
  // File B should still be in its post-apply state.
  assert.match(await readFixture("revert-b.tsx"), /className="m-4"/);
});

test("POST /revert returns 404 when no recent applies exist", async () => {
  recentApplies.clear();
  const r = await postJson("/revert", {});
  assert.equal(r.status, 404);
  const body = (await r.json()) as { reason: string };
  assert.equal(body.reason, "no-recent-apply");
});

test("POST /revert returns 409 if file was edited externally since the apply", async () => {
  const src = `export default () => <div className="p-4">x</div>;\n`;
  await writeFixture("revert-conflict.tsx", src);
  const col = src.indexOf("<div");

  await postJson("/apply", {
    file: "revert-conflict.tsx",
    line: 1,
    col,
    before: "p-4",
    after: "p-6",
  });
  // Now the file has p-6. Simulate an IDE edit that changes it to p-8.
  await writeFixture(
    "revert-conflict.tsx",
    `export default () => <div className="p-8">x</div>;\n`,
  );

  // Revert tries to swap p-6 → p-4, but the file no longer has p-6.
  const revert = await postJson("/revert", {});
  assert.equal(revert.status, 409);
  const body = (await revert.json()) as { reason: string };
  assert.equal(body.reason, "token-not-found");
});

test("POST /revert returns 400 with `invalid-input` when only some of file/line/col are present", async () => {
  const r = await postJson("/revert", { file: "x.tsx" });
  assert.equal(r.status, 400);
  const body = (await r.json()) as { reason: string };
  assert.equal(body.reason, "invalid-input");
});

// ---------------------------------------------------------------------------
// /selection — overlay-pushed state, read by MCP get_selected_element
// ---------------------------------------------------------------------------

test("GET /selection returns null when no overlay has reported a selection", async () => {
  // (Selection state lives in CurrentSelection; the test starts with it empty.)
  const r = await authedFetch("/selection");
  assert.equal(r.status, 200);
  const body = (await r.json()) as {
    ok: boolean;
    selection: unknown | null;
  };
  assert.equal(body.ok, true);
  assert.equal(body.selection, null);
});

test("POST /selection stores the payload; GET /selection returns it back", async () => {
  const payload = {
    file: "app/page.tsx",
    line: 11,
    col: 6,
    oid: "app/page.tsx:11:6",
    className: "mt-8 w-32 h-16 p-4",
    tagName: "div",
    componentName: "Page",
    instanceCount: 1,
  };
  const post = await postJson("/selection", payload);
  assert.equal(post.status, 200);

  const get = await authedFetch("/selection");
  const body = (await get.json()) as {
    ok: boolean;
    selection: typeof payload;
  };
  assert.deepEqual(body.selection, payload);
});

test("DELETE /selection clears the state", async () => {
  // (Previous test populated it.)
  const del = await authedFetch("/selection", { method: "DELETE" });
  assert.equal(del.status, 200);
  const get = await authedFetch("/selection");
  const body = (await get.json()) as { selection: unknown | null };
  assert.equal(body.selection, null);
});

test("POST /selection returns 400 with `invalid-input` for malformed payload", async () => {
  const r = await postJson("/selection", { file: "x.tsx" });
  assert.equal(r.status, 400);
  const body = (await r.json()) as { reason: string };
  assert.equal(body.reason, "invalid-input");
});

test("GET /recent lists the buffer contents", async () => {
  recentApplies.clear();
  const src = `export default () => <div className="p-4">x</div>;\n`;
  await writeFixture("recent-1.tsx", src);
  await postJson("/apply", {
    file: "recent-1.tsx",
    line: 1,
    col: src.indexOf("<div"),
    before: "p-4",
    after: "p-6",
  });

  const r = await authedFetch("/recent");
  assert.equal(r.status, 200);
  const body = (await r.json()) as {
    ok: boolean;
    applies: Array<{ file: string; before: string; after: string }>;
  };
  assert.equal(body.ok, true);
  assert.equal(body.applies.length, 1);
  assert.equal(body.applies[0]!.file, "recent-1.tsx");
  assert.equal(body.applies[0]!.before, "p-4");
  assert.equal(body.applies[0]!.after, "p-6");
});
