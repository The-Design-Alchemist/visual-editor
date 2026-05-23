import { chromium } from "playwright";

const url = process.env.URL || "http://localhost:3001";

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForFunction(
  () => document.body.dataset.visualEditMounted === "true",
  null,
  { timeout: 5000 },
);

const beforeClick = await page.evaluate(() => {
  const spike = (window).__visualEditSpike;
  const anchor = document.querySelector("visual-edit-anchor");
  const hookKeys = Object.keys(
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers ?? {},
  );
  return {
    hasAnchor: !!anchor,
    shadowRootAccessible: !!anchor?.shadowRoot,
    mounted: document.body.dataset.visualEditMounted === "true",
    moveableHandlesBeforeClick: spike?.moveableHandleCount?.() ?? -1,
    badgeText: spike?.badgeText?.() ?? null,
    badgeColor: spike?.badgeColor?.() ?? null,
    hostBodyColor: spike?.hostBodyColor?.() ?? null,
    reactDevtoolsRenderers: hookKeys.length,
  };
});

await page.click("h1");
await page.waitForTimeout(500);

const afterClick = await page.evaluate(() => {
  const spike = (window).__visualEditSpike;
  return {
    moveableHandlesAfterClick: spike?.moveableHandleCount?.() ?? -1,
  };
});

const headingState = await page.evaluate(() => {
  const h = document.querySelector("h1");
  if (!h) return null;
  return {
    inlineTransform: h.style.transform || "(none)",
  };
});

console.log(
  JSON.stringify(
    { beforeClick, afterClick, headingState, consoleErrors },
    null,
    2,
  ),
);

await browser.close();
