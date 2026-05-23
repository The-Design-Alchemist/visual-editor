import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "../src/http/server.ts";
import { SessionToken } from "../src/state/auth.ts";
import type { Server } from "node:http";

let server: Server;
let baseUrl: string;
let workspace: string;
const sessionToken = new SessionToken();
const TOKEN = "origin-test-token-1234";
sessionToken.setInMemory(TOKEN);

before(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "visual-edit-origin-"));
  server = createServer({
    workspaceRoot: workspace,
    sessionToken,
    allowedOrigins: ["http://localhost:3000", "http://localhost:3001"],
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(workspace, { recursive: true, force: true });
});

test("origin allowlist: an allowed origin can hit /token", async () => {
  const r = await fetch(`${baseUrl}/token`, {
    headers: { Origin: "http://localhost:3000" },
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { token: string };
  assert.equal(body.token, TOKEN);
  // CORS header should echo the actual origin, not "*", when an allowlist is set.
  assert.equal(
    r.headers.get("access-control-allow-origin"),
    "http://localhost:3000",
  );
});

test("origin allowlist: a disallowed origin is refused on /token (closes the bootstrap hole)", async () => {
  const r = await fetch(`${baseUrl}/token`, {
    headers: { Origin: "http://localhost:9999" },
  });
  assert.equal(r.status, 403);
  const body = (await r.json()) as { reason: string };
  assert.equal(body.reason, "origin-not-allowed");
});

test("origin allowlist: a request with no Origin header is also refused (when allowlist is set)", async () => {
  const r = await fetch(`${baseUrl}/token`);
  // No Origin header — refused.
  assert.equal(r.status, 403);
});

test("origin allowlist: /health is always reachable regardless of origin", async () => {
  const r = await fetch(`${baseUrl}/health`, {
    headers: { Origin: "http://malicious.example" },
  });
  assert.equal(r.status, 200);
});

test("origin allowlist: writes also fail with wrong origin", async () => {
  const r = await fetch(`${baseUrl}/apply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      Origin: "http://malicious.example",
    },
    body: JSON.stringify({
      file: "x.tsx",
      line: 1,
      col: 0,
      before: "p-4",
      after: "p-6",
    }),
  });
  assert.equal(r.status, 403);
  const body = (await r.json()) as { reason: string };
  assert.equal(body.reason, "origin-not-allowed");
});
