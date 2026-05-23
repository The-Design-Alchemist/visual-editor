#!/usr/bin/env node
/**
 * Visual-edit MCP stdio server.
 *
 * Thin proxy to the local HTTP server (default http://127.0.0.1:7790).
 * Exposes four tools to Claude Code (or any MCP client):
 *
 *   - get_selected_element : read the overlay's current selection
 *   - propose_change       : diff a className mutation without writing
 *   - apply_change         : write the mutation to disk
 *   - revert_change        : undo the most-recent apply (or by location)
 *
 * IMPORTANT: never call `console.log` or write to stdout outside of the
 * MCP transport. Stdout is the JSON-RPC channel and any extra bytes corrupt
 * the framing. Diagnostics go to stderr via `console.error`.
 *
 * Register with Claude Code:
 *   claude mcp add visual-editor -- node --import tsx /abs/path/packages/mcp/src/server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SERVER_URL =
  process.env.VISUAL_EDITOR_SERVER_URL ?? "http://127.0.0.1:7790";

// Token resolution: explicit env > workspace session.json > GET /token > none.
// The workspace path is the same one the HTTP server's CLI was started with;
// MCP clients pass it via VISUAL_EDITOR_WORKSPACE_ROOT.
async function resolveToken(): Promise<string | null> {
  if (process.env.VISUAL_EDITOR_TOKEN) return process.env.VISUAL_EDITOR_TOKEN;

  const workspace =
    process.env.VISUAL_EDITOR_WORKSPACE_ROOT ?? process.cwd();
  try {
    const filePath = path.join(workspace, ".visual-editor", "session.json");
    const json = JSON.parse(await fs.readFile(filePath, "utf8")) as {
      token?: unknown;
    };
    if (typeof json.token === "string") return json.token;
  } catch {
    /* fall through to /token endpoint */
  }

  try {
    const r = await fetch(`${SERVER_URL}/token`);
    if (!r.ok) return null;
    const body = (await r.json()) as { token?: string };
    return typeof body.token === "string" ? body.token : null;
  } catch {
    return null;
  }
}

let cachedToken: string | null = null;
async function getToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  cachedToken = await resolveToken();
  return cachedToken;
}

const server = new McpServer({
  name: "visual-editor",
  version: "0.0.1",
});

// Shared helpers ------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

async function callServer(
  path: string,
  init: { method: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> =
    init.body !== undefined ? { "Content-Type": "application/json" } : {};
  const token = await getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: init.method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON; keep raw text */
  }
  return { status: res.status, body };
}

// Tools ---------------------------------------------------------------------

server.registerTool(
  "get_selected_element",
  {
    description:
      "Read the element the user has currently selected in the browser overlay. " +
      "Returns the source location (file, line, col), data-oid, className string, " +
      "tag name, component name, and how many DOM instances share this source (Principle 11). " +
      "Returns selection=null when nothing is selected.",
    inputSchema: {},
  },
  async (): Promise<ToolResult> => {
    try {
      const { status, body } = await callServer("/selection", { method: "GET" });
      if (status !== 200) return fail(`HTTP ${status}: ${JSON.stringify(body)}`);
      return ok(JSON.stringify(body));
    } catch (err) {
      return fail(
        `Could not reach visual-editor server at ${SERVER_URL}: ${(err as Error).message}. ` +
          `Is it running? \`npx tsx packages/server/src/cli.ts --port 7790 --workspace .\``,
      );
    }
  },
);

const mutationInputShape = {
  file: z.string().describe("Workspace-relative file path (from data-oid)."),
  line: z.number().int().positive().describe("1-based JSXOpeningElement line."),
  col: z.number().int().min(0).describe("0-based JSXOpeningElement column."),
  before: z
    .string()
    .describe("Exact static className token to swap, e.g. 'p-4'."),
  after: z.string().describe("Replacement token, e.g. 'p-6'."),
};

server.registerTool(
  "propose_change",
  {
    description:
      "Diff a className mutation WITHOUT writing it. Returns a unified diff for review. " +
      "Refuses dynamic-className contexts (cn/clsx/twMerge/cva/spread/template-literal/conditional) " +
      "with a structured reason — see the `details` field on errors.",
    inputSchema: mutationInputShape,
  },
  async (args): Promise<ToolResult> => {
    try {
      const { status, body } = await callServer("/propose", {
        method: "POST",
        body: args,
      });
      if (status === 200) return ok(JSON.stringify(body));
      return fail(`HTTP ${status}: ${JSON.stringify(body)}`);
    } catch (err) {
      return fail(`Could not reach visual-editor server: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "apply_change",
  {
    description:
      "Apply a className mutation to disk. Conflict-checked: returns 409 if the file's " +
      "current state no longer contains `before` at line:col (i.e. the IDE edited it " +
      "between drag and apply). The successful apply is recorded in the revert history.",
    inputSchema: mutationInputShape,
  },
  async (args): Promise<ToolResult> => {
    try {
      const { status, body } = await callServer("/apply", {
        method: "POST",
        body: args,
      });
      if (status === 200) return ok(JSON.stringify(body));
      return fail(`HTTP ${status}: ${JSON.stringify(body)}`);
    } catch (err) {
      return fail(`Could not reach visual-editor server: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "revert_change",
  {
    description:
      "Undo a previously applied mutation. Call with no args to undo the most-recent " +
      "apply, or pass {file, line, col} to undo a specific older one. Returns 404 if " +
      "the history buffer doesn't contain a matching entry.",
    inputSchema: {
      file: z.string().optional(),
      line: z.number().int().positive().optional(),
      col: z.number().int().min(0).optional(),
    },
  },
  async (args): Promise<ToolResult> => {
    try {
      const { status, body } = await callServer("/revert", {
        method: "POST",
        body: args,
      });
      if (status === 200) return ok(JSON.stringify(body));
      return fail(`HTTP ${status}: ${JSON.stringify(body)}`);
    } catch (err) {
      return fail(`Could not reach visual-editor server: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "apply_styled_property",
  {
    description:
      "Set a CSS property on a styled-components definition. Resolves `<Button>` " +
      "to its same-file `const Button = styled.tagname\\`...\\`` and updates or " +
      "inserts the property in the template's static text. Refuses on `${...}` " +
      "interpolations, `.attrs()` / `.withConfig()` chains, `styled(Base)` " +
      "extension form, or cross-file styled definitions.",
    inputSchema: {
      file: z
        .string()
        .describe("Workspace-relative path to the JSX file (must also contain the styled defn)"),
      line: z.number().int().positive(),
      col: z.number().int().min(0),
      property: z
        .string()
        .describe("CSS property to set, e.g. 'padding', 'background'"),
      value: z.string().describe("New value, e.g. '1.5rem', '#fff'"),
    },
  },
  async (args): Promise<ToolResult> => {
    try {
      const { status, body } = await callServer("/apply-styled-prop", {
        method: "POST",
        body: args,
      });
      if (status === 200) return ok(JSON.stringify(body));
      return fail(`HTTP ${status}: ${JSON.stringify(body)}`);
    } catch (err) {
      return fail(`Could not reach visual-editor server: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "apply_css_property",
  {
    description:
      "Set a CSS property on the rule referenced by a JSX element's CSS Module " +
      "className. Resolves `<div className={styles.foo}>` to its `./Foo.module.css` " +
      "file, finds the `.foo` rule, and updates or inserts the property. Refuses " +
      "when the className isn't a `{identifier.property}` member expression, when " +
      "the rule has a `composes:` chain (could leak), or when the import isn't a " +
      "`.module.css` file.",
    inputSchema: {
      file: z
        .string()
        .describe("Workspace-relative path to the JSX file containing the element"),
      line: z.number().int().positive(),
      col: z.number().int().min(0),
      property: z
        .string()
        .describe("CSS property to set, e.g. 'padding', 'background-color'"),
      value: z.string().describe("New value, e.g. '1.5rem', '#fff'"),
    },
  },
  async (args): Promise<ToolResult> => {
    try {
      const { status, body } = await callServer("/apply-css-prop", {
        method: "POST",
        body: args,
      });
      if (status === 200) return ok(JSON.stringify(body));
      return fail(`HTTP ${status}: ${JSON.stringify(body)}`);
    } catch (err) {
      return fail(`Could not reach visual-editor server: ${(err as Error).message}`);
    }
  },
);

// Connect ----------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
// No further output here — anything to stdout would corrupt the JSON-RPC channel.
