// Render counts of the heavier views, for the E2E test that hidden tabs do
// not redraw (M31): `window.__simucleoRenders.source` and so on.
export const renders: Record<string, number> = {};
export function countRender(name: string) {
  renders[name] = (renders[name] ?? 0) + 1;
}
if (typeof window !== "undefined") (window as unknown as { __simucleoRenders: typeof renders }).__simucleoRenders = renders;
