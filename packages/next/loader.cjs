"use strict";
/**
 * webpack / Turbopack loader for visual-editor.
 *
 * Inserts `data-oid` / `data-oid-call` (and the CSS Modules / styled hints)
 * into JSX source BEFORE Next.js's SWC compiler sees it. Pure text
 * insertion — the user's code is never reformatted, and SWC, Turbopack,
 * next/font and React Compiler keep working because no Babel config exists.
 *
 * Wired up by `withVisualEditor()` from "@aaqiljamal/visual-editor-next/config".
 * CommonJS on purpose: Turbopack's loader runner only loads CJS loaders.
 *
 * Failure policy: any parse error passes the source through untouched.
 * A file that can't be stamped is a file you can't hover — never a broken
 * build.
 */
let transform = null;
function getTransform() {
  if (!transform) {
    transform = require("@aaqiljamal/visual-editor-server/transform");
  }
  return transform;
}

module.exports = function visualEditorLoader(source, inputSourceMap) {
  const callback = this.async();
  const options =
    (typeof this.getOptions === "function" ? this.getOptions() : this.query) ||
    {};
  const filename = this.resourcePath;
  try {
    const { stampJsx, isStampablePath, resolveWorkspaceRoot } = getTransform();
    if (typeof source !== "string" || !filename || !isStampablePath(filename)) {
      callback(null, source, inputSourceMap);
      return;
    }
    const root = resolveWorkspaceRoot({
      explicit: options.root || null,
      cwd: this.rootContext || process.cwd(),
    });
    const result = stampJsx(source, { filename, root, sourceMap: true });
    if (!result.changed) {
      callback(null, source, inputSourceMap);
      return;
    }
    callback(null, result.code, result.map ? JSON.parse(result.map.toString()) : inputSourceMap);
  } catch (err) {
    // Never fail the build because of us.
    if (typeof this.emitWarning === "function") {
      this.emitWarning(new Error(`visual-editor: could not stamp ${filename}: ${err && err.message}`));
    }
    callback(null, source, inputSourceMap);
  }
};
