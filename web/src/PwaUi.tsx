// Offline app (M29) in the UI: the 설치 button, the 오프라인 badge, the
// offline-ready line and the update banner. See pwa.ts.
import { useSyncExternalStore } from "react";
import { createPwa, UPDATE_TEXT, type ContainerLike, type Pwa } from "./pwa";

const pwa: Pwa = createPwa({
  sw: "serviceWorker" in navigator ? (navigator.serviceWorker as unknown as ContainerLike) : undefined,
  swUrl: "./sw.js",
  online: () => navigator.onLine,
  on: (type, f) => window.addEventListener(type, f),
  standalone: () => window.matchMedia?.("(display-mode: standalone)").matches ?? false,
  reload: () => window.location.reload(),
  confirm: (m) => window.confirm(m),
});

/** Register the service worker: production builds only (not `vite dev`). */
export function startPwa() {
  if (import.meta.env.PROD) void pwa.start();
}

const usePwa = () => useSyncExternalStore(pwa.subscribe, pwa.state);

/**
 * Offline badge, install button, offline-ready status, at the right end of
 * the bottom panel's tab row: a slot that is always there and no taller than
 * the tabs (styles.css), so none of them appearing, going or changing its
 * text ever changes the layout — above all never the toolbar, whose height
 * moves the canvas under the user's pointer.
 */
export function PwaStatus() {
  const s = usePwa();
  const o = s.offline;
  return (
    <span className="pwa-slot" data-testid="pwa-slot">
      {!s.online && (
        <span className="offline-badge" data-testid="offline-badge" title="네트워크에 연결되어 있지 않습니다. 캐시된 앱으로 실행 중입니다.">
          오프라인
        </span>
      )}
      {s.installable && !s.installed && (
        <button className="install-btn" onClick={() => void pwa.install()} title="이 기기에 앱으로 설치합니다(인터넷 없이도 실행)">
          ⬇ 설치
        </button>
      )}
      {o.state !== "off" && (
        <span className="version offline-status" data-testid="offline-status" data-state={o.state} title={o.version ? `캐시 버전 ${o.version}` : undefined}>
          {o.state === "ready"
            ? "오프라인 사용 준비됨"
            : o.state === "error"
              ? "오프라인 준비 실패"
              : o.total
                ? `오프라인 준비 중 ${Math.floor(((o.done ?? 0) / o.total) * 100)}%`
                : "오프라인 준비 중…"}
        </span>
      )}
    </span>
  );
}

/** "새 버전이 있습니다 — 새로 고침": asks first while a simulation runs. */
export function UpdateBanner({ running }: { running: boolean }) {
  const s = usePwa();
  if (!s.update) return null;
  return (
    <div className="update-banner" role="status" data-testid="update-banner">
      {UPDATE_TEXT} —{" "}
      <button className="primary" onClick={() => pwa.applyUpdate(running)}>
        새로 고침
      </button>
      <button className="update-later" onClick={() => pwa.dismissUpdate()} aria-label="나중에" title="나중에">
        ✕
      </button>
    </div>
  );
}
