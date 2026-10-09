/**
 * Bundler-agnostic JSX stamper.
 *
 * Given the raw source of a .tsx/.jsx/.js file, inserts `data-oid` (host
 * elements) / `data-oid-call` (component call sites) attributes on every
 * JSXOpeningElement so the overlay can map runtime DOM back to source.
 * Also stamps the CSS Modules / styled-components hints the overlay uses to
 * route an element to the right mutation pipeline.
 *
 * Why a string-level transform instead of a Babel plugin: Next.js (and any
 * SWC-based pipeline) drops its native compiler the moment a Babel config
 * exists. This stamper only *inserts text* into the original source via
 * magic-string — the real compile still happens in SWC/esbuild/oxc. It runs
 * as a Turbopack rule, a webpack `enforce: "pre"` loader, or a Vite
 * `enforce: "pre"` transform, and it never reformats user code.
 *
 * Determinism contract: the id is `<relpath>:<line>:<col>` where line is
 * 1-based and col is 0-based — exactly what @babel/parser (and therefore
 * recast on the mutation side) reports for the JSXOpeningElement. The stamp
 * is computed from the ORIGINAL source positions, so the server can resolve
 * it against the file on disk.
 */
import { parse, type ParserOptions, type ParserPlugin } from "@babel/parser";
import * as magicStringNs from "magic-string";

// magic-string ships `module.exports = MagicString` (no `default`) in its
// CJS build and a default export in ESM. We build this file to BOTH formats
// (bundler loaders are CommonJS), so resolve the constructor at runtime.
type MagicStringCtor = typeof import("magic-string").default;
function resolveMagicString(ns: unknown): MagicStringCtor {
  let cur = ns as { default?: unknown; MagicString?: unknown } | undefined;
  for (let i = 0; i < 4 && cur; i++) {
    if (typeof cur === "function") return cur as unknown as MagicStringCtor;
    if (typeof cur.MagicString === "function") return cur.MagicString as MagicStringCtor;
    cur = cur.default as typeof cur;
  }
  throw new Error("visual-editor: could not resolve the magic-string constructor");
}
const MagicString: MagicStringCtor = resolveMagicString(magicStringNs);
import * as fs from "node:fs";
import * as nodePath from "node:path";

export const WORKSPACE_MARKERS = [
  "pnpm-workspace.yaml",
  "turbo.json",
  "lerna.json",
  "nx.json",
  ".git",
] as const;

const rootCache = new Map<string, string | null>();

/**
 * Walk up from `startDir` looking for a workspace marker. Returns the
 * directory containing the first marker found, or null.
 *
 * Both the stamper (build side) and the API (write side) derive the
 * workspace root with this exact function from the project directory, so
 * the ids one side emits always resolve on the other side.
 */
export function findWorkspaceRoot(startDir: string): string | null {
  const start = nodePath.resolve(startDir);
  const cached = rootCache.get(start);
  if (cached !== undefined) return cached;
  let dir = start;
  let found: string | null = null;
  for (;;) {
    for (const marker of WORKSPACE_MARKERS) {
      try {
        if (fs.existsSync(nodePath.join(dir, marker))) {
          found = dir;
          break;
        }
      } catch {
        /* permission denied — keep walking */
      }
    }
    if (found) break;
    const parent = nodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  rootCache.set(start, found);
  return found;
}

/**
 * The single source of truth for "which directory are data-oid paths
 * relative to". Priority: explicit > VISUAL_EDITOR_WORKSPACE_ROOT env >
 * nearest workspace marker above `cwd` > `cwd` itself.
 */
export function resolveWorkspaceRoot(opts: {
  explicit?: string | null;
  cwd?: string;
  env?: Record<string, string | undefined>;
} = {}): string {
  const env = opts.env ?? process.env;
  if (opts.explicit) return nodePath.resolve(opts.explicit);
  const fromEnv = env.VISUAL_EDITOR_WORKSPACE_ROOT;
  if (fromEnv) return nodePath.resolve(fromEnv);
  const cwd = nodePath.resolve(opts.cwd ?? process.cwd());
  return findWorkspaceRoot(cwd) ?? cwd;
}

/** `root`-relative POSIX path. Files outside the root get `../` segments. */
export function toSourceId(root: string, filename: string): string {
  const rel = nodePath.relative(nodePath.resolve(root), nodePath.resolve(filename));
  return rel.split(nodePath.sep).join("/");
}

export type StampOptions = {
  /** Absolute path of the file being transformed. */
  filename: string;
  /** Absolute workspace root; see resolveWorkspaceRoot(). */
  root: string;
  /** Generate a (hires) source map for the insertions. Default true. */
  sourceMap?: boolean;
};

export type StampResult = {
  code: string;
  /** Source map object (magic-string shape) or null when unchanged / disabled. */
  map: { toString(): string; toUrl(): string } | null;
  /** False when the source was returned verbatim (no JSX, or unparseable). */
  changed: boolean;
  /** Number of JSXOpeningElements that received a stamp. */
  stamped: number;
  /** Set when parsing failed; the code is passed through untouched. */
  parseError?: string;
};

type Node = {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start: { line: number; column: number } } | null;
  [key: string]: unknown;
};

const SKIP_KEYS = new Set([
  "loc",
  "start",
  "end",
  "range",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "comments",
  "tokens",
]);

export function walk(
  node: unknown,
  visit: (n: Node, parents: Node[]) => void,
  parents: Node[] = [],
): void {
  if (!node || typeof node !== "object") return;
  const n = node as Node;
  if (typeof n.type !== "string") return;
  visit(n, parents);
  const nextParents = parents.concat(n);
  for (const key of Object.keys(n)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = n[key];
    if (Array.isArray(v)) {
      for (const c of v) {
        if (c && typeof c === "object" && typeof (c as Node).type === "string") {
          walk(c, visit, nextParents);
        }
      }
    } else if (v && typeof v === "object" && typeof (v as Node).type === "string") {
      walk(v, visit, nextParents);
    }
  }
}

const BASE_PLUGINS: ParserPlugin[] = ["jsx", "typescript"];
const PLUGIN_ATTEMPTS: ParserPlugin[][] = [
  BASE_PLUGINS,
  [...BASE_PLUGINS, "decorators-legacy"],
];

export function parseSource(source: string): { ast: Node | null; error: string | null } {
  let lastError: string | null = null;
  for (const plugins of PLUGIN_ATTEMPTS) {
    const options: ParserOptions = {
      sourceType: "module",
      plugins,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      errorRecovery: false,
      ranges: false,
      tokens: false,
    };
    try {
      return { ast: parse(source, options) as unknown as Node, error: null };
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  return { ast: null, error: lastError };
}

type ProgramHints = {
  cssModuleImports: Map<string, string>; // local identifier → import source
  styledDefs: Map<string, string>; // component name → html tag
};

/**
 * Program-level pre-collection shared by the stamper and the element
 * describer: which identifiers are default imports of `.module.css` files,
 * and which top-level consts are fully-static `styled.tag\`…\`` templates.
 */
export function collectProgramHints(ast: Node): ProgramHints {
  const cssModuleImports = new Map<string, string>();
  const styledDefs = new Map<string, string>();
  const program = ast.program as Node | undefined;
  const body = (program?.body ?? ast.body) as Node[] | undefined;
  for (const stmt of body ?? []) {
    if (stmt.type === "ImportDeclaration") {
      const src = (stmt.source as Node | undefined)?.value;
      if (typeof src === "string" && src.endsWith(".module.css")) {
        for (const spec of (stmt.specifiers as Node[] | undefined) ?? []) {
          const local = (spec.local as Node | undefined)?.name;
          if (spec.type === "ImportDefaultSpecifier" && typeof local === "string") {
            cssModuleImports.set(local, src);
          }
        }
      }
      continue;
    }
    const decl =
      stmt.type === "VariableDeclaration"
        ? stmt
        : stmt.type === "ExportNamedDeclaration" &&
            (stmt.declaration as Node | undefined)?.type === "VariableDeclaration"
          ? (stmt.declaration as Node)
          : null;
    if (!decl) continue;
    for (const d of (decl.declarations as Node[] | undefined) ?? []) {
      if (d.type !== "VariableDeclarator") continue;
      const id = d.id as Node | undefined;
      const init = d.init as Node | undefined;
      if (id?.type !== "Identifier" || typeof id.name !== "string") continue;
      if (!init || init.type !== "TaggedTemplateExpression") continue;
      const tag = init.tag as Node | undefined;
      const quasi = init.quasi as Node | undefined;
      const expressions = (quasi?.expressions as unknown[] | undefined) ?? [];
      if (
        tag?.type === "MemberExpression" &&
        tag.computed === false &&
        (tag.object as Node | undefined)?.type === "Identifier" &&
        (tag.object as Node).name === "styled" &&
        (tag.property as Node | undefined)?.type === "Identifier" &&
        typeof (tag.property as Node).name === "string" &&
        expressions.length === 0
      ) {
        styledDefs.set(id.name, (tag.property as Node).name as string);
      }
    }
  }
  return { cssModuleImports, styledDefs };
}

export type JsxNameInfo = {
  /** `div`, `Button`, `Foo.Bar`, `svg:rect` */
  display: string;
  /** Host element (`div`) vs component (`Button`, `Foo.Bar`). */
  kind: "host" | "component";
  /** Bare identifier when the name is a JSXIdentifier; null for member/namespaced. */
  identifier: string | null;
};

export function describeJsxName(name: Node | undefined): JsxNameInfo | null {
  if (!name) return null;
  if (name.type === "JSXIdentifier") {
    const id = String(name.name ?? "");
    const kind = /^[a-z]/.test(id) ? "host" : "component";
    return { display: id, kind, identifier: id };
  }
  if (name.type === "JSXMemberExpression") {
    const parts: string[] = [];
    let cur: Node | undefined = name;
    while (cur) {
      if (cur.type === "JSXMemberExpression") {
        parts.unshift(String((cur.property as Node).name ?? ""));
        cur = cur.object as Node;
      } else {
        parts.unshift(String(cur.name ?? ""));
        cur = undefined;
      }
    }
    return { display: parts.join("."), kind: "component", identifier: null };
  }
  if (name.type === "JSXNamespacedName") {
    const ns = String((name.namespace as Node).name ?? "");
    const local = String((name.name as Node).name ?? "");
    return { display: `${ns}:${local}`, kind: "host", identifier: null };
  }
  return null;
}

function hasAttribute(attrs: Node[], attrName: string): boolean {
  return attrs.some(
    (a) =>
      a.type === "JSXAttribute" &&
      (a.name as Node | undefined)?.type === "JSXIdentifier" &&
      (a.name as Node).name === attrName,
  );
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Detect `className={styles.foo}` and resolve `styles` via the hints. */
export function cssModuleClassOf(
  attrs: Node[],
  hints: ProgramHints,
): { className: string; file: string } | null {
  const classNameAttr = attrs.find(
    (a) =>
      a.type === "JSXAttribute" &&
      (a.name as Node | undefined)?.type === "JSXIdentifier" &&
      (a.name as Node).name === "className",
  );
  const value = classNameAttr?.value as Node | undefined;
  if (!value || value.type !== "JSXExpressionContainer") return null;
  const expr = value.expression as Node | undefined;
  if (
    expr?.type === "MemberExpression" &&
    expr.computed === false &&
    (expr.object as Node | undefined)?.type === "Identifier" &&
    (expr.property as Node | undefined)?.type === "Identifier"
  ) {
    const file = hints.cssModuleImports.get(String((expr.object as Node).name));
    if (file) {
      return { className: String((expr.property as Node).name), file };
    }
  }
  return null;
}

export function stampJsx(source: string, options: StampOptions): StampResult {
  // Cheap bail-out: no `<` means no JSX. Keeps the loader near-free for
  // plain TS/JS modules.
  if (!source.includes("<")) {
    return { code: source, map: null, changed: false, stamped: 0 };
  }
  const { ast, error } = parseSource(source);
  if (!ast) {
    return {
      code: source,
      map: null,
      changed: false,
      stamped: 0,
      parseError: error ?? "unknown parse error",
    };
  }

  const sourceId = toSourceId(options.root, options.filename);
  const hints = collectProgramHints(ast);
  const s = new MagicString(source);
  let stamped = 0;

  walk(ast, (node) => {
    if (node.type !== "JSXOpeningElement") return;
    const loc = node.loc;
    if (!loc) return;
    const attrs = ((node.attributes as Node[] | undefined) ?? []).slice();
    if (hasAttribute(attrs, "data-oid") || hasAttribute(attrs, "data-oid-call")) {
      return;
    }
    const nameInfo = describeJsxName(node.name as Node | undefined);
    if (!nameInfo) return;
    // `<Fragment>` / `<React.Fragment>` only accept `key`; React warns on
    // anything else. Plain `<>` has no opening element and never gets here.
    if (nameInfo.display === "Fragment" || nameInfo.display.endsWith(".Fragment")) return;

    const insertAt =
      ((node.typeArguments as Node | undefined)?.end ??
        (node.typeParameters as Node | undefined)?.end ??
        (node.name as Node).end) ?? null;
    if (typeof insertAt !== "number") return;

    const oid = `${sourceId}:${loc.start.line}:${loc.start.column}`;
    const attrName = nameInfo.kind === "host" ? "data-oid" : "data-oid-call";
    let text = ` ${attrName}="${escapeAttr(oid)}"`;

    if (nameInfo.identifier && hints.styledDefs.has(nameInfo.identifier)) {
      const tag = hints.styledDefs.get(nameInfo.identifier)!;
      text += ` data-styled-name="${escapeAttr(nameInfo.identifier)}" data-styled-tag="${escapeAttr(tag)}"`;
    }
    const cssMod = cssModuleClassOf(attrs, hints);
    if (cssMod) {
      text += ` data-css-module-class="${escapeAttr(cssMod.className)}" data-css-module-file="${escapeAttr(cssMod.file)}"`;
    }

    s.appendLeft(insertAt, text);
    stamped++;
  });

  if (stamped === 0) {
    return { code: source, map: null, changed: false, stamped: 0 };
  }
  const map =
    options.sourceMap === false
      ? null
      : s.generateMap({
          source: options.filename,
          hires: true,
          includeContent: false,
        });
  return { code: s.toString(), map, changed: true, stamped };
}

/** File extensions the stamper should even attempt. */
export const STAMPABLE_EXTENSIONS = new Set([".tsx", ".jsx", ".js", ".mjs", ".cjs"]);

export function isStampablePath(filename: string): boolean {
  if (/[\\/]node_modules[\\/]/.test(filename)) return false;
  return STAMPABLE_EXTENSIONS.has(nodePath.extname(filename).toLowerCase());
}
