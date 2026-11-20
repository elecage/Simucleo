import { defineConfig } from "@playwright/test";

// Run against the production build (`npm run build` first).
export default defineConfig({
  testDir: "e2e",
  use: {
    baseURL: "http://localhost:4173",
    viewport: { width: 1400, height: 820 },
    trace: "off",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npx vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
  },
});
