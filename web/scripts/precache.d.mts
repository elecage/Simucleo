// Types for precache.mjs (imported by vite.config.ts and the unit tests).
import type { Plugin } from "vite";

export interface PrecacheEntry {
  /** Relative to the site's base. */
  url: string;
  size: number;
  /** Subresource integrity, "sha256-<base64>". */
  integrity: string;
}

export const SW_FILE: string;
export const OPTIONAL_DIR: string;
export function collectPrecache(distDir: string): PrecacheEntry[];
export function collectOptional(distDir: string): PrecacheEntry[];
export function optionalProblems(precache: PrecacheEntry[], optional: PrecacheEntry[], distDir: string): string[];
export function cacheVersion(entries: PrecacheEntry[]): string;
export function missingForOffline(entries: PrecacheEntry[], distDir: string, lessonIds?: string[]): string[];
export function lessonIds(lessonsDir: string): string[];
export function renderServiceWorker(
  template: string,
  entries: PrecacheEntry[],
  version: string,
  optional?: PrecacheEntry[],
  optionalVersion?: string,
): string;
export function writeServiceWorker(
  distDir: string,
  templateFile: string,
  lessonsDir: string,
): { version: string; count: number; mb: number; optionalCount: number; optionalMb: number; optionalVersion: string };
export function serviceWorkerPlugin(options: { template: string; lessons: string }): Plugin;
