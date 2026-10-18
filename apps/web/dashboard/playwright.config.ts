import { defineConfig } from "@playwright/test";

// Dashboard page tests route every request in-test, so no web server is needed.
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  reporter: "list",
  use: { headless: true },
});
