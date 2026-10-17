import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  appType: "mpa",
  build: {
    rolldownOptions: {
      input: [resolve(import.meta.dirname, "index.html"), resolve(import.meta.dirname, "capture.html")],
    },
  },
});
