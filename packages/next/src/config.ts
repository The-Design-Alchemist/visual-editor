/**
 * `withVisualEditor(nextConfig, options)` — one-line Next.js integration.
 *
 *   // next.config.ts
 *   import { withVisualEditor } from "@aaqiljamal/visual-editor-next/config";
 *   export default withVisualEditor({ ...yourConfig });
 *
 * In `next dev` it:
 *   1. registers the stamping loader for .tsx/.jsx/.js (Turbopack rule +
 *      webpack `enforce: "pre"` rule) — no babel.config.js, SWC stays on;
 *   2. auto-mounts the overlay via `instrumentationClientInject`
 *      (Next ≥ 16.3) so there's nothing to add to your layout;
 *   3. pins VISUAL_EDITOR_WORKSPACE_ROOT so the Route Handler resolves
 *      ids against the exact root the loader used.
 *
 * In `next build` / production it returns your config untouched.
 */
import { createRequire } from "node:module";
import { resolveWorkspaceRoot } from "@aaqiljamal/visual-editor-server/transform";

type AnyConfig = Record<string, unknown>;
type ConfigFn = (phase: string, ctx: unknown) => AnyConfig | Promise<AnyConfig>;
type NextConfigInput = AnyConfig | ConfigFn;

export type VisualEditorConfigOptions = {
  /**
   * Absolute path that data-oid ids are relative to, and that the writer
   * refuses to escape. Defaults to the nearest workspace marker above the
   * Next.js project (pnpm-workspace.yaml, turbo.json, lerna.json, nx.json,
   * .git), else the project directory.
   */
  root?: string;
  /**
   * Auto-mount the overlay through `instrumentationClientInject`
   * (requires Next ≥ 16.3). Set false if you render <VisualEditOverlay />
   * yourself. Default true.
   */
  injectClient?: boolean;
  /** Force-enable/disable regardless of phase (mainly for tests). */
  enabled?: boolean;
  /** Extra file globs to stamp beyond *.tsx, *.jsx, *.js. */
  globs?: string[];
};

const PHASE_DEVELOPMENT_SERVER = "phase-development-server";
const DEFAULT_GLOBS = ["*.tsx", "*.jsx", "*.js"];
const CLIENT_MODULE = "@aaqiljamal/visual-editor-next/client";

const req = createRequire(import.meta.url);

function nextVersion(): [number, number, number] | null {
  try {
    const v = (req("next/package.json") as { version: string }).version;
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch {
    return null;
  }
}

function atLeast(v: [number, number, number] | null, major: number, minor: number): boolean {
  if (!v) return false;
  return v[0] > major || (v[0] === major && v[1] >= minor);
}

function loaderPath(): string {
  return req.resolve("@aaqiljamal/visual-editor-next/loader");
}

export function applyVisualEditor(
  config: AnyConfig,
  options: VisualEditorConfigOptions = {},
): AnyConfig {
  const root = resolveWorkspaceRoot({ explicit: options.root ?? null });
  // The Route Handler reads this to resolve ids. The dev server inherits
  // the env of the process that evaluated next.config, so this lines up
  // the two sides even when the marker walk would (somehow) differ.
  if (!process.env.VISUAL_EDITOR_WORKSPACE_ROOT) {
    process.env.VISUAL_EDITOR_WORKSPACE_ROOT = root;
  }

  const version = nextVersion();
  const loader = loaderPath();
  const loaderEntry = { loader, options: { root } };
  const globs = [...DEFAULT_GLOBS, ...(options.globs ?? [])];

  // --- Turbopack -----------------------------------------------------------
  const turbopack = { ...((config.turbopack as AnyConfig | undefined) ?? {}) };
  const rules: AnyConfig = { ...((turbopack.rules as AnyConfig | undefined) ?? {}) };
  const rule: AnyConfig = { loaders: [loaderEntry] };
  // `condition` arrived in 16.0; `foreign` keeps the loader out of
  // node_modules. (The loader also skips node_modules itself.)
  if (atLeast(version, 16, 0)) rule.condition = { not: "foreign" };
  for (const glob of globs) {
    const existing = rules[glob];
    if (existing === undefined) rules[glob] = rule;
    else if (Array.isArray(existing)) rules[glob] = [...existing, rule];
    else rules[glob] = [existing, rule];
  }
  turbopack.rules = rules;

  // --- webpack (`next dev --webpack`) --------------------------------------
  const prevWebpack = config.webpack as
    | ((cfg: AnyConfig, ctx: unknown) => AnyConfig)
    | undefined;
  const webpack = (cfg: AnyConfig, ctx: unknown): AnyConfig => {
    const base = typeof prevWebpack === "function" ? prevWebpack(cfg, ctx) : cfg;
    const mod = (base.module as AnyConfig | undefined) ?? (base.module = {});
    const list = (mod.rules as unknown[] | undefined) ?? (mod.rules = []);
    list.push({
      test: /\.(tsx|jsx|js|mjs|cjs)$/,
      exclude: /node_modules/,
      enforce: "pre",
      use: [loaderEntry],
    });
    return base;
  };

  // --- overlay auto-mount --------------------------------------------------
  const out: AnyConfig = { ...config, turbopack, webpack };
  if (options.injectClient !== false && atLeast(version, 16, 3)) {
    const inject = (config.instrumentationClientInject as string[] | undefined) ?? [];
    if (!inject.includes(CLIENT_MODULE)) {
      out.instrumentationClientInject = [...inject, CLIENT_MODULE];
    }
  }
  return out;
}

export function withVisualEditor(
  nextConfig: NextConfigInput = {},
  options: VisualEditorConfigOptions = {},
): ConfigFn {
  return async (phase: string, ctx: unknown) => {
    const resolved =
      typeof nextConfig === "function"
        ? await nextConfig(phase, ctx)
        : nextConfig;
    const enabled =
      options.enabled ??
      (phase === PHASE_DEVELOPMENT_SERVER &&
        process.env.VISUAL_EDITOR_DISABLE !== "1");
    if (!enabled) return resolved;
    return applyVisualEditor(resolved, options);
  };
}

/** Exposed for the init script + docs: is auto-inject available? */
export function supportsClientInject(): boolean {
  return atLeast(nextVersion(), 16, 3);
}

export const VISUAL_EDITOR_CLIENT_MODULE = CLIENT_MODULE;
