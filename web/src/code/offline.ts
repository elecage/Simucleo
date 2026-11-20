// "편집기 오프라인으로 받기" (M33): ask the service worker (M29) to cache the
// compiler, which is not in the default offline cache, and whether it has.
import { useEffect, useState } from "react";

export interface EditorOffline {
  /** off: no service worker (dev build, unsupported browser). */
  state: "off" | "none" | "caching" | "ready" | "error";
  done?: number;
  total?: number;
  error?: string;
}

type Msg = { type: "EDITOR_STATUS"; ready: boolean; cached: number; total: number; error?: string } | { type: "EDITOR_PROGRESS"; done: number; total: number };

async function ask(type: "EDITOR_STATUS" | "CACHE_EDITOR", onMsg: (m: Msg) => void): Promise<Msg | null> {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  const sw = navigator.serviceWorker.controller ?? reg?.active;
  if (!sw) return null;
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e: MessageEvent<Msg>) => {
      onMsg(e.data);
      if (e.data.type === "EDITOR_STATUS") resolve(e.data);
    };
    sw.postMessage({ type }, [ch.port2]);
  });
}

const fromStatus = (m: Msg | null): EditorOffline =>
  !m || m.type !== "EDITOR_STATUS"
    ? { state: "off" }
    : m.error
      ? { state: "error", error: m.error }
      : m.total === 0
        ? { state: "off" }
        : { state: m.ready ? "ready" : "none", done: m.cached, total: m.total };

export function useEditorOffline() {
  const [s, setS] = useState<EditorOffline>({ state: "off" });
  useEffect(() => {
    let live = true;
    void ask("EDITOR_STATUS", () => {}).then((m) => live && setS(fromStatus(m)));
    return () => {
      live = false;
    };
  }, []);
  const cache = async () => {
    setS({ state: "caching", done: 0, total: 0 });
    const m = await ask("CACHE_EDITOR", (p) => {
      if (p.type === "EDITOR_PROGRESS") setS({ state: "caching", done: p.done, total: p.total });
    });
    setS(fromStatus(m));
  };
  return { offline: s, cacheOffline: cache };
}
