#!/usr/bin/env node
"use strict";
/**
 * `npx visual-editor-init` — wires visual-editor into a Next.js App Router
 * project:
 *
 *   1. app/api/visual-editor/[...path]/route.ts   (one-line Route Handler)
 *   2. next.config.{ts,js,mjs}                     wrapped in withVisualEditor()
 *                                                   (prints the snippet if it
 *                                                   can't do it safely)
 *   3. .gitignore                                   + /.visual-editor/
 *   4. .claude/commands/visual-editor.md            (when --claude or .claude/ exists)
 *
 * Next ≥ 16.3: the overlay auto-mounts (instrumentationClientInject) — no
 * layout edit. Older Next: we print the two-line <VisualEditOverlay /> step.
 *
 * Flags: --dry-run / -n, --force / -f, --claude, --no-claude
 */
const fs = require("node:fs");
const path = require("node:path");

const cwd = process.cwd();
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run") || args.includes("-n");
const force = args.includes("--force") || args.includes("-f");
const wantClaude = args.includes("--claude")
  ? true
  : args.includes("--no-claude")
    ? false
    : fs.existsSync(path.join(cwd, ".claude"));

const ok = (s) => process.stdout.write(`  ✓ ${s}\n`);
const note = (s) => process.stdout.write(`  · ${s}\n`);
const warn = (s) => process.stdout.write(`  ⚠ ${s}\n`);
const fail = (s) => {
  process.stderr.write(`\n  ✗ ${s}\n\n`);
  process.exit(1);
};
const wouldWrite = (label) =>
  process.stdout.write(`  ${dryRun ? "·" : "✓"} ${dryRun ? "would write " : ""}${label}\n`);

process.stdout.write(`\nInitializing visual-editor in ${cwd}${dryRun ? " (dry run)" : ""}\n\n`);

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

const pkgPath = path.join(cwd, "package.json");
if (!fs.existsSync(pkgPath)) {
  fail("No package.json in current directory. Run this in your Next.js project root.");
}
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
} catch (err) {
  fail(`package.json is not valid JSON: ${err.message}`);
}
const allDeps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
if (!allDeps.next) {
  fail(
    "This project doesn't declare a Next.js dependency. For Vite / React Router / TanStack Start " +
      "use @aaqiljamal/visual-editor-vite instead (see INSTALL.md).",
  );
}

let nextVersion = null;
try {
  nextVersion = require(require.resolve("next/package.json", { paths: [cwd] })).version;
} catch {
  /* not installed yet */
}
const [nextMajor, nextMinor] = (nextVersion || "0.0.0").split(".").map(Number);
const autoInject = nextMajor > 16 || (nextMajor === 16 && nextMinor >= 3);

const appDir = path.join(cwd, "app");
const srcAppDir = path.join(cwd, "src", "app");
const hasAppRouter = fs.existsSync(appDir) || fs.existsSync(srcAppDir);
const hasPagesRouter = fs.existsSync(path.join(cwd, "pages")) || fs.existsSync(path.join(cwd, "src", "pages"));
if (!hasAppRouter && !force) {
  fail(
    "No `app/` (or `src/app/`) directory found. visual-editor's Route Handler needs the App Router. " +
      "Use --force to proceed anyway.",
  );
}
if (hasPagesRouter && hasAppRouter) {
  warn("Both `pages/` and `app/` exist. Only App Router routes get the Route Handler; Pages Router pages are hover-only.");
}
const appRoot = fs.existsSync(srcAppDir) ? srcAppDir : appDir;

process.stdout.write(
  `Next.js ${nextVersion || "(version unknown)"} App Router project. ${
    autoInject ? "Overlay will auto-mount." : "Overlay needs a layout edit (Next < 16.3)."
  }\n\n`,
);

// ---------------------------------------------------------------------------
// 1. Route Handler
// ---------------------------------------------------------------------------

{
  const routeDir = path.join(appRoot, "api", "visual-editor", "[...path]");
  const routeFile = path.join(routeDir, "route.ts");
  if (fs.existsSync(routeFile)) {
    note(`route.ts exists at ${path.relative(cwd, routeFile)} — leaving it alone`);
  } else {
    if (!dryRun) {
      fs.mkdirSync(routeDir, { recursive: true });
      fs.writeFileSync(
        routeFile,
        '// visual-editor dev API (404s in production). Safe to commit.\n' +
          'export { GET, POST, DELETE } from "@aaqiljamal/visual-editor-next/route";\n',
      );
    }
    wouldWrite(path.relative(cwd, routeFile));
  }
}

// ---------------------------------------------------------------------------
// 2. next.config — wrap in withVisualEditor()
// ---------------------------------------------------------------------------

const CONFIG_CANDIDATES = ["next.config.ts", "next.config.mjs", "next.config.js", "next.config.cjs"];
const snippetFor = (kind) =>
  kind === "cjs"
    ? [
        'const { withVisualEditor } = require("@aaqiljamal/visual-editor-next/config");',
        "",
        "module.exports = withVisualEditor({",
        "  // ...your config",
        "});",
      ].join("\n")
    : [
        'import { withVisualEditor } from "@aaqiljamal/visual-editor-next/config";',
        "",
        "export default withVisualEditor({",
        "  // ...your config",
        "});",
      ].join("\n");

{
  const existing = CONFIG_CANDIDATES.map((f) => path.join(cwd, f)).find((f) => fs.existsSync(f));
  if (!existing) {
    const file = path.join(cwd, "next.config.ts");
    const body =
      'import type { NextConfig } from "next";\n' +
      'import { withVisualEditor } from "@aaqiljamal/visual-editor-next/config";\n\n' +
      "const nextConfig: NextConfig = {};\n\n" +
      "// Dev-only: stamps JSX with source ids (SWC/Turbopack-compatible loader) and\n" +
      "// auto-mounts the overlay. Returns your config untouched for `next build`.\n" +
      "export default withVisualEditor(nextConfig);\n";
    if (!dryRun) fs.writeFileSync(file, body);
    wouldWrite("next.config.ts");
  } else {
    const src = fs.readFileSync(existing, "utf8");
    const isCjs = existing.endsWith(".cjs") || (existing.endsWith(".js") && /module\.exports/.test(src));
    if (src.includes("withVisualEditor")) {
      note(`${path.basename(existing)} already uses withVisualEditor()`);
    } else {
      // Try the two safe mechanical rewrites; otherwise print the snippet.
      let next = null;
      if (isCjs) {
        const m = /module\.exports\s*=\s*/.exec(src);
        if (m && (src.match(/module\.exports\s*=/g) || []).length === 1) {
          const after = src.slice(m.index + m[0].length).trimEnd();
          const expr = after.replace(/;\s*$/, "");
          next =
            'const { withVisualEditor } = require("@aaqiljamal/visual-editor-next/config");\n' +
            src.slice(0, m.index) +
            `module.exports = withVisualEditor(${expr});\n`;
        }
      } else {
        const m = /export\s+default\s+/.exec(src);
        if (m && (src.match(/export\s+default\s+/g) || []).length === 1) {
          const after = src.slice(m.index + m[0].length).trimEnd();
          const expr = after.replace(/;\s*$/, "");
          next =
            'import { withVisualEditor } from "@aaqiljamal/visual-editor-next/config";\n' +
            src.slice(0, m.index) +
            `export default withVisualEditor(${expr});\n`;
        }
      }
      if (next) {
        if (!dryRun) fs.writeFileSync(existing, next);
        wouldWrite(`wrapped ${path.basename(existing)} in withVisualEditor()`);
      } else {
        warn(`Couldn't safely rewrite ${path.basename(existing)}. Wrap your config manually:\n\n${snippetFor(isCjs ? "cjs" : "esm")}\n`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Legacy babel.config.js from v0.2 — no longer needed
// ---------------------------------------------------------------------------

{
  for (const name of ["babel.config.js", ".babelrc", ".babelrc.js", "babel.config.cjs"]) {
    const f = path.join(cwd, name);
    if (!fs.existsSync(f)) continue;
    const src = fs.readFileSync(f, "utf8");
    if (src.includes("visual-editor-babel-plugin")) {
      warn(
        `${name} still references @aaqiljamal/visual-editor-babel-plugin. v0.3 stamps via a loader ` +
          `(SWC stays on). If that file exists only for visual-editor, delete it: rm ${name}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 4. .gitignore
// ---------------------------------------------------------------------------

{
  const giFile = path.join(cwd, ".gitignore");
  const entry = "/.visual-editor/";
  if (fs.existsSync(giFile)) {
    const current = fs.readFileSync(giFile, "utf8");
    if (current.split("\n").some((l) => l.trim() === entry)) {
      note(".gitignore already has /.visual-editor/");
    } else {
      if (!dryRun) {
        fs.appendFileSync(
          giFile,
          (current.endsWith("\n") ? "" : "\n") + "\n# visual-editor local state (history, pins)\n" + entry + "\n",
        );
      }
      wouldWrite("added /.visual-editor/ to .gitignore");
    }
  } else {
    if (!dryRun) fs.writeFileSync(giFile, "# visual-editor local state (history, pins)\n" + entry + "\n");
    wouldWrite(".gitignore");
  }
}

// ---------------------------------------------------------------------------
// 5. Claude Code slash command
// ---------------------------------------------------------------------------

if (wantClaude) {
  const cmdDir = path.join(cwd, ".claude", "commands");
  const cmdFile = path.join(cmdDir, "visual-editor.md");
  const template = path.join(__dirname, "..", "templates", "visual-editor.md");
  if (fs.existsSync(cmdFile)) {
    note(".claude/commands/visual-editor.md exists — leaving it alone");
  } else if (fs.existsSync(template)) {
    if (!dryRun) {
      fs.mkdirSync(cmdDir, { recursive: true });
      fs.copyFileSync(template, cmdFile);
    }
    wouldWrite(".claude/commands/visual-editor.md");
  }
}

// ---------------------------------------------------------------------------
// Next steps
// ---------------------------------------------------------------------------

process.stdout.write("\nNext:\n\n");
if (!autoInject) {
  process.stdout.write(
    `  1. Mount the overlay in ${path.relative(cwd, path.join(appRoot, "layout.tsx"))} (Next < 16.3 can't auto-inject):\n\n` +
      '     import { VisualEditOverlay } from "@aaqiljamal/visual-editor-next";\n' +
      '     // inside <body>:\n' +
      '     {process.env.NODE_ENV === "development" && <VisualEditOverlay />}\n\n' +
      "  2. npm run dev  →  open the app  →  click any element.\n\n",
  );
} else {
  process.stdout.write("  npm run dev  →  open the app  →  click any element.\n\n");
}
process.stdout.write(
  "  Claude Code (optional):\n" +
    "    npm i -D @aaqiljamal/visual-editor-mcp\n" +
    '    claude mcp add visual-editor --env VISUAL_EDITOR_SERVER_URL="http://localhost:3000/api/visual-editor" -- npx visual-editor-mcp\n' +
    "  then pin elements in the browser and run /visual-editor.\n\n",
);
if (dryRun) process.stdout.write("(dry run — no files were written)\n\n");
