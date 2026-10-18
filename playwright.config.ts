import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const worker = existsSync("apps/web/worker/package.json");

const atTheCafe = {
  permissions: ["geolocation", "camera"],
  geolocation: { latitude: 37.78246, longitude: -122.40776, accuracy: 10 },
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
};

export default defineConfig({
  timeout: 60_000,
  projects: [
    { name: "golden", testDir: "e2e", timeout: 120_000, use: atTheCafe },
    {
      name: "worker",
      testDir: "apps/web/worker/e2e",
      use: { baseURL: "http://127.0.0.1:4173", ...atTheCafe },
    },
  ],
  webServer: worker
    ? [
        {
          command:
            "pnpm --filter @eyes/web-worker build && python3 -m http.server 4173 --bind 127.0.0.1 -d apps/web/worker/dist",
          url: "http://127.0.0.1:4173",
          reuseExistingServer: !process.env.CI,
          env: {
            VITE_EYES_API_URL: "http://127.0.0.1:4173/api",
            VITE_INKBOX_NUMBER: "+14155550100",
            VITE_INKBOX_CONNECT: "connect @eyes-test",
          },
        },
        {
          command:
            "pnpm --filter @eyes/web-worker build && python3 -m http.server 4174 --bind 127.0.0.1 -d apps/web/worker/dist/golden",
          url: "http://127.0.0.1:4174",
          reuseExistingServer: !process.env.CI,
          env: {
            EYES_WEB_OUT_DIR: "dist/golden",
            VITE_EYES_API_URL: "http://127.0.0.1:3399",
            VITE_LIVE_PAYOUTS: "true",
          },
        },
      ]
    : [],
});
