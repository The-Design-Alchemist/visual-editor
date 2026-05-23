import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  snapToTailwind,
  pxFromClass,
  classFromSnap,
  parseCssLengthToPx,
  bumpStep,
  DEFAULT_SPACING_PX,
} from "../src/snap/tailwind.ts";

// ---------------------------------------------------------------------------
// snapToTailwind
// ---------------------------------------------------------------------------

test("snap: exact match on integer step", () => {
  // 24px / 4 = 6 → step 6 exactly.
  const r = snapToTailwind({ targetPx: 24 });
  assert.equal(r.step, 6);
  assert.equal(r.suffix, "6");
  assert.equal(r.resolvedPx, 24);
  assert.equal(r.snapped, true);
});

test("snap: exact match on half-step (0.5, 1.5, …)", () => {
  // 6px / 4 = 1.5 → step 1.5 → suffix "1.5".
  const r = snapToTailwind({ targetPx: 6 });
  assert.equal(r.step, 1.5);
  assert.equal(r.suffix, "1.5");
  assert.equal(r.resolvedPx, 6);
  assert.equal(r.snapped, true);
});

test("snap: within ±1px tolerance snaps to nearest step", () => {
  // 23px → nearest step is 6 (24px), diff = 1, tolerance = 1 → snap.
  const r = snapToTailwind({ targetPx: 23 });
  assert.equal(r.step, 6);
  assert.equal(r.suffix, "6");
  assert.equal(r.resolvedPx, 24);
  assert.equal(r.snapped, true);
});

test("snap: outside tolerance falls back to arbitrary px value", () => {
  // 22px → nearest is step 5 (20) or 6 (24), both diff 2 → outside tol 1
  // → arbitrary "[22px]".
  const r = snapToTailwind({ targetPx: 22 });
  assert.equal(r.step, null);
  assert.equal(r.suffix, "[22px]");
  assert.equal(r.resolvedPx, 22);
  assert.equal(r.snapped, false);
});

test("snap: caller can widen tolerance for looser snap", () => {
  // 22px with tol 2 → snap to step 5 (20px). Tie-break picks first match.
  const r = snapToTailwind({ targetPx: 22, tolerancePx: 2 });
  assert.equal(r.snapped, true);
  // Both step 5 and step 6 are 2px away; the loop visits 5 first so it
  // wins ties via strict-less-than. Document the contract.
  assert.equal(r.step, 5);
});

test("snap: tolerance 0 means 'always arbitrary unless EXACT match'", () => {
  // 23 is not an exact scale step at spacingPx=4. With tol=0, no snap.
  const r = snapToTailwind({ targetPx: 23, tolerancePx: 0 });
  assert.equal(r.snapped, false);
  assert.equal(r.suffix, "[23px]");
});

test("snap: respects custom spacingPx (e.g., user customized --spacing)", () => {
  // User has --spacing: 0.3rem → 4.8 px per step.
  // 24 px / 4.8 = 5 → step 5 exactly.
  const r = snapToTailwind({ targetPx: 24, spacingPx: 4.8 });
  assert.equal(r.step, 5);
  assert.equal(r.resolvedPx, 24);
});

test("snap: handles 0 cleanly", () => {
  const r = snapToTailwind({ targetPx: 0 });
  assert.equal(r.step, 0);
  assert.equal(r.suffix, "0");
  assert.equal(r.resolvedPx, 0);
  assert.equal(r.snapped, true);
});

test("snap: handles large values via the scale jumps", () => {
  // 384 px / 4 = 96 → step 96 (the top of the default scale).
  const r = snapToTailwind({ targetPx: 384 });
  assert.equal(r.step, 96);
});

test("snap: handles negative / NaN gracefully (returns arbitrary 0)", () => {
  const r1 = snapToTailwind({ targetPx: -5 });
  assert.equal(r1.snapped, false);
  assert.equal(r1.resolvedPx, 0);
  const r2 = snapToTailwind({ targetPx: Number.NaN });
  assert.equal(r2.snapped, false);
});

// ---------------------------------------------------------------------------
// pxFromClass
// ---------------------------------------------------------------------------

test("pxFromClass: numeric step", () => {
  assert.equal(pxFromClass("p-4"), 16);
  assert.equal(pxFromClass("pl-2"), 8);
  assert.equal(pxFromClass("m-2.5"), 10);
  assert.equal(pxFromClass("w-32"), 128);
});

test("pxFromClass: respects custom spacingPx", () => {
  assert.equal(pxFromClass("p-4", 4.8), 19.2);
});

test("pxFromClass: arbitrary px value", () => {
  assert.equal(pxFromClass("p-[24px]"), 24);
  assert.equal(pxFromClass("w-[37px]"), 37);
});

test("pxFromClass: arbitrary rem value (default 16px root)", () => {
  assert.equal(pxFromClass("p-[1rem]"), 16);
  assert.equal(pxFromClass("p-[1.5rem]"), 24);
});

test("pxFromClass: returns null for non-numeric named tokens", () => {
  assert.equal(pxFromClass("max-w-md"), null);
  assert.equal(pxFromClass("bg-white"), null);
  assert.equal(pxFromClass("text-sm"), null);
});

test("pxFromClass: returns null on garbage", () => {
  assert.equal(pxFromClass(""), null);
  assert.equal(pxFromClass("p-"), null);
  assert.equal(pxFromClass("notaclass"), null);
});

// ---------------------------------------------------------------------------
// parseCssLengthToPx
// ---------------------------------------------------------------------------

test("parseCssLengthToPx: handles px, rem, em", () => {
  assert.equal(parseCssLengthToPx("24px"), 24);
  assert.equal(parseCssLengthToPx("1.5rem"), 24);
  assert.equal(parseCssLengthToPx("2em"), 32);
});

test("parseCssLengthToPx: returns null for unsupported units", () => {
  assert.equal(parseCssLengthToPx("100%"), null);
  assert.equal(parseCssLengthToPx("50vh"), null);
  assert.equal(parseCssLengthToPx("1fr"), null);
});

test("parseCssLengthToPx: respects custom root font size", () => {
  assert.equal(parseCssLengthToPx("1rem", 20), 20);
  assert.equal(parseCssLengthToPx("2rem", 18), 36);
});

// ---------------------------------------------------------------------------
// classFromSnap
// ---------------------------------------------------------------------------

test("classFromSnap: composes scale token", () => {
  const snap = snapToTailwind({ targetPx: 24 });
  assert.equal(classFromSnap("p", snap), "p-6");
  assert.equal(classFromSnap("w", snap), "w-6");
  assert.equal(classFromSnap("pl", snap), "pl-6");
});

test("classFromSnap: composes arbitrary token", () => {
  const snap = snapToTailwind({ targetPx: 22, tolerancePx: 1 });
  assert.equal(classFromSnap("p", snap), "p-[22px]");
});

// ---------------------------------------------------------------------------
// Round-trip: targetPx → snap → class → pxFromClass should return resolvedPx
// ---------------------------------------------------------------------------

test("round-trip: snap and parse agree on the resolved value", () => {
  const cases = [0, 4, 6, 16, 24, 80, 144];
  for (const target of cases) {
    const snap = snapToTailwind({ targetPx: target });
    const klass = classFromSnap("p", snap);
    const back = pxFromClass(klass);
    assert.equal(
      back,
      snap.resolvedPx,
      `round-trip failed for target ${target} → ${klass} → ${back}`,
    );
  }
});

test("default constant matches Tailwind v4 default scale base", () => {
  assert.equal(DEFAULT_SPACING_PX, 4);
});

// ---------------------------------------------------------------------------
// bumpStep — used by the overlay's keyboard nudge for padding/margin/gap
// ---------------------------------------------------------------------------

test("bumpStep: p-4 up → p-5", () => {
  assert.equal(bumpStep("p-4", "up"), "p-5");
});

test("bumpStep: p-5 down → p-4", () => {
  assert.equal(bumpStep("p-5", "down"), "p-4");
});

test("bumpStep: respects the scale's gaps (p-12 → p-14, no 13)", () => {
  assert.equal(bumpStep("p-12", "up"), "p-14");
  assert.equal(bumpStep("p-14", "down"), "p-12");
});

test("bumpStep: works on any prefix (pt-, m-, gap-, ml-, etc.)", () => {
  assert.equal(bumpStep("pt-4", "up"), "pt-5");
  // m-2 → m-2.5 (the scale has half-steps between 0 and 4).
  assert.equal(bumpStep("m-2", "up"), "m-2.5");
  assert.equal(bumpStep("gap-4", "up"), "gap-5");
  assert.equal(bumpStep("ml-1.5", "up"), "ml-2");
});

test("bumpStep: arbitrary value snaps to nearest then bumps in direction", () => {
  // p-[17px] = 17px. Step 4 = 16px (below current). Step 5 = 20px (above).
  // Going up → step 5.
  assert.equal(bumpStep("p-[17px]", "up"), "p-5");
  // Going down → step 4.
  assert.equal(bumpStep("p-[17px]", "down"), "p-4");
});

test("bumpStep: arbitrary value that's exactly a scale step bumps to neighbour", () => {
  // p-[20px] = 20px = step 5 exactly. Up → step 6.
  assert.equal(bumpStep("p-[20px]", "up"), "p-6");
  assert.equal(bumpStep("p-[20px]", "down"), "p-4");
});

test("bumpStep: returns null at scale boundaries", () => {
  assert.equal(bumpStep("p-0", "down"), null);
  assert.equal(bumpStep("p-96", "up"), null);
});

test("bumpStep: returns null on garbage tokens", () => {
  assert.equal(bumpStep("not-a-class", "up"), null);
  assert.equal(bumpStep("bg-white", "up"), null);
  assert.equal(bumpStep("p-", "up"), null);
});

test("bumpStep: handles half-steps (0.5, 1.5, 2.5, 3.5)", () => {
  assert.equal(bumpStep("p-0", "up"), "p-0.5");
  assert.equal(bumpStep("p-0.5", "up"), "p-1");
  assert.equal(bumpStep("p-1", "up"), "p-1.5");
  assert.equal(bumpStep("p-3.5", "up"), "p-4");
});

test("bumpStep: custom spacingPx is honored", () => {
  // With spacingPx = 4.8 (custom --spacing), p-5 = 24px is step 5.
  // bumpStep p-5 up → p-6.
  assert.equal(bumpStep("p-5", "up", 4.8), "p-6");
});
