"use client";

import { useEffect } from "react";
import { mountVisualEditor, type VisualEditOverlayProps } from "./mount";

export type { VisualEditOverlayProps } from "./mount";

/**
 * React wrapper around `mountVisualEditor()` for projects that prefer an
 * explicit `<VisualEditOverlay />` in their root layout (or can't use the
 * Next.js auto-inject, e.g. Next < 16.3). Dev-only: renders nothing and
 * mounts nothing outside `NODE_ENV === "development"`.
 */
export default function Overlay({ serverUrl }: VisualEditOverlayProps = {}) {
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    return mountVisualEditor({ serverUrl });
  }, [serverUrl]);
  return null;
}
