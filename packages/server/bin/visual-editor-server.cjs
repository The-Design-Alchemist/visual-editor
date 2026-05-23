#!/usr/bin/env node
"use strict";
/**
 * Launcher for `npx visual-editor-server`. The CLI is shipped pre-built
 * in dist/cli.js (ESM); we delegate to it via node's --import.
 */
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const cli = path.join(__dirname, "..", "dist", "cli.js");
const child = spawn(
  process.execPath,
  [pathToFileURL(cli).href, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  process.stderr.write(`visual-editor-server: ${err.message}\n`);
  process.exit(1);
});
