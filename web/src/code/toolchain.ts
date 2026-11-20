// Loading the compiler (M33): the toolchain package's loader (`clang.js`)
// asks for its WebAssembly and resource tar by name; we hand it the gzip
// files the site ships (public/toolchain/), counting the bytes for a
// progress bar. Used by the compiler worker (fetch) and the Node test (disk).
import type { ToolSession } from "./build.ts";
import { gunzip, readTar, type TarEntry } from "./tar.ts";
import type { ToolchainManifest } from "./sdk.ts";

/** What we use of the toolchain package's module. */
export interface ClangModule {
  createSession(): ToolSession;
  setAssetLoader(loader: ((name: string) => Promise<Uint8Array | null | undefined>) | null): void;
  version?: string;
}

/** Fetch one file (relative to the site), reporting bytes as they come. */
export type Fetcher = (url: string, onBytes: (n: number) => void) => Promise<Uint8Array>;

export interface Loaded {
  module: ClangModule;
  sdk: TarEntry[];
  manifest: ToolchainManifest;
}

/**
 * Unpack a `.gz` the site ships — unless the server already did: some (vite
 * preview) send `.gz` files with `Content-Encoding: gzip`, and the browser
 * hands over the unpacked bytes.
 */
export async function maybeGunzip(b: Uint8Array): Promise<Uint8Array> {
  return b[0] === 0x1f && b[1] === 0x8b ? gunzip(b) : b;
}

/** Total download, for the progress bar. */
export const downloadBytes = (m: ToolchainManifest) => Object.values(m.files).reduce((s, f) => s + f.bytes, 0) + m.sdk.bytes;

/**
 * Install the asset loader on `module` and read the SDK bundle. The compiler
 * itself loads (and compiles its WebAssembly) on the first command.
 */
export async function prepare(module: ClangModule, manifest: ToolchainManifest, fetcher: Fetcher, onProgress?: (done: number, total: number) => void): Promise<Loaded> {
  const total = downloadBytes(manifest);
  let done = 0;
  const tick = (n: number) => {
    done += n;
    onProgress?.(Math.min(done, total), total);
  };
  module.setAssetLoader(async (name) => {
    const f = manifest.files[name];
    if (!f) throw new Error(`the toolchain asked for ${name}, which the site does not ship`);
    const raw = await fetcher(f.url, tick);
    return f.gzip ? maybeGunzip(raw) : raw;
  });
  const sdk = readTar(await maybeGunzip(await fetcher(manifest.sdk.url, tick)));
  return { module, sdk, manifest };
}
