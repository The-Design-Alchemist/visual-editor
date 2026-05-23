#!/usr/bin/env node
/**
 * Captures the four screenshots referenced in README.md, taken against
 * the shadcn dashboard demo (not the spike app).
 *
 * Prereq: demo dev server must be running on PORT (default 3942).
 *   cd examples/shadcn-demo && PORT=3942 npm run dev
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
// Apply-step mutation will land in stat-cards.tsx because the target is
// the "$45,231.89" element rendered by <StatCards />.
const APPLY_TARGET_FILE = path.join(
  REPO_ROOT,
  "examples",
  "shadcn-demo",
  "components",
  "stat-cards.tsx",
);
const PORT = process.env.PORT ?? "3942";
const PAGE_URL = `http://localhost:${PORT}`;

await mkdir(SCREENSHOTS_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();

const originalSource = await readFile(APPLY_TARGET_FILE, "utf8");

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

  await page.waitForFunction(
    () => document.body.dataset.visualEditorMounted === "true",
    null,
    { timeout: 10000 },
  );

  // Target the Revenue card's big number value — visually impactful target.
  const target = page.getByText("$45,231.89", { exact: true });
  const box = await target.boundingBox();
  if (!box) throw new Error("$45,231.89 value not found on dashboard");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const SHOT = { x: 0, y: 0, width: 1440, height: 900 };

  // 1. Hover — pink outline + source badge + box-model bands
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(600);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "01-hover.png"),
    clip: SHOT,
  });
  console.log("  ✓ 01-hover.png");
  logErrs("hover");

  // 2. Selected — Moveable handles + padding handles
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(800);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "02-selected.png"),
    clip: SHOT,
  });
  console.log("  ✓ 02-selected.png");
  logErrs("selected");

  // 3. Pending — keypress `]` bumps padding, pending panel appears
  await page.keyboard.press("BracketRight");
  await page.waitForTimeout(700);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "03-pending.png"),
    clip: SHOT,
  });
  console.log("  ✓ 03-pending.png");
  logErrs("pending");

  // 4. Applied — programmatically click Apply via the dev test hook
  const applyResult = await page.evaluate(() =>
    window.__visualEditorSpike?.clickApply?.() ?? { error: "no-hook" },
  );
  if (applyResult?.clicked) {
    await page.waitForTimeout(1200);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "04-applied.png"),
      clip: SHOT,
    });
    console.log("  ✓ 04-applied.png");
  } else {
    console.warn(
      `  ⚠ couldn't click Apply (${JSON.stringify(applyResult)}) — skipping applied screenshot`,
    );
  }
  logErrs("applied");
} finally {
  // Restore the source file so the demo stays clean.
  await writeFile(APPLY_TARGET_FILE, originalSource, "utf8");
  await browser.close();
}

console.log("\nDone. Files in docs/screenshots/.");
