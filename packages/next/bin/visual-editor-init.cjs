#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const cwd = process.cwd();
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run") || args.includes("-n");
const force = args.includes("--force") || args.includes("-f");

const ok = (s) => process.stdout.write(`  ✓ ${s}\n`);
const note = (s) => process.stdout.write(`  · ${s}\n`);
const warn = (s) => process.stdout.write(`  ⚠ ${s}\n`);
const fail = (s) => {
  process.stderr.write(`\n  ✗ ${s}\n\n`);
  process.exit(1);
};

const wouldWrite = (label) =>
  process.stdout.write(`  ${dryRun ? "·" : "✓"} ${dryRun ? "would write " : ""}${label}\n`);

process.stdout.write(
  `\nInitializing visual-editor in ${cwd}${dryRun ? " (dry run)" : ""}\n\n`,
);

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

const pkgPath = path.join(cwd, "package.json");
if (!fs.existsSync(pkgPath)) {
  fail(
    "No package.json in current directory. Run this in your Next.js project root.",
  );
}

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
} catch (err) {
  fail(`package.json is not valid JSON: ${err.message}`);
}

const allDeps = Object.assign(
  {},
  pkg.dependencies || {},
  pkg.devDependencies || {},
);
if (!allDeps.next) {
  fail(
    "This project doesn't declare a Next.js dependency. visual-editor only " +
      "supports Next.js App Router projects (see docs for Vite/Remix flow).",
  );
}

const appDir = path.join(cwd, "app");
const srcAppDir = path.join(cwd, "src", "app");
const pagesDir = path.join(cwd, "pages");
const srcPagesDir = path.join(cwd, "src", "pages");

const hasAppRouter = fs.existsSync(appDir) || fs.existsSync(srcAppDir);
const hasPagesRouter = fs.existsSync(pagesDir) || fs.existsSync(srcPagesDir);

if (!hasAppRouter && !force) {
  fail(
    "No `app/` (or `src/app/`) directory found. visual-editor requires the " +
      "App Router. If this is a Pages Router project, visual-editor doesn't " +
      "support it yet. Use --force to proceed anyway.",
  );
}

if (hasPagesRouter && !force) {
  warn(
    "Detected a `pages/` directory alongside `app/`. visual-editor's Route " +
      "Handler will only fire for App Router routes. Pages Router-rendered " +
      "elements will be visible to the overlay but Apply may behave oddly. " +
      "Use --force to suppress this warning.",
  );
}

// Detect whether `app/` lives at root or under src/
const appRoot = fs.existsSync(srcAppDir) ? srcAppDir : appDir;

process.stdout.write("\nProject looks like a Next.js App Router app. Proceeding.\n\n");

// ---------------------------------------------------------------------------
// 1. app/api/visual-editor/[...path]/route.ts
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
        'export { GET, POST, DELETE } from "@aaqiljamal/visual-editor-next/route";\n',
      );
    }
    wouldWrite(path.relative(cwd, routeFile));
  }
}

// ---------------------------------------------------------------------------
// 2. babel.config.js — guard SWC users
// ---------------------------------------------------------------------------

{
  const babelFile = path.join(cwd, "babel.config.js");
  if (fs.existsSync(babelFile)) {
    const current = fs.readFileSync(babelFile, "utf8");
    if (current.includes("@aaqiljamal/visual-editor-babel-plugin")) {
      note("babel.config.js already references the plugin");
    } else {
      warn(
        "babel.config.js exists with other config. Add this to its `plugins` array manually:",
      );
      process.stdout.write('       "@aaqiljamal/visual-editor-babel-plugin"\n');
    }
  } else {
    warn(
      "Writing babel.config.js — this opts your project out of SWC for builds. " +
        "Dev builds will be slightly slower. Visual-edit needs this to stamp " +
        "data-oid attributes on JSX. (You can revert by deleting this file.)",
    );
    if (!dryRun) {
      fs.writeFileSync(
        babelFile,
        'module.exports = {\n' +
          '  presets: ["next/babel"],\n' +
          '  plugins: ["@aaqiljamal/visual-editor-babel-plugin"],\n' +
          '};\n',
      );
    }
    wouldWrite("babel.config.js");
  }
}

// ---------------------------------------------------------------------------
// 3. .gitignore
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
          (current.endsWith("\n") ? "" : "\n") +
            "\n# visual-editor local state\n" +
            entry +
            "\n",
        );
      }
      wouldWrite("added /.visual-editor/ to .gitignore");
    }
  } else {
    if (!dryRun) {
      fs.writeFileSync(giFile, "# visual-editor local state\n" + entry + "\n");
    }
    wouldWrite(".gitignore");
  }
}

// ---------------------------------------------------------------------------
// 4. Manual step
// ---------------------------------------------------------------------------

const layoutPath = path.join(appRoot, "layout.tsx");
const layoutRel = fs.existsSync(layoutPath)
  ? path.relative(cwd, layoutPath)
  : "app/layout.tsx";

process.stdout.write(
  `\nManual step — mount the overlay in ${layoutRel}:\n\n` +
    '  import { VisualEditOverlay } from "@aaqiljamal/visual-editor-next";\n\n' +
    "  export default function RootLayout({ children }) {\n" +
    "    return (\n" +
    '      <html>\n' +
    "        <body>\n" +
    "          {children}\n" +
    '          {process.env.NODE_ENV === "development" && <VisualEditOverlay />}\n' +
    "        </body>\n" +
    "      </html>\n" +
    "    );\n" +
    "  }\n\n" +
    "Then:  npm run dev  →  open your browser  →  click any element.\n\n",
);

if (dryRun) {
  process.stdout.write("(dry run — no files were written)\n\n");
}
