// SD cards keep their contents between sessions, like a real card left in
// its socket: each card's blocks in use (`sdSnapshot`, a few KB for a
// freshly formatted log card instead of a 32 MB image) go to IndexedDB,
// keyed by project name and part id. They are saved a few seconds after the
// firmware starts writing (at most every SAVE_DELAY while it keeps on) and
// when the run pauses, and put back when the project is opened again —
// before it is run.
import { useCallback, useEffect, useRef } from "react";
import { idbGet, idbSet } from "../editor/project";
import type { Project } from "../editor/model";
import type { Runner } from "./useRunner";

/** Wait this long (ms) after the first unsaved change before saving. */
export const SAVE_DELAY = 3000;

export const sdKey = (project: string, part: string) => `sd:${project}:${part}`;

/** Where a card stands, by storage key. */
interface Card {
  part: string;
  /** Generation saved or restored last; null until the first frame after
   * the restore says what it is; undefined while restoring (no saves). */
  saved: number | null | undefined;
  /** Latest generation seen. */
  seen?: number;
  timer?: ReturnType<typeof setTimeout>;
}

export function useSdPersistence(runner: Runner, project: Project, projectName: string) {
  const cards = useRef(new Map<string, Card>());
  const { ready, frame, running, sdRestore, sdSnapshot, sdWipe } = runner;
  const partsKey = project.parts
    .filter((p) => p.kind === "sd-card")
    .map((p) => p.id)
    .join(",");

  // Put back what was saved for this project's cards (once per key).
  useEffect(() => {
    if (!ready) return;
    for (const part of partsKey ? partsKey.split(",") : []) {
      const key = sdKey(projectName, part);
      if (cards.current.has(key)) continue;
      const card: Card = { part, saved: undefined };
      cards.current.set(key, card);
      void idbGet<Uint8Array>(key).then((bytes) => {
        if (bytes?.length) sdRestore(part, bytes.slice().buffer);
        card.saved = null;
      });
    }
  }, [ready, projectName, partsKey, sdRestore]);

  const save = useCallback(
    async (key: string) => {
      const card = cards.current.get(key);
      if (!card || card.saved === undefined) return;
      clearTimeout(card.timer);
      card.timer = undefined;
      const gen = card.seen ?? null;
      const bytes = await sdSnapshot(card.part);
      if (!bytes.length) return;
      await idbSet(key, bytes);
      card.saved = gen;
    },
    [sdSnapshot],
  );

  // The firmware wrote to a card: save it soon.
  useEffect(() => {
    if (!frame) return;
    for (const part of partsKey ? partsKey.split(",") : []) {
      const card = cards.current.get(sdKey(projectName, part));
      const gen = frame.parts.find((p) => p.id === part)?.generation;
      if (!card || gen === undefined || card.saved === undefined) continue;
      card.seen = gen;
      if (card.saved === null) card.saved = gen;
      else if (gen !== card.saved && !card.timer) {
        const key = sdKey(projectName, part);
        card.timer = setTimeout(() => void save(key), SAVE_DELAY);
      }
    }
  }, [frame, partsKey, projectName, save]);

  // Paused: save what changed right away.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running)
      for (const [key, card] of cards.current) if (card.timer) void save(key);
    wasRunning.current = running;
  }, [running, save]);
  useEffect(() => () => cards.current.forEach((c) => clearTimeout(c.timer)), []);

  /** Erase a card and keep it erased. */
  const wipe = useCallback(
    (part: string) => {
      sdWipe(part);
      const key = sdKey(projectName, part);
      const card = cards.current.get(key);
      if (card && card.saved !== undefined) void save(key);
      else void idbSet(key, undefined);
    },
    [projectName, sdWipe, save],
  );
  return { wipe };
}
