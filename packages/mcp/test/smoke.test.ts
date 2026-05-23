import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { createServer } from "../../server/src/http/server.ts";
import { CurrentSelection } from "../../server/src/state/selection.ts";
import { SessionToken } from "../../server/src/state/auth.ts";
import type { Server } from "node:http";

// We boot a local HTTP server in-process (random port) and point the MCP
// child at it via VISUAL_EDIT_SERVER_URL. This way the smoke test doesn't
// require the CLI to be running ambiently.

let httpServer: Server;
let httpUrl: string;
let workspace: string;
const selection = new CurrentSelection();
const sessionToken = new SessionToken();
const TEST_TOKEN = "smoke-token-deadbeef-cafe-1234";
sessionToken.setInMemory(TEST_TOKEN);

let mcpProcess: ChildProcess;
let mcpStderr = "";
let nextId = 1;
type PendingRpc = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};
const pending = new Map<number, PendingRpc>();
let stdoutBuffer = "";

function sendRpc(method: string, params: object): Promise<unknown> {
  const id = nextId++;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    mcpProcess.stdin!.write(msg);
  });
}

function sendNotification(method: string, params: object): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
  mcpProcess.stdin!.write(msg);
}

before(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "visual-edit-mcp-test-"));
  httpServer = createServer({
    workspaceRoot: workspace,
    currentSelection: selection,
    sessionToken,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const addr = httpServer.address();
  if (typeof addr === "object" && addr) {
    httpUrl = `http://127.0.0.1:${addr.port}`;
  } else {
    throw new Error("HTTP server bound but no port?");
  }

  const serverPath = path.resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "../src/server.ts",
  );

  mcpProcess = spawn(
    process.execPath,
    ["--import", "tsx", serverPath],
    {
      env: {
        ...process.env,
        VISUAL_EDIT_SERVER_URL: httpUrl,
        VISUAL_EDIT_TOKEN: TEST_TOKEN,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  mcpProcess.stdout!.setEncoding("utf8");
  mcpProcess.stdout!.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let idx;
    while ((idx = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, idx);
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: { id?: number; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        // Anything non-JSON on stdout is a contract violation.
        throw new Error(`MCP stdout produced non-JSON: ${line}`);
      }
      if (typeof msg.id === "number") {
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        if (msg.error) p.reject(msg.error);
        else p.resolve(msg.result);
      }
    }
  });
  mcpProcess.stderr!.setEncoding("utf8");
  mcpProcess.stderr!.on("data", (chunk: string) => {
    mcpStderr += chunk;
  });

  // MCP handshake: initialize → initialized notification.
  await sendRpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.0" },
  });
  sendNotification("notifications/initialized", {});
});

after(async () => {
  mcpProcess.kill();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await fs.rm(workspace, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

test("tools/list returns the visual-edit tools (6 in v0.2 B3a)", async () => {
  const result = (await sendRpc("tools/list", {})) as {
    tools: Array<{ name: string; description: string }>;
  };
  const names = result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "apply_change",
    "apply_css_property",
    "apply_styled_property",
    "get_selected_element",
    "propose_change",
    "revert_change",
  ]);
});

test("get_selected_element returns null when no overlay has reported a selection", async () => {
  selection.clear();
  const result = (await sendRpc("tools/call", {
    name: "get_selected_element",
    arguments: {},
  })) as { content: Array<{ text: string }> };
  const body = JSON.parse(result.content[0]!.text) as {
    ok: boolean;
    selection: unknown | null;
  };
  assert.equal(body.selection, null);
});

test("get_selected_element returns the overlay's pushed state", async () => {
  selection.set({
    file: "app/page.tsx",
    line: 11,
    col: 6,
    oid: "app/page.tsx:11:6",
    className: "mt-8 w-32 h-16 p-4 m-4 bg-amber-300",
    tagName: "div",
    componentName: "Page",
    instanceCount: 1,
  });
  const result = (await sendRpc("tools/call", {
    name: "get_selected_element",
    arguments: {},
  })) as { content: Array<{ text: string }> };
  const body = JSON.parse(result.content[0]!.text) as {
    selection: { file: string; line: number; before?: string };
  };
  assert.equal(body.selection.file, "app/page.tsx");
  assert.equal(body.selection.line, 11);
});

test("apply_change mutates a real file and propose_change does not", async () => {
  const src = `export default () => <div className="p-4">x</div>;\n`;
  const fixture = path.join(workspace, "page.tsx");
  await fs.writeFile(fixture, src, "utf8");
  const col = src.indexOf("<div");

  // propose first
  const proposeRes = (await sendRpc("tools/call", {
    name: "propose_change",
    arguments: {
      file: "page.tsx",
      line: 1,
      col,
      before: "p-4",
      after: "p-6",
    },
  })) as { content: Array<{ text: string }> };
  const proposeBody = JSON.parse(proposeRes.content[0]!.text) as {
    ok: boolean;
    diff: string;
  };
  assert.equal(proposeBody.ok, true);
  assert.match(proposeBody.diff, /\+.*p-6/);

  // File unchanged after propose
  assert.equal(await fs.readFile(fixture, "utf8"), src);

  // Apply for real
  const applyRes = (await sendRpc("tools/call", {
    name: "apply_change",
    arguments: {
      file: "page.tsx",
      line: 1,
      col,
      before: "p-4",
      after: "p-6",
    },
  })) as { content: Array<{ text: string }> };
  const applyBody = JSON.parse(applyRes.content[0]!.text) as {
    ok: boolean;
    diff: string;
  };
  assert.equal(applyBody.ok, true);

  const onDisk = await fs.readFile(fixture, "utf8");
  assert.match(onDisk, /className="p-6"/);
});

test("revert_change undoes the most-recent apply", async () => {
  const fixture = path.join(workspace, "page.tsx");
  // Previous test left it at p-6. Revert should restore to p-4.
  const revertRes = (await sendRpc("tools/call", {
    name: "revert_change",
    arguments: {},
  })) as { content: Array<{ text: string }> };
  const body = JSON.parse(revertRes.content[0]!.text) as {
    ok: boolean;
    diff: string;
  };
  assert.equal(body.ok, true);

  const onDisk = await fs.readFile(fixture, "utf8");
  assert.match(onDisk, /className="p-4"/);
});

test("apply_change refuses a dynamic className with isError + structured reason (v0.2 B1)", async () => {
  // v0.2 B1: simple cn("p-4") is now MUTATABLE. The refusal-with-reason
  // contract is now tested via a dynamic OTHER arg (LogicalExpression).
  const src = `export default ({ on }: { on: boolean }) =>
    <div className={cn("p-4", on && "p-8")}>x</div>;\n`;
  const fixture = path.join(workspace, "dynamic.tsx");
  await fs.writeFile(fixture, src, "utf8");
  // The `<div` is on line 2, indented 4 spaces.
  const line = 2;
  const col = src.split("\n")[1]!.indexOf("<div");

  const result = (await sendRpc("tools/call", {
    name: "apply_change",
    arguments: {
      file: "dynamic.tsx",
      line,
      col,
      before: "p-4",
      after: "p-6",
    },
  })) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /dynamic-uncertain-arg/);

  // File unchanged.
  assert.equal(await fs.readFile(fixture, "utf8"), src);
});

test("MCP child never wrote non-JSON to stdout (contract for stdio MCP)", () => {
  // If stdout had non-JSON, the handler would have thrown. Reaching here is
  // the assertion. We also report stderr if anything was printed, since
  // tooling sometimes emits warnings even when the contract is honored.
  assert.equal(mcpStderr.includes("Error"), false, `stderr had errors: ${mcpStderr}`);
});
