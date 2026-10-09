/**
 * visual-editor for Vite.
 *
 *   // vite.config.ts
 *   import react from "@vitejs/plugin-react";
 *   import { visualEditor } from "@aaqiljamal/visual-editor-vite";
 *   export default defineConfig({ plugins: [react(), visualEditor()] });
 *
 * Dev-only. Three things, nothing to add to your app code:
 *   1. `transform` (enforce: "pre") stamps data-oid / data-oid-call on JSX
 *      before @vitejs/plugin-react compiles it;
 *   2. `configureServer` mounts the AST-writer API at `/api/visual-editor`
 *      on the Vite dev server (same-origin, so no token/CORS);
 *   3. `transformIndexHtml` injects a module script that mounts the overlay.
 *
 * `vite build` is untouched: every hook checks the dev condition.
 */
import type { Plugin, ViteDevServer } from "vite";
import {
  createApiContext,
  createNodeHandler,
  type ApiContext,
} from "@aaqiljamal/visual-editor-server";
import {
  stampJsx,
  isStampablePath,
  resolveWorkspaceRoot,
} from "@aaqiljamal/visual-editor-server/transform";

export type VisualEditorViteOptions = {
  /**
   * Absolute path data-oid ids are relative to, and that the writer refuses
   * to escape. Defaults to the nearest workspace marker above the Vite root
   * (pnpm-workspace.yaml, turbo.json, lerna.json, nx.json, .git), else the
   * Vite root.
   */
  root?: string;
  /** URL prefix for the API on the dev server. Default "/api/visual-editor". */
  basePath?: string;
  /** Inject the overlay <script> into index.html. Default true. */
  injectOverlay?: boolean;
  /** Also run in `vite build`/preview (never recommended). Default false. */
  enabled?: boolean;
};

const CLIENT_ID = "virtual:visual-editor/client";
const RESOLVED_CLIENT_ID = "\0" + CLIENT_ID;

export function visualEditor(options: VisualEditorViteOptions = {}): Plugin {
  const basePath = (options.basePath ?? "/api/visual-editor").replace(/\/+$/, "");
  let active = false;
  let workspaceRoot = "";
  let ctx: ApiContext | null = null;

  return {
    name: "visual-editor",
    enforce: "pre",
    apply: options.enabled ? undefined : "serve",

    configResolved(config) {
      active = options.enabled ?? config.command === "serve";
      workspaceRoot = resolveWorkspaceRoot({
        explicit: options.root ?? null,
        cwd: config.root,
      });
      if (!process.env.VISUAL_EDITOR_WORKSPACE_ROOT) {
        process.env.VISUAL_EDITOR_WORKSPACE_ROOT = workspaceRoot;
      }
    },

    resolveId(id) {
      if (id === CLIENT_ID) return RESOLVED_CLIENT_ID;
      return null;
    },

    load(id) {
      if (id !== RESOLVED_CLIENT_ID) return null;
      return [
        `import { mountVisualEditor } from "@aaqiljamal/visual-editor-runtime/mount";`,
        `if (import.meta.env.DEV) mountVisualEditor({ serverUrl: ${JSON.stringify(basePath)} });`,
        "",
      ].join("\n");
    },

    transform(code, id) {
      if (!active) return null;
      const filename = id.split("?")[0] ?? id;
      if (!isStampablePath(filename)) return null;
      const result = stampJsx(code, { filename, root: workspaceRoot, sourceMap: true });
      if (!result.changed) return null;
      return {
        code: result.code,
        map: result.map ? JSON.parse(result.map.toString()) : null,
      };
    },

    transformIndexHtml(html) {
      if (!active || options.injectOverlay === false) return html;
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: { type: "module", src: `/@id/${CLIENT_ID}` },
            injectTo: "body",
          },
        ],
      };
    },

    configureServer(server: ViteDevServer) {
      if (!active) return;
      ctx = createApiContext({
        workspaceRoot,
        mode: "vite-middleware",
        persist: true,
      });
      const handler = createNodeHandler({ ctx, auth: "same-origin", basePath });
      server.middlewares.use(basePath, (req, res, next) => {
        // connect strips the mount prefix; createNodeHandler sees "/apply".
        void handler(req, res).catch((err: unknown) => {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                ok: false,
                reason: "internal-error",
                details: (err as Error).message,
              }),
            );
          } else {
            next(err);
          }
        });
      });
      server.config.logger.info(
        `  ➜  visual-editor: overlay + API at ${basePath} (workspace ${workspaceRoot})`,
      );
    },
  };
}

export default visualEditor;
