#!/usr/bin/env node
/**
 * Captures the four screenshots referenced in README.md.
 *
 * Prereq: spike dev server must be running on PORT (default 3939).
 *   cd spikes/example-app && PORT=3939 npm run dev
 *
 * Usage:
 *   node scripts/capture-screenshots.mjs
 *   PORT=3000 node scripts/capture-screenshots.mjs
 *
 * Output: docs/screenshots/{01-hover,02-selected,03-pending,04-applied}.png
 */
import { chromium } from "playwright";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCREENSHOTS_DIR = path.join(REPO_ROOT, "docs", "screenshots");
const PAGE_FILE = path.join(REPO_ROOT, "spikes", "example-app", "app", "page.tsx");
const PORT = process.env.PORT ?? "3939";
const PAGE_URL = `http://localhost:${PORT}`;

await mkdir(SCREENSHOTS_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();

const originalSource = await readFile(PAGE_FILE, "utf8");

const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errs.push("console: " + m.text());
});

function logErrs(label) {
  if (errs.length) {
    console.warn(`  ⚠ console/page errors during ${label}:`);
    errs.forEach((e) => console.warn("    - " + e));
    errs.length = 0;
  }
}

try {
  console.log(`→ ${PAGE_URL}`);
  await page.goto(PAGE_URL, { waitUntil: "networkidle" });

  // Overlay mount marker.
  await page.waitForFunction(
    () => document.body.dataset.visualEditMounted === "true",
    null,
    { timeout: 8000 },
  );

  const target = await page.getByText("drag or nudge", { exact: true });
  const box = await target.boundingBox();
  if (!box) throw new Error("amber target box not found");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // -------------------------------------------------------------------------
  // 1. Hover state — pink outline + source badge + box-model bands
  // -------------------------------------------------------------------------
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(500);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "01-hover.png"),
    clip: { x: 0, y: 0, width: 1280, height: 600 },
  });
  console.log("  ✓ 01-hover.png");
  logErrs("hover");

  // -------------------------------------------------------------------------
  // 2. Selected state — Moveable handles + padding handles
  // -------------------------------------------------------------------------
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(700);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "02-selected.png"),
    clip: { x: 0, y: 0, width: 1280, height: 600 },
  });
  console.log("  ✓ 02-selected.png");
  logErrs("selected");

  // -------------------------------------------------------------------------
  // 3. Pending state — keypress `]` bumps padding, pending panel appears
  // -------------------------------------------------------------------------
  await page.keyboard.press("BracketRight");
  await page.waitForTimeout(600);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "03-pending.png"),
    clip: { x: 0, y: 0, width: 1280, height: 600 },
  });
  console.log("  ✓ 03-pending.png");
  logErrs("pending");

  // -------------------------------------------------------------------------
  // 4. Applied state — use the dev test hook to click Apply
  // -------------------------------------------------------------------------
  const applyResult = await page.evaluate(() =>
    window.__visualEditSpike?.clickApply?.() ?? { error: "no-hook" },
  );
  if (applyResult?.clicked) {
    await page.waitForTimeout(1100);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "04-applied.png"),
      clip: { x: 0, y: 0, width: 1280, height: 600 },
    });
    console.log("  ✓ 04-applied.png");
  } else {
    console.warn(
      `  ⚠ couldn't click Apply (${JSON.stringify(applyResult)}) — skipping applied screenshot`,
    );
  }
  logErrs("applied");
} finally {
  // Restore the source file no matter what so the spike stays clean.
  await writeFile(PAGE_FILE, originalSource, "utf8");
  await browser.close();
}

console.log("\nDone. Files in docs/screenshots/.");
