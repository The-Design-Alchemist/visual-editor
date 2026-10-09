/**
 * Client instrumentation module injected by `withVisualEditor()` through
 * Next.js's `instrumentationClientInject` (≥ 16.3). Runs before hydration
 * on every page load; stays tiny and defers the real work so it never
 * trips Next's 16ms instrumentation budget.
 *
 * Production builds: `process.env.NODE_ENV` is inlined, so the dynamic
 * import below is dead code and the overlay never ships.
 */
if (process.env.NODE_ENV === "development" && typeof window !== "undefined") {
  const start = () => {
    void import("@aaqiljamal/visual-editor-runtime/mount").then((m) => {
      m.mountVisualEditor();
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}

export {};
