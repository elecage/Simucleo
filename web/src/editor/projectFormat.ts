// The project file format (`.simucleo.json`): serializing and parsing,
// with the part catalogue passed in so it can be unit tested without the
// part drawings (test/m25.test.ts). `project.ts` binds it to the real one.
import type { PlacedPart, Project, WireModel } from "./model";
import { sanitizeScope, type ScopeSettings } from "../run/scopeSettings.ts";

export const FORMAT = "simucleo-project";
export const VERSION = 1;

/** Firmware referenced by a project: a bundled example, or embedded bytes. */
export interface FirmwareRef {
  name: string;
  /** File name of a bundled example (`hal-pwm-led.elf`). */
  example?: string;
  /** The ELF itself, base64. */
  data?: string;
}

export interface ProjectFile {
  format: typeof FORMAT;
  version: number;
  name?: string;
  parts: PlacedPart[];
  wires: WireModel[];
  firmware?: FirmwareRef;
  /** Waveform view settings (M25; absent from older files). */
  scope?: ScopeSettings;
}

export interface Loaded {
  project: Project;
  name?: string;
  firmware?: FirmwareRef;
  /** Things that were dropped or fixed while loading. */
  notes: string[];
}

/** What parsing needs to know of a part kind. */
export interface CatalogEntry {
  props?: Record<string, string | number>;
  pins: { id: string }[];
}

export function serialize(project: Project, name?: string, firmware?: FirmwareRef): string {
  const file: ProjectFile = {
    format: FORMAT,
    version: VERSION,
    name,
    parts: project.parts,
    wires: project.wires,
    firmware,
    ...(project.scope ? { scope: project.scope } : {}),
  };
  return JSON.stringify(file, null, 2) + "\n";
}

/** Bring an older file up to the current version. */
function migrate(file: Record<string, unknown>, notes: string[]): Record<string, unknown> {
  let v = typeof file.version === "number" ? file.version : 0;
  if (v === 0) {
    // Version 0: a bare `{ parts, wires }` as kept by early builds.
    v = 1;
  }
  if (v > VERSION) notes.push(`파일 버전 ${String(file.version)}은 이 시뮬레이터보다 새것입니다. 일부 내용이 빠질 수 있습니다.`);
  return { ...file, version: VERSION };
}

/** Parse and validate a project file. Throws on input that is not a project. */
export function parseWith(text: string, catalog: Record<string, CatalogEntry | undefined>): Loaded {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("JSON 형식이 아닙니다.");
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Project).parts)) {
    throw new Error("Simucleo 프로젝트 파일이 아닙니다 (parts가 없음).");
  }
  const notes: string[] = [];
  const f = migrate(raw as Record<string, unknown>, notes);
  if (f.format !== undefined && f.format !== FORMAT) throw new Error(`알 수 없는 형식: ${String(f.format)}`);

  const parts: PlacedPart[] = [];
  const ids = new Set<string>();
  for (const p of f.parts as Partial<PlacedPart>[]) {
    if (typeof p?.id !== "string" || typeof p.kind !== "string" || ids.has(p.id)) continue;
    const def = catalog[p.kind];
    if (!def) {
      notes.push(`알 수 없는 부품 '${p.kind}' (${p.id})은 건너뜁니다.`);
      continue;
    }
    ids.add(p.id);
    parts.push({
      id: p.id,
      kind: p.kind,
      x: Number(p.x) || 0,
      y: Number(p.y) || 0,
      // New properties get their defaults.
      props: { ...def.props, ...(p.props ?? {}) },
    });
  }
  const wires: WireModel[] = [];
  const wireIds = new Set<string>();
  for (const w of (Array.isArray(f.wires) ? f.wires : []) as Partial<WireModel>[]) {
    if (!w?.a || !w.b || !ids.has(w.a.part) || !ids.has(w.b.part)) {
      notes.push("없는 부품에 연결된 와이어를 건너뜁니다.");
      continue;
    }
    const pinOk = (r: { part: string; pin: string }) =>
      catalog[parts.find((p) => p.id === r.part)!.kind]!.pins.some((q) => q.id === r.pin);
    if (!pinOk(w.a) || !pinOk(w.b)) {
      notes.push(`없는 핀에 연결된 와이어를 건너뜁니다 (${w.a.part}.${w.a.pin} — ${w.b.part}.${w.b.pin}).`);
      continue;
    }
    let id = typeof w.id === "string" ? w.id : `w${wires.length + 1}`;
    while (wireIds.has(id) || ids.has(id)) id += "_";
    wireIds.add(id);
    const points = Array.isArray(w.points)
      ? w.points.filter((q) => Number.isFinite(q?.x) && Number.isFinite(q?.y)).map((q) => ({ x: q.x, y: q.y }))
      : [];
    wires.push({
      id,
      a: w.a,
      b: w.b,
      color: typeof w.color === "string" ? w.color : "#1e88e5",
      ...(points.length ? { points } : {}),
    });
  }
  const fw = f.firmware as FirmwareRef | undefined;
  const scope = sanitizeScope(f.scope);
  return {
    project: { parts, wires, ...(scope ? { scope } : {}) },
    name: typeof f.name === "string" ? f.name : undefined,
    firmware: fw && typeof fw.name === "string" ? fw : undefined,
    notes: [...new Set(notes)],
  };
}
