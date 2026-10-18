// @ts-check
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// Static pages on InsForge Sites. "file" keeps the URLs the server texts workers: /capture.html?t=...
// EYES_WEB_OUT_DIR lets the e2e suite build and preview a second variant side by side.
export default defineConfig({
  output: "static",
  outDir: process.env.EYES_WEB_OUT_DIR || "dist",
  build: { format: "file" },
  vite: {
    envPrefix: ["VITE_", "PUBLIC_"],
    plugins: [tailwindcss()],
  },
});
