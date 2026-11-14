import { defineConfig, devices } from "@playwright/test";

const PORT = 5173;
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "off",
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /\.ipad\.spec\.ts$/ },
    {
      // iPad Safari shape (touch, 16px rules, viewport) on the installed Chromium
      name: "ipad",
      testMatch: /\.ipad\.spec\.ts$/,
      use: {
        viewport: { width: 1180, height: 820 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
        userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      },
    },
  ],
  webServer: {
    command: `SIDEKICK_TEST_API=1 npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
