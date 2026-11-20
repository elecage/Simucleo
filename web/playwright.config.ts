import { defineConfig } from "@playwright/test";

// Run against the production build (`npm run build` first).
export default defineConfig({
  testDir: "e2e",
  use: {
    baseURL: "http://localhost:4173",
    viewport: { width: 1400, height: 820 },
    // The interface follows the browser's language (M34): the specs read the
    // Korean one; e2e/i18n.spec.ts opens the English one itself.
    locale: "ko-KR",
    trace: "off",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npx vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
  },
});
