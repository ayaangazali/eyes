// @ts-check
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// Static marketing page for the apex domain, served by Cloudflare Workers static assets.
export default defineConfig({
  output: "static",
  site: "https://eyes.pictures",
  // terms.html and privacy.html, which Workers static assets serve at /terms and /privacy.
  build: { format: "file" },
  vite: { plugins: [tailwindcss()] },
});
