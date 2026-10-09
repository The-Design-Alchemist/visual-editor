import type { NextConfig } from "next";
import { withVisualEditor } from "@aaqiljamal/visual-editor-next/config";

const nextConfig: NextConfig = {
  /* config options here */
};

// Dev-only: stamps data-oid via an SWC-compatible loader and auto-mounts
// the overlay. Returns the config untouched for `next build`.
export default withVisualEditor(nextConfig);
