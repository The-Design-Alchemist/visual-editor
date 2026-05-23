import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";

const PAGE_URL = "http://localhost:3001";
const PAGE_FILE =
  "/Users/aaqiljamal/Downloads/Visual Editor/spikes/example-app/app/page.tsx";

const originalSource = await readFile(PAGE_FILE, "utf8");
const results = {};

const browser = await chromium.launch();
const page = await browser.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errs.push("console: " + m.text());
});

const restoreAndSettle = async () => {
  await writeFile(PAGE_FILE, originalSource, "utf8");
  // Give Fast Refresh a moment to re-render to the original.
  await page.waitForTimeout(800);
};

try {
  await page.goto(PAGE_URL, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => document.body.dataset.visualEditorMounted === "true",
    null,
    { timeout: 5000 },
  );

  const findBox = async () => {
    const box = await page
      .getByText("drag or nudge", { exact: true })
      .boundingBox();
    if (!box) throw new Error("Could not find amber test box");
    return box;
  };

  const acquireBox = async () => {
    const box = await findBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
    return box;
  };

  // -------------------------------------------------------------------------
  // Test 1 — RESIZE flow: drag right edge → w-32 → w-40 → Apply
  // -------------------------------------------------------------------------

  let box = await acquireBox();
  const startX = box.x + box.width;
  const startY = box.y + box.height / 2;
  const dragDx = 32; // 128 + 32 = 160 → w-40
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dragDx / 2, startY, { steps: 5 });
  await page.mouse.move(startX + dragDx, startY, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  results.resize_pending = await page.evaluate(() =>
    window.__visualEditorSpike.pendingPanelText(),
  );
  await page.evaluate(() => window.__visualEditorSpike.clickApply());
  await page.waitForTimeout(500);

  const afterResize = await readFile(PAGE_FILE, "utf8");
  results.resize_diskAfter = afterResize.match(/className="mt-8 (w-\d+)/)?.[1];

  await restoreAndSettle();

  // -------------------------------------------------------------------------
  // Test 2 — KEYBOARD NUDGE for padding: ] bumps p-4 → p-5 → Apply
  // -------------------------------------------------------------------------

  await acquireBox();
  await page.keyboard.press("]");
  await page.waitForTimeout(200);

  results.padding_pending = await page.evaluate(() =>
    window.__visualEditorSpike.pendingPanelText(),
  );
  await page.evaluate(() => window.__visualEditorSpike.clickApply());
  await page.waitForTimeout(500);

  const afterPadding = await readFile(PAGE_FILE, "utf8");
  // Match the AMBER box specifically — `<main className="p-8">` higher up
  // would otherwise be the first match.
  results.padding_diskAfter = afterPadding.match(
    /(p-\d+(?:\.\d+)?)\s+m-\d+(?:\.\d+)?\s+bg-amber/,
  )?.[1];

  await restoreAndSettle();

  // -------------------------------------------------------------------------
  // Test 3 — KEYBOARD NUDGE for margin: } bumps m-4 → m-5 → Apply
  // -------------------------------------------------------------------------

  await acquireBox();
  await page.keyboard.press("Shift+]"); // produces "}"
  await page.waitForTimeout(200);

  results.margin_pending = await page.evaluate(() =>
    window.__visualEditorSpike.pendingPanelText(),
  );
  await page.evaluate(() => window.__visualEditorSpike.clickApply());
  await page.waitForTimeout(500);

  const afterMargin = await readFile(PAGE_FILE, "utf8");
  results.margin_diskAfter = afterMargin.match(
    /p-\d+(?:\.\d+)?\s+(m-\d+(?:\.\d+)?)\s+bg-amber/,
  )?.[1];

  await restoreAndSettle();

  // -------------------------------------------------------------------------
  // Test 4 — KEYBOARD NUDGE down: [ bumps p-4 → p-3.5
  // -------------------------------------------------------------------------

  await acquireBox();
  await page.keyboard.press("[");
  await page.waitForTimeout(200);
  results.padding_down_pending = await page.evaluate(() =>
    window.__visualEditorSpike.pendingPanelText(),
  );

  await page.keyboard.press("Escape"); // clear pending
  await page.waitForTimeout(200);

  // -------------------------------------------------------------------------
  // Test 5 — INSTANCE COUNT (Principle 11): clicking one <li> rendered from
  // a .map() should show "Edits 5 elements" before Apply.
  // -------------------------------------------------------------------------

  const liBox = await page
    .locator("li", { hasText: "3" })
    .first()
    .boundingBox();
  if (!liBox) throw new Error("Could not find list item");

  await page.mouse.click(liBox.x + liBox.width / 2, liBox.y + liBox.height / 2);
  await page.waitForTimeout(300);
  await page.keyboard.press("]");
  await page.waitForTimeout(200);

  results.instance_pending = await page.evaluate(() =>
    window.__visualEditorSpike.pendingPanelText(),
  );

  // Count the dashed instance outlines in the shadow.
  results.instance_outlineCount = await page.evaluate(() => {
    const spike = window.__visualEditorSpike;
    return spike.instanceOutlineCount?.() ?? "helper-missing";
  });

  await page.evaluate(() => window.__visualEditorSpike.clickApply());
  await page.waitForTimeout(600);

  const afterInstances = await readFile(PAGE_FILE, "utf8");
  results.instance_diskAfter = afterInstances.match(
    /(p-\d+(?:\.\d+)?)\s+bg-sky/,
  )?.[1];

  results.consoleErrors = errs;
  console.log(JSON.stringify(results, null, 2));
} finally {
  await writeFile(PAGE_FILE, originalSource, "utf8");
  await browser.close();
}
