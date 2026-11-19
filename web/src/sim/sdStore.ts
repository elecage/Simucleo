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
  // Only the cards of the circuit now in the simulator. An entry lives as
  // long as that card does: a project switch or removing the part ends it
  // (the simulator drops the card), so coming back restores it again.
  const cards = useRef(new Map<string, Card>());
  /** Saves still writing; restores wait for them so they read the latest. */
  const flushing = useRef<Promise<unknown>>(Promise.resolve());
  const { ready, frame, running, sdRestore, sdSnapshot, sdWipe } = runner;
  const partsKey = project.parts
    .filter((p) => p.kind === "sd-card")
    .map((p) => p.id)
    .join(",");

  /** Snapshot `card` now and store it under `key`. The snapshot request
   * is queued to the worker at once, so it reads this card even when a new
   * circuit is sent right after. */
  const saveCard = useCallback(
    (key: string, card: Card) => {
      clearTimeout(card.timer);
      card.timer = undefined;
      const gen = card.seen ?? null;
      const done = sdSnapshot(card.part).then(async (bytes) => {
        if (!bytes.length) return;
        await idbSet(key, bytes);
        card.saved = gen;
      });
      flushing.current = Promise.all([flushing.current, done]);
      return done;
    },
    [sdSnapshot],
  );

  const save = useCallback(
    async (key: string) => {
      const card = cards.current.get(key);
      // Only a card still in the simulator, and not while it is restored.
      if (!card || card.saved === undefined) return;
      await saveCard(key, card);
    },
    [saveCard],
  );

  // The cards of this circuit: put back what was saved for them. Before
  // the circuit changes (another project, a card added or removed), save
  // what is pending — the snapshot goes to the worker ahead of the new
  // circuit — and forget the cards, whose contents the simulator may drop.
  useEffect(() => {
    if (!ready) return;
    const mine = new Map<string, Card>();
    for (const part of partsKey ? partsKey.split(",") : []) {
      const key = sdKey(projectName, part);
      const card: Card = { part, saved: undefined };
      mine.set(key, card);
      cards.current.set(key, card);
      void flushing.current
        .then(() => idbGet<Uint8Array>(key))
        .then((bytes) => {
          // Gone meanwhile (switched away): this restore is stale.
          if (cards.current.get(key) !== card) return;
          // Nothing saved: a blank card, not the one another project left
          // in the simulator under the same part id.
          if (bytes?.length) sdRestore(part, bytes.slice().buffer);
          else sdWipe(part);
          card.saved = null;
        });
    }
    return () => {
      for (const [key, card] of mine) {
        if (card.timer && card.saved !== undefined) void saveCard(key, card);
        clearTimeout(card.timer);
        if (cards.current.get(key) === card) cards.current.delete(key);
      }
    };
  }, [ready, projectName, partsKey, sdRestore, sdWipe, saveCard]);

  // The firmware wrote to a card: save it soon.
  useEffect(() => {
    if (!frame) return;
    for (const part of partsKey ? partsKey.split(",") : []) {
      const key = sdKey(projectName, part);
      const card = cards.current.get(key);
      const gen = frame.parts.find((p) => p.id === part)?.generation;
      if (!card || gen === undefined || card.saved === undefined) continue;
      card.seen = gen;
      if (card.saved === null) card.saved = gen;
      else if (gen !== card.saved && !card.timer) {
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
