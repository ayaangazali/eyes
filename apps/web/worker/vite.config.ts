import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  appType: "mpa",
  build: {
    rolldownOptions: {
      input: ["index.html", "capture.html", "privacy.html"].map((page) => resolve(import.meta.dirname, page)),
    },
  },
});
