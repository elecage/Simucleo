/// <reference lib="webworker" />
// Runs the simulator off the UI thread and keeps it in step with wall time.
import init, { Simulator, version } from "../wasm/pkg/simucleo_wasm.js";
import type { FrameMsg, FromWorker, SimFrame, ToWorker } from "./protocol";
import type { SwvSettings } from "../run/swv";
import { batchDue, batchHz, RatioMeter } from "./perf";
import { attachTftPixels, tftPosted } from "./tftStore";
import { XmodemSender } from "../run/xmodem";

const FRAME_MS = 16; // ~60 Hz display updates
const WORK_BUDGET_MS = 12; // wall time we allow ourselves per frame

let sim: Simulator | null = null;
let loaded = false;
let running = false;
let speed = 1;
/** Upper bound on `speed` while grading needs fine-grained frames (Infinity: none). */
let speedCap = Infinity;
let lastWall = 0;
/** Achieved simulated time / wall time over the last 1.5 s (M31). */
const meter = new RatioMeter();
let achieved = 0;
/** Simulating time / wall time of the worker over the last 1.5 s (M31). */
const workMeter = new RatioMeter();
let workMs = 0;
let workShare = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let epoch = 0;
/** The `gen` of the last trigger message (see `FrameMsg.triggerGen`). */
let triggerGen = 0;
/** SWV settings while the trace is on (sent again after each load). */
let swvSettings: SwvSettings | null = null;

// M31: frames go to the page in batches at most `uiHz` times a second and
// only once it has drawn the last one (null: each frame at once, as
// before). The frames themselves are made exactly as before either way.
let uiHz: number | null = null;
let batch: FrameMsg[] = [];
let lastBatch = 0;
let inFlight = false;

// The virtual COM port's bytes (M37): text for the console, decoded here
// (a character split over two frames stays whole), except what an XMODEM
// transfer takes — it runs here, next to the simulation, on simulated time.
let decoder = new TextDecoder();
let consoleText = "";
let xm: XmodemSender | null = null;
let xmFile = { name: "", size: 0 };
/** While a transfer runs, the simulation advances in shorter steps so the
 * sender answers the receiver promptly (ms). */
const XMODEM_STEP_MS = 2;

/** The SFR view's subscription: registers read and peripherals' status sent with each frame. */
let sfrAddrs = new Uint32Array(0);
let sfrBases = new Uint32Array(0);

const simSeconds = () => (sim ? sim.timeMs() / 1000 : 0);

/** Take what the virtual COM port received: to the transfer, then the console. */
function drainConsole() {
  if (!sim) return;
  let bytes = sim.takeConsoleBytes();
  if (xm && !xm.done) {
    const r = xm.update(simSeconds(), bytes);
    if (r.tx.length) sim.consoleSendBytes(r.tx);
    bytes = r.passthrough;
  }
  if (bytes.length) consoleText += decoder.decode(bytes, { stream: true });
}

function xmodemReport() {
  if (!xm) return undefined;
  const report = { ...xm.status(), ...xmFile };
  // Reported once more in the frame it ended, then forgotten.
  if (xm.done) xm = null;
  return report;
}

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

function flush() {
  if (!batch.length) return;
  post({ type: "frames", frames: batch, speed: achieved, work: workShare }, tftPosted());
  batch = [];
  lastBatch = performance.now();
  inFlight = true;
}

/** Close a display frame; `now`: hand it over whatever the batching says. */
function sendFrame(now = true) {
  if (!sim) return;
  const frame = JSON.parse(sim.frame()) as SimFrame;
  // M35: a TFT display's pixels only when its picture changed.
  const s = sim;
  attachTftPixels(frame, (id) => s.tftPixels(id));
  drainConsole();
  const m: FrameMsg = { frame, console: consoleText, running, epoch, triggerGen };
  consoleText = "";
  if (swvSettings) m.swv = JSON.parse(sim.swvTake());
  const x = xmodemReport();
  if (x) m.xmodem = x;
  // The SFR view's registers: only those it subscribed to are read.
  if (sfrAddrs.length || sfrBases.length) {
    m.sfr = { addrs: sfrAddrs, values: sim.sfrRead(sfrAddrs), bases: sfrBases, status: sim.sfrStatus(sfrBases) };
  }
  const hz = batchHz(uiHz, speedCap);
  if (hz === null) {
    post({ type: "frame", ...m, speed: achieved, work: workShare }, tftPosted());
    return;
  }
  batch.push(m);
  if (now || batchDue(performance.now(), lastBatch, hz, inFlight)) flush();
}

function tick() {
  timer = null;
  if (!sim || !running) return;
  const now = performance.now();
  // Clamp: after the tab was in the background, do not try to catch up.
  const wallDt = Math.min(now - lastWall, 100);
  lastWall = now;
  const sp = Math.min(speed, speedCap);
  let target = Number.isFinite(sp) ? wallDt * sp : Infinity;
  while (target > 0 && performance.now() - now < WORK_BUDGET_MS) {
    const step = Math.min(target, xm && !xm.done ? XMODEM_STEP_MS : 10);
    const stopped = sim.runForMs(step);
    target -= step;
    if (xm) drainConsole();
    if (stopped) {
      running = false;
      break;
    }
    if (sim.atBreakpoint()) {
      running = false;
      flush(); // frames from before the stop come first
      post({ type: "paused", reason: sim.pauseReason() });
      break;
    }
    if (sim.triggerPaused()) {
      running = false;
      flush();
      post({ type: "paused", reason: "trigger" });
      break;
    }
  }
  const done = performance.now();
  meter.add(done, sim.timeMs());
  achieved = meter.ratio() ?? achieved;
  workMs += done - now;
  workMeter.add(done, workMs);
  workShare = workMeter.ratio() ?? workShare;
  // Stopped: shown at once, not with the next batch.
  sendFrame(!running);
  // The next tick FRAME_MS after this one began (M31: not FRAME_MS after
  // the work ended — that left the thread idle more than half the time
  // and a heavy example below real time on a machine fast enough for it).
  if (running) timer = setTimeout(tick, Math.max(1, FRAME_MS - (performance.now() - now)));
}

function start() {
  if (!loaded || running || !sim || sim.stopped()) return;
  running = true;
  achieved = 0;
  lastWall = performance.now();
  meter.reset();
  meter.add(lastWall, sim.timeMs());
  workMeter.reset();
  workMs = 0;
  workShare = 0;
  workMeter.add(lastWall, 0);
  timer = setTimeout(tick, 0);
}

function stop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  sendFrame();
}

/** Start (or stop, null) the SWV trace and report where its variables are. */
function configureSwv(settings: SwvSettings | null) {
  if (!sim) return;
  swvSettings = settings;
  const placed = JSON.parse(sim.swvConfigure(JSON.stringify(settings)));
  post({ type: "swvPlaced", placed });
}

/** Messages that need no simulator: taken even before it is ready. */
function setting(m: ToWorker): boolean {
  switch (m.type) {
    case "uiRate":
      // (The page sends its rate as soon as it connects, before the WASM
      // is loaded: kept, not dropped with the messages below.)
      uiHz = m.hz;
      if (uiHz === null) {
        // Back to single frames: hand over what is waiting first.
        flush();
        inFlight = false;
      }
      return true;
    case "ack":
      inFlight = false;
      return true;
    case "speedCap":
      speedCap = m.value;
      // Grading (a finite cap) takes single frames: hand over what waits.
      if (batchHz(uiHz, speedCap) === null) {
        flush();
        inFlight = false;
      }
      return true;
    default:
      return false;
  }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (setting(m) || !sim) return;
  switch (m.type) {
    case "load":
      stop();
      xm?.abort("reload");
      decoder = new TextDecoder();
      consoleText = "";
      try {
        sim.loadElf(new Uint8Array(m.bytes));
        loaded = true;
        post({ type: "loaded", name: m.name });
        // The trace settings name variables: resolve them in this firmware.
        if (swvSettings) configureSwv(swvSettings);
      } catch (err) {
        loaded = false;
        post({ type: "loaded", name: m.name, error: String(err) });
      }
      sendFrame();
      break;
    case "run":
      start();
      break;
    case "pause":
      stop();
      post({ type: "paused", reason: m.reason ?? "pause" });
      break;
    case "reset": {
      const was = running;
      stop();
      if (m.epoch !== undefined) epoch = m.epoch;
      xm?.abort("reset");
      if (loaded) sim.reset();
      sendFrame();
      if (was) start();
      break;
    }
    case "speed":
      speed = m.value;
      break;
    case "press":
      sim.press(m.part, m.pressed);
      if (!running) sendFrame();
      break;
    case "wiring":
      try {
        sim.setWiring(m.circuit, m.catalog, m.signals);
      } catch (err) {
        console.error("setWiring", err);
      }
      if (!running) sendFrame();
      break;
    case "probes":
      sim.setProbes(JSON.stringify(m.pins));
      break;
    case "analogProbes":
      sim.setAnalogProbes(JSON.stringify(m.specs));
      break;
    case "trigger":
      triggerGen = m.gen;
      sim.setTrigger(m.config ? JSON.stringify(m.config) : "");
      break;
    case "armTrigger":
      triggerGen = m.gen;
      sim.armTrigger();
      break;
    case "console":
      sim.consoleSend(m.text);
      break;
    case "xmodemSend": {
      if (xm && !xm.done) sim.consoleSendBytes(xm.cancel());
      const bytes = new Uint8Array(m.bytes);
      xm = new XmodemSender(bytes, simSeconds());
      xmFile = { name: m.name, size: bytes.length };
      // (A 'C' already waiting in the port starts it at once.)
      if (!running) sendFrame();
      break;
    }
    case "xmodemCancel":
      if (xm && !xm.done) sim.consoleSendBytes(xm.cancel());
      if (!running) sendFrame();
      break;
    case "bluetooth":
      sim.bluetoothSend(m.part, m.text);
      if (!running) sendFrame();
      break;
    case "bluetoothConnect":
      sim.bluetoothConnect(m.part, m.on);
      if (!running) sendFrame();
      break;
    case "readMemory":
      post({ type: "memory", addr: m.addr, bytes: sim.readMemory(m.addr, m.len) });
      break;
    case "rotate":
      sim.rotate(m.part, m.detents);
      if (!running) sendFrame();
      break;
    case "debugFiles":
      post({ type: "debugFiles", files: JSON.parse(sim.debugFiles()) });
      break;
    case "breakpoints":
      post({ type: "breakpoints", placed: JSON.parse(sim.setBreakpoints(JSON.stringify(m.list))) });
      break;
    case "step": {
      stop();
      const r = sim.step(m.kind);
      sendFrame();
      post({ type: "paused", reason: r });
      break;
    }
    case "disassemble":
      post({ type: "disasm", rows: JSON.parse(sim.disassemble(m.addr ?? undefined, 12, 24)) });
      break;
    case "evaluate": {
      const s = sim;
      post({ type: "watch", values: m.exprs.map((e) => JSON.parse(s.evaluate(e, m.frame))) });
      break;
    }
    case "selectTask":
      sim.selectTask(m.tcb ?? -1);
      break;
    case "swv":
      configureSwv(m.settings);
      break;
    case "watchpoints":
      post({ type: "watchpoints", placed: JSON.parse(sim.setWatchpoints(JSON.stringify(m.list), m.frame)) });
      break;
    case "setVariable": {
      const result = JSON.parse(sim.setVariable(m.target, m.value, m.frame));
      post({ type: "assigned", target: m.target, result });
      // Pins, LEDs and registers may show the change.
      sendFrame();
      break;
    }
    case "debugState":
      post({ type: "debugState", state: JSON.parse(sim.debugState(m.frame, m.globalsFile)) });
      break;
    case "sdImage":
      post({ type: "sdImage", part: m.part, bytes: sim.sdImage(m.part) });
      break;
    case "sdLoad":
      sim.sdLoad(m.part, new Uint8Array(m.bytes));
      if (!running) sendFrame();
      break;
    case "sdSnapshot":
      post({ type: "sdSnapshot", part: m.part, bytes: sim.sdSnapshot(m.part) });
      break;
    case "sdRestore":
      sim.sdRestore(m.part, new Uint8Array(m.bytes));
      if (!running) sendFrame();
      break;
    case "sdWipe":
      sim.sdWipe(m.part);
      if (!running) sendFrame();
      break;
    case "sfrSubscribe":
      sfrAddrs = Uint32Array.from(m.addrs);
      sfrBases = Uint32Array.from(m.bases);
      // The values at once, also while paused (a running one sends them with its next frame).
      if (!running && (sfrAddrs.length || sfrBases.length)) sendFrame();
      break;
    case "sfrWrite":
      // Messages are taken between the run's steps: the write lands there.
      sim.sfrWrite(m.addr >>> 0, m.value >>> 0);
      if (!running) sendFrame();
      break;
  }
};

init().then(() => {
  sim = new Simulator();
  // RTC modules start at the local date and time.
  sim.setWallClock(Date.now() / 1000 - new Date().getTimezoneOffset() * 60);
  post({ type: "ready", version: version() });
});
