// Offline app (M29), the page's side: registers the service worker
// (sw/service-worker.js, only in production builds), follows whether the
// files for offline use are all cached, notices a new version waiting,
// the browser's install prompt and the network state. No DOM access at
// import time: `createPwa` gets everything it touches (unit tests pass
// fakes; PwaUi.tsx passes the browser's).
import { t } from "./i18n/index.ts";

export interface OfflineStatus {
  /** off: no service worker (dev, unsupported); preparing: caching; ready: all cached. */
  state: "off" | "preparing" | "ready" | "error";
  done?: number;
  total?: number;
  version?: string;
}

export interface PwaState {
  online: boolean;
  /** The browser offered to install the app (beforeinstallprompt). */
  installable: boolean;
  /** Running as an installed app, or just installed. */
  installed: boolean;
  offline: OfflineStatus;
  /** A new version is waiting (or already took over in another tab). */
  update: boolean;
}

/** The parts of a service worker the page uses. */
export interface WorkerLike {
  state?: string;
  postMessage(msg: unknown): void;
  addEventListener(type: "statechange", f: () => void): void;
}

export interface RegistrationLike {
  active: WorkerLike | null;
  waiting: WorkerLike | null;
  installing: WorkerLike | null;
  addEventListener(type: "updatefound", f: () => void): void;
  update(): Promise<unknown>;
}

export interface ContainerLike {
  controller: unknown;
  ready: Promise<RegistrationLike>;
  register(url: string, options?: { scope?: string; updateViaCache?: "imports" | "all" | "none" }): Promise<RegistrationLike>;
  addEventListener(type: "message", f: (e: { data: unknown }) => void): void;
  addEventListener(type: "controllerchange", f: () => void): void;
  startMessages?(): void;
}

/** beforeinstallprompt (not in the DOM typings). */
export interface InstallPromptEvent {
  preventDefault(): void;
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface PwaEnv {
  /** navigator.serviceWorker; undefined where not supported. */
  sw?: ContainerLike;
  /** The service worker script, relative to the page. */
  swUrl: string;
  online(): boolean;
  /** window.addEventListener for online, offline, beforeinstallprompt, appinstalled. */
  on(type: string, f: (e: unknown) => void): void;
  standalone(): boolean;
  reload(): void;
  confirm(message: string): boolean;
}

export const UPDATE_TEXT = t("새 버전이 있습니다");
export const RUNNING_CONFIRM =
  t("시뮬레이션이 실행 중입니다. 새로 고치면 실행이 멈춥니다(배선과 펌웨어는 자동 저장되어 있습니다). 지금 새로 고칠까요?");

export interface Pwa {
  state(): PwaState;
  subscribe(f: () => void): () => void;
  /** Register the service worker and start listening. */
  start(): Promise<void>;
  /** Show the browser's install dialog. */
  install(): Promise<void>;
  /**
   * Switch to the waiting version and reload. Asks first while a
   * simulation runs; false when the user said no.
   */
  applyUpdate(running: boolean): boolean;
  /** Hide the banner until the next update. */
  dismissUpdate(): void;
}

export function createPwa(env: PwaEnv): Pwa {
  let state: PwaState = {
    online: env.online(),
    installable: false,
    installed: env.standalone(),
    offline: { state: "off" },
    update: false,
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<PwaState>) => {
    state = { ...state, ...patch };
    for (const f of listeners) f();
  };

  let reg: RegistrationLike | null = null;
  let deferred: InstallPromptEvent | null = null;
  let reloadOnChange = false;
  let hadController = false;

  env.on("online", () => {
    set({ online: true });
    reg?.update().catch(() => {});
  });
  env.on("offline", () => set({ online: false }));
  env.on("beforeinstallprompt", (e) => {
    deferred = e as InstallPromptEvent;
    deferred.preventDefault();
    set({ installable: true });
  });
  env.on("appinstalled", () => {
    deferred = null;
    set({ installable: false, installed: true });
  });

  const onMessage = (data: unknown) => {
    if (!data || typeof data !== "object") return;
    const m = data as { type?: string; ready?: boolean; done?: number; total?: number; cached?: number; version?: string };
    if (m.type === "STATUS") {
      set({ offline: m.ready ? { state: "ready", version: m.version } : { state: "preparing", done: m.cached, total: m.total, version: m.version } });
    } else if (m.type === "PROGRESS" && state.offline.state !== "ready") {
      set({ offline: { state: "preparing", done: m.done, total: m.total, version: m.version } });
    }
  };

  const watchInstalling = (w: WorkerLike | null) => {
    if (!w) return;
    w.addEventListener("statechange", () => {
      if (w.state === "installed" && env.sw?.controller) set({ update: true });
      if (w.state === "redundant" && !reg?.active) set({ offline: { state: "error" } });
    });
  };

  return {
    state: () => state,
    subscribe(f) {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    async start() {
      const sw = env.sw;
      if (!sw) return;
      hadController = !!sw.controller;
      sw.addEventListener("message", (e) => onMessage(e.data));
      sw.addEventListener("controllerchange", () => {
        if (reloadOnChange) env.reload();
        // Another tab switched to the new version: this page's files are
        // the old ones now, offer the reload here too.
        else if (hadController) set({ update: true });
        hadController = true;
      });
      sw.startMessages?.();
      set({ offline: { state: "preparing" } });
      try {
        reg = await sw.register(env.swUrl, { scope: "./", updateViaCache: "none" });
      } catch {
        set({ offline: { state: "error" } });
        return;
      }
      if (reg.waiting && sw.controller) set({ update: true });
      watchInstalling(reg.installing);
      reg.addEventListener("updatefound", () => watchInstalling(reg!.installing));
      const ready = await sw.ready;
      ready.active?.postMessage({ type: "GET_STATUS" });
    },
    async install() {
      const e = deferred;
      if (!e) return;
      deferred = null;
      set({ installable: false });
      await e.prompt();
      const choice = await e.userChoice;
      if (choice.outcome === "accepted") set({ installed: true });
    },
    applyUpdate(running) {
      if (running && !env.confirm(RUNNING_CONFIRM)) return false;
      const waiting = reg?.waiting;
      if (waiting) {
        reloadOnChange = true;
        waiting.postMessage({ type: "SKIP_WAITING" });
      } else {
        env.reload();
      }
      return true;
    },
    dismissUpdate() {
      set({ update: false });
    },
  };
}
