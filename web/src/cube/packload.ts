// Loading a driver bundle in the browser (M36): its listing (for the
// project tree) from public/cube/packs.json, its files (for read-only views
// and the zip export) from public/cube/<id>.tar.gz.bin. Fetched on first
// use and kept for the session; in the default offline cache (M29).
import { readTar } from "../code/tar.ts";
import { maybeGunzip } from "../code/toolchain.ts";
import { PACK_PREFIX, PACKS_INDEX, type PackListing } from "./packs.ts";
import type { PackFile } from "./tree.ts";

let index: Promise<PackListing[]> | null = null;
export function packIndex(): Promise<PackListing[]> {
  index ??= fetch(`./${PACKS_INDEX}`)
    .then((r) => (r.ok ? (r.json() as Promise<PackListing[]>) : Promise.reject(new Error(`HTTP ${r.status}`))))
    .catch((e) => {
      index = null;
      throw e;
    });
  return index;
}

const files = new Map<string, Promise<PackFile[]>>();
export function packFilesOf(id: string): Promise<PackFile[]> {
  let p = files.get(id);
  if (!p) {
    p = (async () => {
      const l = (await packIndex()).find((x) => x.id === id);
      if (!l) throw new Error(`드라이버 묶음 ${id}이(가) 사이트에 없습니다`);
      const r = await fetch(`./${l.url}`);
      if (!r.ok) throw new Error(`${l.url}: HTTP ${r.status}`);
      return readTar(await maybeGunzip(new Uint8Array(await r.arrayBuffer())))
        .filter((e) => e.name.startsWith(PACK_PREFIX))
        .map((e) => ({ path: e.name.slice(PACK_PREFIX.length), data: e.data }));
    })();
    p.catch(() => files.delete(id));
    files.set(id, p);
  }
  return p;
}
