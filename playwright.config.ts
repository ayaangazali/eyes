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
            "pnpm --filter @eyes/web-worker build && pnpm --filter @eyes/web-worker exec vite preview --host 127.0.0.1 --port 4173 --strictPort",
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
            "pnpm --filter @eyes/web-worker exec vite build --outDir dist/golden && pnpm --filter @eyes/web-worker exec vite preview --outDir dist/golden --host 127.0.0.1 --port 4174 --strictPort",
          url: "http://127.0.0.1:4174",
          reuseExistingServer: !process.env.CI,
          env: { VITE_EYES_API_URL: "http://127.0.0.1:3399" },
        },
      ]
    : [],
});
