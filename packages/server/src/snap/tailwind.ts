/**
 * Tailwind snap engine — pure, no DOM access.
 *
 * Given a target pixel value (from a Moveable resize/drag callback) and a
 * spacing base (read from the live page's `:root { --spacing }` in v4, or
 * the configured value), return the Tailwind class suffix to emit:
 *
 *   targetPx 24, spacingPx 4 → snapped to step 6, suffix "6"   (→ "p-6")
 *   targetPx 22, spacingPx 4, tol 1 → no step within tolerance,
 *                                    suffix "[22px]"           (→ "p-[22px]")
 *
 * The `tolerancePx` parameter is the project's bias toward design-system
 * hygiene. Default `1` means "snap to the scale unless the user dragged
 * more than 1 px off it." Holding Alt during drag should raise this to
 * 0 (always emit arbitrary) — that knob is set by the caller.
 *
 * `pxFromClass` is the inverse — given a class token like "p-6" or
 * "p-[24px]", return the resolved pixel value. The overlay uses this to
 * compute "is the user's drag a no-op against the current class?"
 */

export type SnapInput = {
  /** Target px value (e.g., element width after drag). */
  targetPx: number;
  /** Spacing base in px. Read from `:root { --spacing }` at runtime; default 4. */
  spacingPx?: number;
  /** Maximum px deviation from a scale step to still snap. Default 1. */
  tolerancePx?: number;
  /** Tailwind scale steps (the N in `p-N`). Defaults to v4's standard scale. */
  scaleSteps?: readonly number[];
};

export type SnapResult = {
  /** The N value from the scale (e.g., 6 for `p-6`), or null if no snap. */
  step: number | null;
  /** Class suffix: "6" for a scale step, "[24px]" for an arbitrary value. */
  suffix: string;
  /** The exact px the suffix resolves to (24 for "6" at spacingPx=4; 23 for "[23px]"). */
  resolvedPx: number;
  /** True if a scale step was within tolerance; false if we emitted arbitrary. */
  snapped: boolean;
};

// Tailwind v4 default scale. Half-steps (0.5, 1.5, 2.5, 3.5) plus the
// integer steps, jumping every 4 above 12 and every 8 above 64.
const DEFAULT_SCALE_STEPS = Object.freeze([
  0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24,
  28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96,
]);

export const DEFAULT_TAILWIND_SCALE = DEFAULT_SCALE_STEPS;
export const DEFAULT_SPACING_PX = 4;

export function snapToTailwind(input: SnapInput): SnapResult {
  const {
    targetPx,
    spacingPx = DEFAULT_SPACING_PX,
    tolerancePx = 1,
    scaleSteps = DEFAULT_SCALE_STEPS,
  } = input;

  if (!Number.isFinite(targetPx) || targetPx < 0) {
    return { step: null, suffix: `[${Math.max(0, Math.round(targetPx))}px]`, resolvedPx: 0, snapped: false };
  }

  let bestStep: number | null = null;
  let bestDiff = Infinity;

  for (const step of scaleSteps) {
    const stepPx = step * spacingPx;
    const diff = Math.abs(stepPx - targetPx);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestStep = step;
    }
  }

  if (bestStep !== null && bestDiff <= tolerancePx) {
    return {
      step: bestStep,
      suffix: formatStep(bestStep),
      resolvedPx: bestStep * spacingPx,
      snapped: true,
    };
  }

  const intPx = Math.round(targetPx);
  return {
    step: null,
    suffix: `[${intPx}px]`,
    resolvedPx: intPx,
    snapped: false,
  };
}

/**
 * Given a single class token like "p-6", "pl-4", "w-[24px]", "h-[1rem]",
 * "max-w-md", return the resolved px or null. Returns null for tokens we
 * can't unambiguously resolve (named tokens like `max-w-md` aren't a
 * straight numeric scale — the caller should fall through to a `--max-w-md`
 * lookup if needed).
 */
export function pxFromClass(
  token: string,
  spacingPx = DEFAULT_SPACING_PX,
): number | null {
  // Split into prefix + suffix at the last `-` that isn't inside `[…]`.
  // Tokens we accept:
  //   p-4, pl-4, m-2.5, w-32  → numeric step
  //   p-[24px], p-[1.5rem]    → arbitrary value
  const open = token.indexOf("[");
  if (open !== -1 && token.endsWith("]")) {
    const value = token.slice(open + 1, -1);
    return parseCssLengthToPx(value);
  }
  const lastDash = token.lastIndexOf("-");
  if (lastDash === -1) return null;
  const stepStr = token.slice(lastDash + 1);
  const step = parseFloat(stepStr);
  if (Number.isNaN(step) || !/^-?\d+(?:\.\d+)?$/.test(stepStr)) return null;
  return step * spacingPx;
}

/**
 * Parse "24px", "1.5rem", "1em", "100%", etc. → px, or null if we can't.
 * The rootFontPx default of 16 matches HTML default; the overlay should
 * pass the actual `parseFloat(getComputedStyle(html).fontSize)` for fidelity.
 */
export function parseCssLengthToPx(
  value: string,
  rootFontPx = 16,
): number | null {
  const v = value.trim();
  if (v.endsWith("px")) {
    const n = parseFloat(v.slice(0, -2));
    return Number.isFinite(n) ? n : null;
  }
  if (v.endsWith("rem")) {
    const n = parseFloat(v.slice(0, -3));
    return Number.isFinite(n) ? n * rootFontPx : null;
  }
  if (v.endsWith("em")) {
    const n = parseFloat(v.slice(0, -2));
    return Number.isFinite(n) ? n * rootFontPx : null;
  }
  // % / vh / vw / vmin / vmax / fr / ch — caller can extend.
  return null;
}

/**
 * Build the full class token from a prefix and a SnapResult.
 *   classFromSnap("p",  { suffix: "6",      ...}) === "p-6"
 *   classFromSnap("pl", { suffix: "[23px]", ...}) === "pl-[23px]"
 */
export function classFromSnap(prefix: string, snap: SnapResult): string {
  return `${prefix}-${snap.suffix}`;
}

function formatStep(n: number): string {
  // Keep `0.5` as `"0.5"`, `12` as `"12"`. JS's String(n) already does this.
  return String(n);
}

/**
 * Given a Tailwind token like "p-4" or "p-[17px]", return the next or previous
 * scale-step token. Used by the overlay's keyboard nudge (`[` / `]` for
 * padding, `{` / `}` for margin, etc.) — see Overlay.tsx.
 *
 * Behavior:
 *   bumpStep("p-4", "up")       === "p-5"
 *   bumpStep("p-12", "up")      === "p-14"     (skips 13, follows the scale)
 *   bumpStep("p-[17px]", "up")  === "p-5"      (snaps to nearest first)
 *   bumpStep("p-[20px]", "up")  === "p-6"      (20 = step 5 exactly → step 6)
 *   bumpStep("p-0", "down")     === null       (already at minimum)
 *   bumpStep("p-96", "up")      === null       (already at maximum)
 *   bumpStep("pt-4", "up")      === "pt-5"     (any prefix works)
 *
 * Returns `null` for tokens that don't parse, or when bumping past the scale.
 * Caller should refuse the action and tell the user (rather than silently
 * doing nothing).
 */
export function bumpStep(
  currentToken: string,
  direction: "up" | "down",
  spacingPx: number = DEFAULT_SPACING_PX,
  scaleSteps: readonly number[] = DEFAULT_SCALE_STEPS,
): string | null {
  // Split into prefix + suffix at the last `-` that isn't inside `[…]`.
  const open = currentToken.indexOf("[");
  let lastDash: number;
  if (open !== -1 && currentToken.endsWith("]")) {
    lastDash = currentToken.lastIndexOf("-", open);
  } else {
    lastDash = currentToken.lastIndexOf("-");
  }
  if (lastDash <= 0) return null;
  const prefix = currentToken.slice(0, lastDash);

  const currentPx = pxFromClass(currentToken, spacingPx);
  if (currentPx === null) return null;

  // Find the current step's index in the scale (within a tiny tolerance to
  // handle floating-point rounding from N * spacingPx).
  let currentIdx = -1;
  for (let i = 0; i < scaleSteps.length; i++) {
    if (Math.abs((scaleSteps[i] as number) * spacingPx - currentPx) < 0.001) {
      currentIdx = i;
      break;
    }
  }

  if (currentIdx === -1) {
    // Off-scale (arbitrary value). Snap to nearest first, then bump in
    // the requested direction.
    let nearestIdx = 0;
    let nearestDiff = Infinity;
    for (let i = 0; i < scaleSteps.length; i++) {
      const diff = Math.abs((scaleSteps[i] as number) * spacingPx - currentPx);
      if (diff < nearestDiff) {
        nearestDiff = diff;
        nearestIdx = i;
      }
    }
    // If nearest is below current and we're going up, the *next* step IS
    // nearestIdx itself (the snap is the bump). Same logic mirrored for down.
    if (
      direction === "up" &&
      (scaleSteps[nearestIdx] as number) * spacingPx < currentPx
    ) {
      currentIdx = nearestIdx; // next is nearestIdx + 1
    } else if (
      direction === "down" &&
      (scaleSteps[nearestIdx] as number) * spacingPx > currentPx
    ) {
      currentIdx = nearestIdx; // next is nearestIdx - 1
    } else {
      // Going up from a value that's already at-or-below nearest scale step
      // → the new step IS nearestIdx (don't subtract again).
      // Returning nearestIdx makes the +1/-1 below land on the right one.
      return `${prefix}-${formatStep(scaleSteps[nearestIdx] as number)}`;
    }
  }

  const newIdx = direction === "up" ? currentIdx + 1 : currentIdx - 1;
  if (newIdx < 0 || newIdx >= scaleSteps.length) return null;

  return `${prefix}-${formatStep(scaleSteps[newIdx] as number)}`;
}
