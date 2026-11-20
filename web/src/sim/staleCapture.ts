// Scope captures from before the trigger was last set or armed (M31).
import type { FrameMsg } from "./protocol";

/**
 * `msgs` without the captures made under an older trigger setting than
 * `gen` (the `gen` of the last trigger message the page sent). Such a
 * capture was on its way while the page asked for another — longer with
 * batched frames (M31) — and showing it would show what was not asked
 * for: an edge trigger armed before "pause on trigger" was ticked, say.
 */
export function dropStaleCaptures<M extends Pick<FrameMsg, "frame" | "triggerGen">>(msgs: M[], gen: number): M[] {
  return msgs.map((m) =>
    m.frame.scope?.capture && m.triggerGen !== gen
      ? { ...m, frame: { ...m.frame, scope: { ...m.frame.scope, capture: null } } }
      : m,
  );
}
