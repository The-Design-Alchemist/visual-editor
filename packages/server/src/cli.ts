#!/usr/bin/env node
import * as path from "node:path";
import { createServer } from "./http/server.ts";
import { SessionToken } from "./state/auth.ts";
import { RecentApplies } from "./state/recentApplies.ts";

const DEFAULT_PORT = 7790;

const args = process.argv.slice(2);
let port = DEFAULT_PORT;
let workspaceRoot = process.cwd();
const allowedOrigins: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--port" || arg === "-p") {
    const v = args[++i];
    if (!v) throw new Error("--port requires a value");
    port = Number(v);
    if (!Number.isInteger(port) || port < 0) {
      throw new Error(`Invalid --port: ${v}`);
    }
  } else if (arg === "--workspace" || arg === "-w") {
    const v = args[++i];
    if (!v) throw new Error("--workspace requires a value");
    workspaceRoot = path.resolve(v);
  } else if (arg === "--allow-origin") {
    const v = args[++i];
    if (!v) throw new Error("--allow-origin requires a value");
    allowedOrigins.push(v);
  } else if (arg === "--help" || arg === "-h") {
    process.stdout.write(
      [
        "visual-edit server — local HTTP server that wraps deterministic",
        "className AST mutations behind /apply and /propose endpoints.",
        "",
        "Usage:",
        "  visual-edit-server [--port 7790] [--workspace .]",
        "                     [--allow-origin http://localhost:3000 ...]",
        "",
        "Endpoints:",
        "  GET  /health           — sanity ping",
        "  POST /apply            — write the mutated source to disk",
        "  POST /propose          — return the would-be source + diff, no write",
        "",
        "Request body for /apply and /propose:",
        '  { "file": "app/page.tsx", "line": 6, "col": 6,',
        '    "before": "p-4", "after": "p-6" }',
        "",
      ].join("\n"),
    );
    process.exit(0);
  }
}

const sessionToken = new SessionToken();
const token = await sessionToken.load(workspaceRoot);

const recentApplies = new RecentApplies();
await recentApplies.load(path.join(workspaceRoot, ".visual-edit", "history.json"));

const server = createServer({
  workspaceRoot,
  sessionToken,
  recentApplies,
  allowedOrigins,
});
server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const originSummary =
    allowedOrigins.length === 0
      ? "any (configure --allow-origin to restrict)"
      : allowedOrigins.join(", ");
  process.stdout.write(
    `visual-edit server listening on http://127.0.0.1:${actualPort}\n` +
      `  workspace: ${workspaceRoot}\n` +
      `  allowed origins: ${originSummary}\n` +
      `  session token: ${token.slice(0, 8)}… (written to ${path.join(workspaceRoot, ".visual-edit", "session.json")})\n`,
  );
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
