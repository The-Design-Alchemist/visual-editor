import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { visualEditor } from "@aaqiljamal/visual-editor-vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Dev-only: stamps JSX with source ids, serves the AST-writer API at
    // /api/visual-editor, and injects the overlay. No-op for `vite build`.
    visualEditor(),
  ],
});
