#!/usr/bin/env node
/**
 * visual-editor MCP stdio server.
 *
 * Thin proxy to the visual-editor API (the Next.js Route Handler at
 * http://localhost:3000/api/visual-editor by default, or the standalone
 * server at http://127.0.0.1:7790). Exposes eight tools:
 *
 *   get_selected_element   what the user is looking at + pins + recent edits
 *   propose_change         diff a token/attribute swap without writing
 *   apply_change           write a token/attribute swap to disk
 *   revert_change          undo an applied change
 *   apply_css_property     CSS Modules write-back
 *   apply_styled_property  styled-components write-back
 *   highlight_element      flash an outline in the browser ("this one?")
 *   resolve_pin            mark a user's pin as handled
 *
 * IMPORTANT: never call `console.log` or write to stdout outside of the
 * MCP transport. Stdout is the JSON-RPC channel and any extra bytes corrupt
 * the framing. Diagnostics go to stderr via `console.error`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SERVER_URL = (
  process.env.VISUAL_EDITOR_SERVER_URL ?? "http://localhost:3000/api/visual-editor"
).replace(/\/+$/, "");

// Token resolution: explicit env > workspace session.json > GET /token > none.
// The Route Handler transport returns token=null (same-origin trust); the
// standalone server mints one into <workspace>/.visual-editor/session.json.
async function resolveToken(): Promise<string | null> {
  if (process.env.VISUAL_EDITOR_TOKEN) return process.env.VISUAL_EDITOR_TOKEN;
  const workspace = process.env.VISUAL_EDITOR_WORKSPACE_ROOT ?? process.cwd();
  try {
    const filePath = path.join(workspace, ".visual-editor", "session.json");
    const json = JSON.parse(await fs.readFile(filePath, "utf8")) as { token?: unknown };
    if (typeof json.token === "string") return json.token;
  } catch {
    /* fall through to /token endpoint */
  }
  try {
    const r = await fetch(`${SERVER_URL}/token`);
    if (!r.ok) return null;
    const body = (await r.json()) as { token?: string | null };
    return typeof body.token === "string" ? body.token : null;
  } catch {
    return null;
  }
}

let cachedToken: string | null | undefined;
async function getToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;
  cachedToken = await resolveToken();
  return cachedToken;
}

const server = new McpServer({ name: "visual-editor", version: "0.3.0" });

// Shared helpers ------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const ok = (body: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }],
});
const fail = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

const UNREACHABLE =
  `Could not reach the visual-editor API at ${SERVER_URL}. ` +
  "Is the dev server running with visual-editor set up (withVisualEditor + the Route Handler), " +
  "or `npx visual-editor-server` for other frameworks? Set VISUAL_EDITOR_SERVER_URL if it lives elsewhere.";

async function callServer(
  endpoint: string,
  init: { method: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> =
    init.body !== undefined ? { "Content-Type": "application/json" } : {};
  const token = await getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${SERVER_URL}${endpoint}`, {
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

async function proxy(endpoint: string, init: { method: string; body?: unknown }): Promise<ToolResult> {
  try {
    const { status, body } = await callServer(endpoint, init);
    if (status >= 200 && status < 300) return ok(body);
    return fail(`HTTP ${status}: ${JSON.stringify(body)}`);
  } catch (err) {
    return fail(`${UNREACHABLE} (${(err as Error).message})`);
  }
}

// Tools ---------------------------------------------------------------------

server.registerTool(
  "get_selected_element",
  {
    description:
      "What the user is looking at in the browser overlay. Returns `selection` (the clicked element: " +
      "tag, component, DOM className, instance count, computed styles, ancestors, the user's note, and " +
      "`refs` — one entry per source location: `host` = the element inside the component file, `call` = " +
      "where the component was used. Each ref has file/line/col, the enclosing component name, " +
      "className kind + static tokens, `editable`, a `reason` when not, and a source `snippet`), " +
      "`pins` (elements the user annotated for you, oldest first, with status), and `recent` applied edits. " +
      "Call this first. To change a class token, call apply_change with the file/line/col of the ref whose " +
      "tokens contain it (the call site wins over the component when both have it).",
    inputSchema: {
      include_pin_snippets: z
        .boolean()
        .optional()
        .describe("Include source snippets for every pin (default false; the selection always has them)."),
    },
  },
  async (args): Promise<ToolResult> => {
    try {
      const { status, body } = await callServer("/context", { method: "GET" });
      if (status !== 200) return fail(`HTTP ${status}: ${JSON.stringify(body)}`);
      const ctx = body as {
        selection?: unknown;
        pins?: Array<{ selection?: { refs?: Array<Record<string, unknown>> } }>;
      };
      if (!args.include_pin_snippets && Array.isArray(ctx.pins)) {
        for (const pin of ctx.pins) {
          for (const ref of pin.selection?.refs ?? []) {
            delete ref.snippet;
            delete ref.snippetTruncated;
          }
        }
      }
      return ok(body);
    } catch (err) {
      return fail(`${UNREACHABLE} (${(err as Error).message})`);
    }
  },
);

const mutationInputShape = {
  file: z.string().describe("Workspace-relative file path (from the ref)."),
  line: z.number().int().positive().describe("1-based JSXOpeningElement line."),
  col: z.number().int().min(0).describe("0-based JSXOpeningElement column."),
  before: z
    .string()
    .nullable()
    .describe(
      "Exact current class token to swap, e.g. 'p-4'. For non-className attributes: the whole current value, or null to skip the conflict check.",
    ),
  after: z.string().describe("Replacement token, e.g. 'p-6' (or the whole new attribute value)."),
  attribute: z
    .string()
    .optional()
    .describe("Attribute to mutate. Default 'className' (token swap). Anything else (src, href, alt, …) swaps the whole value."),
};

server.registerTool(
  "propose_change",
  {
    description:
      "Diff a class-token (or attribute) swap WITHOUT writing. Returns a unified diff. Refuses when the " +
      "token isn't a provable static literal (cn()/clsx() with dynamic args, template literals, conditionals, " +
      "spreads, tailwind-merge conflicts) with a structured `reason` — surface it verbatim, don't work around it.",
    inputSchema: mutationInputShape,
  },
  async (args): Promise<ToolResult> => proxy("/propose", { method: "POST", body: args }),
);

server.registerTool(
  "apply_change",
  {
    description:
      "Write a class-token (or attribute) swap to disk. Conflict-checked: 409 `token-not-found` when the file " +
      "no longer has `before` at line:col (edited since the user staged it). Recorded in the undo history; the " +
      "overlay repaints via Fast Refresh.",
    inputSchema: mutationInputShape,
  },
  async (args): Promise<ToolResult> => proxy("/apply", { method: "POST", body: args }),
);

server.registerTool(
  "revert_change",
  {
    description:
      "Undo a previously applied change. No args = the most recent one; pass {file, line, col} for a specific older one. 404 when not in history.",
    inputSchema: {
      file: z.string().optional(),
      line: z.number().int().positive().optional(),
      col: z.number().int().min(0).optional(),
    },
  },
  async (args): Promise<ToolResult> => proxy("/revert", { method: "POST", body: args }),
);

const cssInputShape = {
  file: z.string().describe("Workspace-relative path to the JSX file containing the element"),
  line: z.number().int().positive(),
  col: z.number().int().min(0),
  property: z.string().describe("CSS property to set, e.g. 'padding', 'background-color'"),
  value: z.string().describe("New value, e.g. '1.5rem', '#fff'"),
};

server.registerTool(
  "apply_css_property",
  {
    description:
      "Set a CSS property on the rule a JSX element's CSS Module className points at (`<div className={styles.foo}>` → " +
      "`.foo` in the imported `.module.css`). Updates or inserts the declaration. Refuses non-`{styles.x}` classNames, " +
      "`composes:` chains, and non-`.module.css` imports.",
    inputSchema: cssInputShape,
  },
  async (args): Promise<ToolResult> => proxy("/apply-css-prop", { method: "POST", body: args }),
);

server.registerTool(
  "apply_styled_property",
  {
    description:
      "Set a CSS property on a same-file, fully-static styled-components definition (`const Button = styled.button\\`…\\``) " +
      "used at the given JSX location. Refuses `${…}` interpolations, `.attrs()`/`.withConfig()`, `styled(Base)`, and cross-file definitions.",
    inputSchema: cssInputShape,
  },
  async (args): Promise<ToolResult> => proxy("/apply-styled-prop", { method: "POST", body: args }),
);

server.registerTool(
  "highlight_element",
  {
    description:
      "Flash a pulsing outline in the user's browser on every DOM node rendered from a source location, with a short label " +
      "(e.g. 'this card?'). Use it to confirm you're about to edit the right thing, or to show where a change landed. " +
      "Returns delivered=false when no overlay tab is connected.",
    inputSchema: {
      file: z.string(),
      line: z.number().int().positive(),
      col: z.number().int().min(0),
      attribute: z
        .enum(["data-oid", "data-oid-call"])
        .optional()
        .describe("Match the host element (default) or the component call site."),
      label: z.string().max(120).optional(),
      durationMs: z.number().int().positive().max(60000).optional().describe("Default 4000."),
    },
  },
  async (args): Promise<ToolResult> => proxy("/highlight", { method: "POST", body: args }),
);

server.registerTool(
  "resolve_pin",
  {
    description:
      "Mark one of the user's pins as handled (the overlay turns it green and notifies them). Pass a one-line `resolution` " +
      "saying what you changed. Call it after the edit is applied, not before.",
    inputSchema: {
      id: z.string().describe("Pin id from get_selected_element."),
      resolution: z.string().max(300).optional(),
    },
  },
  async (args): Promise<ToolResult> => proxy("/pins/resolve", { method: "POST", body: args }),
);

// Connect ----------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
// No further output here — anything to stdout would corrupt the JSON-RPC channel.
