// Buzzer sound with Web Audio: one square-wave oscillator per sounding buzzer.
// A passive buzzer plays the frequency the firmware drives it at; an active
// buzzer has its own oscillator (about 2.3 kHz) and only needs power.
import { useEffect, useRef } from "react";
import type { PlacedPart } from "../editor/model";
import type { VisualState } from "../parts/types";

const ACTIVE_HZ = 2300;
const VOLUME = 0.06;

let ctx: AudioContext | null = null;

/** Create/resume the audio context. Call from a user gesture (click). */
export function unlockAudio(): void {
  ctx ??= new AudioContext();
  void ctx.resume();
}

interface Voice {
  osc: OscillatorNode;
  gain: GainNode;
}

export function useBuzzerAudio(visuals: Record<string, VisualState>, parts: PlacedPart[], enabled: boolean): void {
  const voices = useRef(new Map<string, Voice>());

  useEffect(() => {
    const audio = ctx;
    const live = new Set<string>();
    if (enabled && audio) {
      for (const p of parts) {
        if (p.kind !== "buzzer-active" && p.kind !== "buzzer-passive") continue;
        const v = visuals[p.id];
        const on = (v?.on ?? 0) > 0.02;
        const hz = p.kind === "buzzer-active" ? ACTIVE_HZ : v?.freq;
        if (!on || !hz || hz < 20 || hz > 20_000) continue;
        live.add(p.id);
        let voice = voices.current.get(p.id);
        if (!voice) {
          const osc = audio.createOscillator();
          const gain = audio.createGain();
          osc.type = "square";
          gain.gain.value = 0;
          osc.connect(gain).connect(audio.destination);
          osc.start();
          voice = { osc, gain };
          voices.current.set(p.id, voice);
        }
        const t = audio.currentTime;
        voice.osc.frequency.setTargetAtTime(hz, t, 0.005);
        voice.gain.gain.setTargetAtTime(VOLUME * Math.min(1, (v?.on ?? 0) * 2), t, 0.01);
      }
    }
    for (const [id, voice] of voices.current) {
      if (live.has(id)) continue;
      const t = audio?.currentTime ?? 0;
      voice.gain.gain.setTargetAtTime(0, t, 0.01);
      voice.osc.stop(t + 0.1);
      voices.current.delete(id);
    }
  }, [visuals, parts, enabled]);

  // Silence everything when the component goes away.
  useEffect(() => {
    const map = voices.current;
    return () => {
      for (const v of map.values()) v.osc.stop();
      map.clear();
    };
  }, []);
}
