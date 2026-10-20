// @ts-check
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// Static pages on InsForge Sites. "file" keeps the URLs the server texts workers: /capture.html?t=...
// EYES_WEB_OUT_DIR lets the e2e suite build and preview a second variant side by side.
export default defineConfig({
  output: "static",
  outDir: process.env.EYES_WEB_OUT_DIR || "dist",
  build: { format: "file" },
  integrations: [
    {
      name: "development-design-pages",
      hooks: {
        "astro:config:setup": ({ command, injectRoute }) => {
          if (command !== "dev") return;
          for (const page of ["catalog", "moodboard"]) {
            injectRoute({ pattern: `/design/${page}`, entrypoint: `./src/design/pages/${page}.astro` });
          }
        },
      },
    },
  ],
  vite: {
    envPrefix: ["VITE_", "PUBLIC_"],
    plugins: [tailwindcss()],
  },
});
