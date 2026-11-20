// Renders the app icons (public/icons/*.png) from icon.svg and
// icon-maskable.svg with Playwright's Chromium. The PNGs are committed;
// run this only after changing an SVG:
//   node scripts/icons.mjs
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
const OUT = [
  ["icon.svg", "icon-192.png", 192],
  ["icon.svg", "icon-512.png", 512],
  ["icon.svg", "apple-touch-icon.png", 180],
  ["icon-maskable.svg", "icon-maskable-192.png", 192],
  ["icon-maskable.svg", "icon-maskable-512.png", 512],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [svg, png, size] of OUT) {
  const src = readFileSync(join(dir, svg), "utf8");
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${src}`,
  );
  await page.locator("svg").screenshot({ path: join(dir, png), omitBackground: true });
  console.log(`${png} (${size}×${size})`);
}
await browser.close();
