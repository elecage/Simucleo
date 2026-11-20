import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "./editor/Canvas";
import { buildSchematic } from "./schematic/layout";
import { SchematicView, type SchEnd } from "./schematic/SchematicView";
import { boardExit, choosePin, routePoints } from "./schematic/wiring";
import { josa } from "./lessons/korean";
import { defaultProject, newId, pinKey, pinPosition, toCircuit, type PinRef, type Project } from "./editor/model";
import { PARTS, PART_BY_KIND } from "./parts";
import { nucleoSignal } from "./parts/nucleo";
import { BottomPanel } from "./run/BottomPanel";
import type { ScopeSettings } from "./run/scopeSettings";
import { RunControls, useExamples, type Example } from "./run/RunControls";
import { ProjectMenu, saveProjectFile } from "./run/ProjectMenu";
import { fromBase64, idbGet, idbSet, parse, serialize, toBase64, type Loaded } from "./editor/project";
import { createSimulator, type Netlist, type SimHandle } from "./sim/simulator";
import { useRunner } from "./sim/useRunner";
import { PwaStatus, UpdateBanner } from "./PwaUi";
import { useSdPersistence } from "./sim/sdStore";
import { unlockAudio, useBuzzerAudio } from "./sim/audio";
import type { VisualState } from "./parts/types";
import { colorCode, eSeries, formatOhms, parseOhms, type BandCount } from "./parts/ohms";
import { LessonPanel } from "./lessons/LessonPanel";
import { LessonEditor } from "./lessons/LessonEditor";
import { TeacherView } from "./lessons/TeacherView";
import type { Involved } from "./lessons/fromWiring";
import { blankLesson, DRAFT_KEY, MINE_KEY, normalizeLesson, removeLesson, upsertLesson } from "./lessons/mine";
import { ACTIVE_KEY, BACKUP_KEY } from "./lessons/progress";
import type { LoadedResult } from "./lessons/teacher";
import type { Lesson } from "./lessons/types";
import type { WiringContext } from "./lessons/wiring";
import { LESSONS } from "./lessons/index";
import type { ResultsFile } from "./lessons/progress";
import { ShareDialog, type ShareFirmware } from "./share/ShareDialog";
import { useSourceUpload } from "./upload/useSourceUpload";
import { fromDataTransfer } from "./upload/folder";
import { ReceiveDialog } from "./share/ReceiveDialog";
import { decodeShare, findFragment, type Received } from "./share/link";

const WIRE_COLORS = ["#e53935", "#1e88e5", "#43a047", "#fdd835", "#fb8c00", "#8e24aa", "#212121"];
const CATEGORY_LABEL: Record<string, string> = {
  board: "보드", basic: "기본", input: "입력", output: "출력",
  actuator: "구동", display: "디스플레이", sensor: "센서", module: "모듈",
};

const PROP_LABEL: Record<string, string> = {
  bands: "색띠 수",
  tolerance: "오차",
  tempco: "온도계수 (ppm/K, 6띠)",
  color: "색",
  common: "공통 단자",
  address: "I2C 주소",
  size: "카드 용량 (MB)",
  model: "모델",
  layout: "모양",
  count: "LED 수",
  beta: "B 상수",
};

const BAND_KO: Record<string, string> = {
  black: "검정", brown: "갈색", red: "빨강", orange: "주황", yellow: "노랑", green: "초록", blue: "파랑",
  violet: "보라", grey: "회색", white: "흰색", gold: "금색", silver: "은색", pink: "분홍",
};

/** Parsed resistance, its colour code in words and its E series. */
function OhmsInfo({ r, props }: { r: number | null; props: Record<string, string | number> }) {
  if (!r) {
    return (
      <span className="error" data-testid="ohms-parsed">
        알 수 없는 값 (예: 220, 4.7k, 4k7, 1M)
      </span>
    );
  }
  const n = Number(props.bands);
  const bands = (n === 3 || n === 5 || n === 6 ? n : 4) as BandCount;
  const code = colorCode(r, bands, String(props.tolerance), String(props.tempco));
  const series = eSeries(r);
  return (
    <span className="dim" data-testid="ohms-parsed">
      {formatOhms(r)} · {code.colors.map((c) => BAND_KO[c] ?? c).join("-")}
      <br />
      {series ? `표준값 ${series}` : "E 계열 표준값이 아닙니다"}
      {code.rounded && (
        <>
          <br />
          <span className="error">
            {bands}띠로는 {formatOhms(code.coded)}로 표시됩니다 (유효숫자 {bands >= 5 ? 3 : 2}자리)
          </span>
        </>
      )}
      {code.outOfRange && (
        <>
          <br />
          <span className="error">색띠로 나타낼 수 있는 범위를 벗어났습니다</span>
        </>
      )}
      {bands === 3 && (
        <>
          <br />
          3띠는 오차 띠가 없습니다 (±20%)
        </>
      )}
    </span>
  );
}

export function App() {
  const [sim, setSim] = useState<SimHandle | null>(null);
  const [simError, setSimError] = useState<string | null>(null);
  const [project, setProject] = useState<Project>(defaultProject);
  const [selected, setSelected] = useState<string | null>(null);
  // Breadboard (where wires go) or schematic (what connects to what).
  const [view, setView] = useState<"board" | "schematic">("board");
  // The schematic lists every MCU pin (to wire one not in use yet).
  const [allPins, setAllPins] = useState(false);
  // Part order of the last schematic drawn, so a wire does not reshuffle it;
  // forgotten when another project is opened.
  const schOrder = useRef<string[]>([]);
  const [wireColor, setWireColor] = useState(WIRE_COLORS[0]);
  const runner = useRunner();
  const examples = useExamples();
  const [projectName, setProjectName] = useState("새 프로젝트");
  const [notice, setNotice] = useState<string | null>(null);
  const [fitKey, setFitKey] = useState(0);
  // The editor fits the circuit into its viewport: not while hidden (it has
  // no size then), so a fit asked for meanwhile waits for the board view.
  const [shownFitKey, setShownFitKey] = useState(0);
  useEffect(() => {
    if (view === "board") setShownFitKey(fitKey);
  }, [view, fitKey]);
  /** Centre of the visible canvas, in grid units: where new parts go. */
  const viewCenter = useRef({ x: 60, y: 30 });
  const [reveal, setReveal] = useState<{ id: string; seq: number } | undefined>();

  // ------------------------------------------------ project files
  const { load } = runner;
  // The waveform view takes the project's settings again when this changes.
  const [scopeSeq, setScopeSeq] = useState(0);
  const onScope = useCallback(
    (scope: ScopeSettings) => setProject((p) => (p.scope === scope ? p : { ...p, scope })),
    [],
  );
  // Every load (a project, an example, a link, the autosave, an upload)
  // takes a number; one that finishes after a newer one started gives way,
  // so a slow restore of the last session never replaces what the user has
  // just opened. Firmware has its own count: a project file without firmware
  // keeps the firmware, even one still on its way (a lesson's).
  const loadGen = useRef(0);
  const fwGen = useRef(0);
  const applyLoaded = useCallback(
    async (l: Loaded) => {
      ++loadGen.current;
      schOrder.current = [];
      setProject(l.project);
      setScopeSeq((k) => k + 1);
      setFitKey((k) => k + 1);
      setSelected(null);
      setProjectName(l.name ?? "프로젝트");
      setNotice(l.notes.length ? l.notes.join("\n") : null);
      const fw = l.firmware;
      if (fw?.data) {
        ++fwGen.current;
        load(fw.name, fromBase64(fw.data).buffer as ArrayBuffer, fw.example);
      } else if (fw?.example) {
        const gen = ++fwGen.current;
        const r = await fetch(`./examples/${fw.example}`);
        const bytes = r.ok ? await r.arrayBuffer() : null;
        if (gen !== fwGen.current) return;
        if (bytes) load(fw.name, bytes, fw.example);
        else setNotice(`예제 펌웨어 ${fw.example}을 찾지 못했습니다.`);
      }
    },
    [load],
  );
  const openText = useCallback(
    (text: string) => {
      try {
        void applyLoaded(parse(text));
      } catch (e) {
        setNotice(`프로젝트를 열지 못했습니다: ${(e as Error).message}`);
      }
    },
    [applyLoaded],
  );
  const dirty = project.wires.length > 0 || project.parts.length > defaultProject().parts.length;
  const confirmReplace = () => !dirty || window.confirm("지금 배선을 바꿀까요? 저장하지 않은 내용은 사라집니다.");
  const onNew = () => {
    if (!confirmReplace()) return;
    schOrder.current = [];
    setProject(defaultProject());
    setScopeSeq((k) => k + 1);
    setProjectName("새 프로젝트");
    setSelected(null);
  };
  // ------------------------------------------------------------ lessons
  const [lessonOpen, setLessonOpen] = useState(false);
  const [hasBackup, setHasBackup] = useState(false);
  // M24: "내 레슨", the lesson editor's draft and preview, the teacher view.
  const [myLessons, setMyLessons] = useState<Lesson[]>([]);
  const [mineLoaded, setMineLoaded] = useState(false);
  const [draft, setDraft] = useState<Lesson | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [preview, setPreview] = useState<{ lesson: Lesson; seq: number } | null>(null);
  const [teacherOpen, setTeacherOpen] = useState(false);
  const [teacherFiles, setTeacherFiles] = useState<LoadedResult[]>([]);
  const [gradeMarks, setGradeMarks] = useState<Involved[] | null>(null);
  useEffect(() => {
    void idbGet<string>(ACTIVE_KEY).then((a) => a && setLessonOpen(true));
    void idbGet<string>(BACKUP_KEY).then((b) => setHasBackup(!!b));
    // Stored lessons are normalized: a broken one (an older version, an edited
    // database) shows its errors instead of crashing the list or the editor.
    void idbGet<unknown>(MINE_KEY).then((l) => {
      setMyLessons(Array.isArray(l) ? l.map(normalizeLesson).filter((x): x is Lesson => x !== null) : []);
      setMineLoaded(true);
    });
    void idbGet<unknown>(DRAFT_KEY).then((d) => {
      const n = normalizeLesson(d);
      if (n) setDraft(n);
    });
  }, []);
  const saveMine = (lessons: Lesson[]) => {
    const next = lessons.reduce(upsertLesson, myLessons);
    setMyLessons(next);
    void idbSet(MINE_KEY, next);
  };
  const removeMine = (id: string) => {
    const next = removeLesson(myLessons, id);
    setMyLessons(next);
    void idbSet(MINE_KEY, next);
  };
  const changeDraft = (l: Lesson) => {
    setDraft(l);
    void idbSet(DRAFT_KEY, l);
  };
  const openEditor = (l: Lesson | null) => {
    if (l) changeDraft(normalizeLesson(structuredClone(l)) ?? blankLesson(myLessons.map((m) => m.id)));
    else if (!draft) changeDraft(blankLesson(myLessons.map((m) => m.id)));
    setEditorOpen(true);
  };
  const startLesson = async (lesson: Lesson): Promise<boolean> => {
    if (
      dirty &&
      !window.confirm(
        `실습 '${lesson.title}'을(를) 시작하면 지금 회로가 실습의 시작 회로로 바뀝니다.\n` +
          "지금 프로젝트는 백업해 두며, 실습 목록의 '실습 전 프로젝트 되돌리기'로 다시 열 수 있습니다. " +
          "파일로 남기려면 취소하고 먼저 '저장'하세요.",
      )
    ) {
      return false;
    }
    if (dirty) {
      const fw = firmware ? { name: firmware, example: firmwareExample ?? undefined, data: firmwareBytes ? toBase64(firmwareBytes) : undefined } : undefined;
      await idbSet(BACKUP_KEY, serialize(project, projectName, fw));
      setHasBackup(true);
    }
    let loaded: Loaded;
    try {
      const st = lesson.start;
      if (st === "empty") loaded = { project: defaultProject(), notes: [] };
      else if ("example" in st) {
        const r = await fetch(`./examples/${st.example}`);
        if (!r.ok) throw new Error(`${st.example}을(를) 찾지 못했습니다`);
        loaded = parse(await r.text());
      } else loaded = parse(JSON.stringify(st.project));
    } catch (e) {
      setNotice(`실습을 시작하지 못했습니다: ${(e as Error).message}`);
      return false;
    }
    const fw = lesson.firmware;
    loaded = {
      ...loaded,
      name: `실습: ${lesson.title}`,
      firmware: fw && fw !== "upload" ? { name: fw.example.replace(/\.elf$/, ""), example: fw.example } : undefined,
    };
    await applyLoaded(loaded);
    return true;
  };
  const restoreBackup = async () => {
    const text = await idbGet<string>(BACKUP_KEY);
    if (!text || !confirmReplace()) return;
    openText(text);
  };
  const setPartProp = useCallback(
    (kind: string, prop: string, value: number | string) =>
      setProject((p) => {
        const id = p.parts.find((q) => q.kind === kind)?.id;
        return id ? { ...p, parts: p.parts.map((q) => (q.id === id ? { ...q, props: { ...q.props, [prop]: value } } : q)) } : p;
      }),
    [],
  );

  const onExampleProject = async (ex: Example) => {
    if (!confirmReplace()) return;
    const gen = ++loadGen.current;
    const r = await fetch(`./examples/${ex.project}`);
    const text = r.ok ? await r.text() : null;
    if (text !== null && gen === loadGen.current) openText(text);
  };

  // Autosave to IndexedDB, and restore the last session once the
  // simulator is ready (so its firmware can be loaded too).
  const restored = useRef(false);
  // The autosave is back (or there was none): a share link may be opened now.
  const [restoredDone, setRestoredDone] = useState(false);
  useEffect(() => {
    if (!runner.ready || restored.current) return;
    const gen = loadGen.current;
    void idbGet<string>("autosave").then(async (text) => {
      restored.current = true;
      // Something was opened meanwhile: that stays.
      if (text && gen === loadGen.current) {
        try {
          await applyLoaded(parse(text));
        } catch {
          // A broken autosave is not worth a message.
        }
      }
      setRestoredDone(true);
    });
  }, [runner.ready, applyLoaded]);
  // ------------------------------------------------ share links (M30)
  const [share, setShare] = useState<{ mode: "share" | "teacher"; result?: ResultsFile; lesson?: { id: string; title: string } | null } | null>(null);
  const [activeLesson, setActiveLesson] = useState<{ id: string; title: string } | null>(null);
  const [lessonKey, setLessonKey] = useState(0);
  // A link opened (#s1=…): asked about once the autosave is back.
  const [incoming, setIncoming] = useState<{ received?: Received; error?: string } | null>(null);
  useEffect(() => {
    const read = () => {
      if (!findFragment(location.hash)) return;
      decodeShare(location.hash, PART_BY_KIND).then(
        (received) => setIncoming({ received }),
        (e: Error) => setIncoming({ error: e.message }),
      );
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  /** Take the link out of the address bar so a reload does not ask again. */
  const clearHash = () => history.replaceState(history.state, "", location.pathname + location.search);
  const lessonById = (id: string) => [...LESSONS.map((e) => e.lesson), ...myLessons].find((l) => l.id === id) ?? null;
  const openIncoming = async () => {
    const r = incoming?.received;
    if (!r || !confirmReplace()) return;
    clearHash();
    setIncoming(null);
    restored.current = true;
    await applyLoaded(r.loaded);
    if (r.lesson && lessonById(r.lesson)) {
      await idbSet(ACTIVE_KEY, r.lesson);
      setLessonKey((k) => k + 1);
      setLessonOpen(true);
    }
  };
  const cancelIncoming = () => {
    clearHash();
    setIncoming(null);
  };

  // ------------------------------------- project folder / zip (M39)
  const userLoad = useCallback(() => {
    ++loadGen.current;
    ++fwGen.current;
  }, []);
  const sourceUpload = useSourceUpload(runner, userLoad);
  // Files dragged over the window: a fixed overlay (it moves nothing), and a
  // drop anywhere that nobody else took (the teacher view takes its own).
  const [dropping, setDropping] = useState(false);
  const { upload: uploadBundle } = sourceUpload;
  useEffect(() => {
    let depth = 0;
    const files = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    const enter = (e: DragEvent) => {
      if (!files(e)) return;
      depth++;
      setDropping(true);
    };
    const leave = (e: DragEvent) => {
      if (!files(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDropping(false);
    };
    const over = (e: DragEvent) => {
      if (files(e) && !e.defaultPrevented) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      depth = 0;
      setDropping(false);
      if (!files(e) || e.defaultPrevented) return;
      e.preventDefault();
      void fromDataTransfer(e.dataTransfer!).then(uploadBundle, (err: Error) =>
        setNotice(`끌어다 놓은 것을 읽지 못했습니다: ${err.message}`),
      );
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [uploadBundle]);

  // SD cards keep what the firmware wrote, per project (IndexedDB).
  const sdCards = useSdPersistence(runner, project, projectName);
  const { firmware, firmwareBytes, firmwareExample } = runner;
  useEffect(() => {
    if (!restored.current) return;
    const t = setTimeout(() => {
      const fw = firmware
        ? { name: firmware, example: firmwareExample ?? undefined, data: firmwareBytes ? toBase64(firmwareBytes) : undefined }
        : undefined;
      void idbSet("autosave", serialize(project, projectName, fw));
    }, 400);
    return () => clearTimeout(t);
  }, [project, projectName, firmware, firmwareBytes, firmwareExample]);

  // What each part shows, from the circuit simulation. The board's LD2 is
  // simulated like any LED (PA5 → resistor → LED → GND).
  const boardId = project.parts.find((p) => p.kind === "nucleo-f401re")?.id;
  const visuals = useMemo<Record<string, VisualState>>(() => {
    const out: Record<string, VisualState> = {};
    for (const v of runner.frame?.parts ?? []) {
      const state: VisualState = {
        brightness: v.brightness?.[0],
        channels: v.brightness,
        overcurrent: v.overcurrent,
        on: v.on,
        freq: v.freq,
        angle: v.angle,
        rpm: v.rpm,
        unpowered: v.unpowered,
        screen: v.screen,
        text: v.text,
        leds: v.leds,
        lcd: v.lcd,
        matrix: v.matrix,
        closed: v.closed,
        register: v.register,
        digits: v.digits,
        motor: v.motor,
      };
      if (v.id === "LD2") {
        if (boardId) out[boardId] = { ...out[boardId], brightness: state.brightness, overcurrent: state.overcurrent };
      } else if (v.id !== "B1") {
        out[v.id] = state;
      }
    }
    return out;
  }, [runner.frame, boardId]);
  const [sound, setSound] = useState(false);
  useBuzzerAudio(visuals, project.parts, sound && runner.running);

  const { press, reset, setWiring, ready, rotate } = runner;
  const onPartAction = useCallback(
    (part: string, action: string, down: boolean) => {
      if (action === "b1") press("B1", down);
      else if (action === "reset") {
        if (down) reset();
      } else if (action === "press") press(part, down);
      else if (action.startsWith("key:")) press(`${part}:${action.slice(4)}`, down);
      else if ((action === "cw" || action === "ccw") && down) rotate(part, action === "cw" ? 1 : -1);
    },
    [press, reset, rotate],
  );

  // Hot-plug into the running simulation: every edit re-sends the wiring.
  useEffect(() => {
    if (ready) setWiring(toCircuit(project));
  }, [ready, project, setWiring]);

  useEffect(() => {
    createSimulator().then(setSim, (e) => setSimError(String(e)));
  }, []);

  // Hot-plug: every edit re-sends the circuit, even while firmware runs.
  const netlist: Netlist = useMemo(
    () => (sim ? sim.setCircuit(toCircuit(project)) : { nets: [] }),
    [sim, project],
  );
  const netIndex = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const net of netlist.nets) {
      const set = new Set(net.pins.map(pinKey));
      for (const k of set) m.set(k, set);
    }
    return m;
  }, [netlist]);
  const schematic = useMemo(() => {
    const s = buildSchematic(project, netlist, { allPins, order: schOrder.current });
    schOrder.current = s.symbols.filter((x) => x.shape !== "mcu").map((x) => x.part);
    return s;
  }, [project, netlist, allPins]);
  const netOf = useCallback((p: PinRef) => netIndex.get(pinKey(p)) ?? new Set([pinKey(p)]), [netIndex]);

  // Grading marks (M24): the pins of failed wiring checks with their nets,
  // and the board pins of the signals they name.
  const markSet = useMemo(() => {
    if (!gradeMarks) return undefined;
    const out = new Set<string>();
    const board = project.parts.find((p) => p.kind === "nucleo-f401re");
    for (const m of gradeMarks) {
      for (const p of m.pins) for (const k of netOf(p)) out.add(k);
      if (!board) continue;
      for (const pin of PART_BY_KIND[board.kind].pins) {
        if (m.signals.includes(nucleoSignal(pin.id) ?? "")) out.add(pinKey({ part: board.id, pin: pin.id }));
      }
    }
    return out;
  }, [gradeMarks, netOf, project.parts]);
  // The circuit as the lesson editor's "현재 배선에서 검사 만들기" reads it.
  const wiringCtx = useMemo<WiringContext>(
    () => ({
      parts: project.parts,
      nets: netlist.nets,
      boardSignal: (kind, pin) => (kind === "nucleo-f401re" ? nucleoSignal(pin) : undefined),
      nameOf: (kind) => PART_BY_KIND[kind]?.name ?? kind,
      warnings: [],
    }),
    [project.parts, netlist],
  );

  // Nets that join two or more parts (breadboards excluded), with Nucleo pins
  // shown by signal so D13 and CN10-11 both read "nucleo.PA5".
  const visibleNets = useMemo(() => {
    const out: string[] = [];
    for (const net of netlist.nets) {
      const names = new Set<string>();
      const parts = new Set<string>();
      for (const p of net.pins) {
        const kind = project.parts.find((q) => q.id === p.part)?.kind;
        if (kind?.startsWith("breadboard")) continue;
        names.add(kind === "nucleo-f401re" ? `${p.part}.${nucleoSignal(p.pin)}` : `${p.part}.${p.pin}`);
        parts.add(p.part);
      }
      if (parts.size >= 2) out.push([...names].sort().join(" — "));
    }
    return out.sort();
  }, [netlist, project.parts]);

  const taken = () => new Set([...project.parts.map((p) => p.id), ...project.wires.map((w) => w.id)]);

  // ------------------------------------------------ wiring on the schematic
  /** How a pin end is called in messages: nucleo.PA5, r1.2. */
  const endLabel = (e: SchEnd) => {
    const kind = project.parts.find((p) => p.id === e.part)?.kind;
    return `${e.part}.${kind === "nucleo-f401re" ? (nucleoSignal(e.ids[0]) ?? e.ids[0]) : e.ids.join("/")}`;
  };
  const netOfEnd = (e: SchEnd) =>
    schematic.symbols.find((s) => s.part === e.part)?.pins.find((p) => p.ids.join("/") === e.ids.join("/"))?.net ?? null;

  /** A wire drawn on the schematic: a real wire between the two pins, so it
   * is on the breadboard too, routed with square bends. */
  const connectEnds = (a: SchEnd, b: SchEnd) => {
    const pa = project.parts.find((p) => p.id === a.part);
    const pb = project.parts.find((p) => p.id === b.part);
    if (!pa || !pb) return;
    const same = a.ids.some((x) => b.ids.some((y) => netOf({ part: a.part, pin: x }).has(pinKey({ part: b.part, pin: y }))));
    if (same) {
      const n = netOfEnd(a);
      setNotice(
        `${josa(endLabel(a), "와/과")} ${endLabel(b)}는 이미 같은 넷${n ? `(${n})` : ""}에 연결되어 있어 와이어를 더하지 않았습니다.`,
      );
      return;
    }
    const used = new Set(project.wires.flatMap((w) => [pinKey(w.a), pinKey(w.b)]));
    const options = (part: typeof pa, ids: string[]) =>
      ids.flatMap((id) => {
        const at = pinPosition(part, id);
        return at ? [{ id, at, used: used.has(pinKey({ part: part.id, pin: id })) }] : [];
      });
    const optA = options(pa, a.ids);
    const optB = options(pb, b.ids);
    if (!optA.length || !optB.length) return;
    // Each end on the pin of its terminal nearest the other end.
    const ca = choosePin(optA, optB[0].at)!;
    const cb = choosePin(optB, ca.at)!;
    // A lane of its own beside the board's other wires (four, then again).
    const onBoard = (r: PinRef) => project.parts.find((q) => q.id === r.part)?.kind === "nucleo-f401re";
    const lane = project.wires.filter((w) => onBoard(w.a) || onBoard(w.b)).length % 4;
    const exit = (part: typeof pa, y: number) => {
      const def = PART_BY_KIND[part.kind];
      return part.kind === "nucleo-f401re" && def ? boardExit(y, { y: part.y, h: def.h }, lane) : undefined;
    };
    const points = routePoints(ca.at, cb.at, exit(pa, ca.at.y), exit(pb, cb.at.y));
    setProject((p) => {
      const wire = {
        id: newId("w", new Set([...p.parts.map((q) => q.id), ...p.wires.map((w) => w.id)])),
        a: { part: pa.id, pin: ca.id },
        b: { part: pb.id, pin: cb.id },
        color: wireColor,
        ...(points.length ? { points } : {}),
      };
      return { ...p, wires: [...p.wires, wire] };
    });
  };

  /** "연결 끊기" on the schematic: the wires on that pin go. What still joins
   * it is the breadboard (a row, or pins on one point): moved there. */
  const disconnectEnd = (e: SchEnd) => {
    const keys = new Set(e.ids.map((id) => pinKey({ part: e.part, pin: id })));
    const removed = project.wires.filter((w) => keys.has(pinKey(w.a)) || keys.has(pinKey(w.b)));
    const next = { ...project, wires: project.wires.filter((w) => !removed.includes(w)) };
    const nl = sim ? sim.setCircuit(toCircuit(next)) : { nets: [] };
    const still = buildSchematic(next, nl, { allPins, order: schOrder.current })
      .symbols.find((s) => s.part === e.part)
      ?.pins.find((p) => p.ids.join("/") === e.ids.join("/"))?.net;
    const name = endLabel(e);
    if (removed.length) {
      setProject(next);
      if (removed.some((w) => w.id === selected)) setSelected(null);
    }
    if (still) {
      setNotice(
        `${removed.length ? `와이어 ${removed.length}개를 지웠지만 ` : ""}${josa(name, "은/는")} 아직 브레드보드(같은 줄이나 같은 구멍)를 통해 ${still}에 연결되어 있습니다. 브레드보드 보기에서 부품을 옮겨 연결을 끊으세요.`,
      );
    } else {
      setNotice(removed.length ? `${name}에서 와이어 ${removed.length}개를 지웠습니다.` : `${name}에는 연결된 와이어가 없습니다.`);
    }
  };

  const addPart = (kind: string) => {
    const def = PART_BY_KIND[kind];
    const id = newId(kind.split("-")[0], taken());
    // Drop the part where the user is looking: the first free spot around
    // the centre of the view, where none of its pins lands on an existing
    // pin (pins at the same point are connected) or inside its body.
    const used = new Set<string>();
    for (const p of project.parts) {
      for (const q of PART_BY_KIND[p.kind]?.pins ?? []) used.add(`${p.x + q.x},${p.y + q.y}`);
    }
    const c = viewCenter.current;
    const fits = (x: number, y: number) =>
      def.pins.every((q) => {
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (used.has(`${x + q.x + dx},${y + q.y + dy}`)) return false;
        return true;
      }) &&
      // Nor over another part's body (a board or breadboard would also plug
      // it in by accident); keep a one-step margin, and room for labels above.
      !project.parts.some((p) => {
        const d = PART_BY_KIND[p.kind];
        return d && x + def.w + 1 >= p.x && x - 1 <= p.x + d.w && y + def.h + 1 >= p.y - 1 && y - 2 <= p.y + d.h;
      });
    let x = Math.round(c.x - def.w / 2);
    let y = Math.round(c.y - def.h / 2);
    search: for (let ring = 0; ring < 40; ring++) {
      for (let i = -ring; i <= ring; i++) {
        for (const [dx, dy] of [[i * 2, -ring * 2], [i * 2, ring * 2], [-ring * 2, i * 2], [ring * 2, i * 2]]) {
          if (fits(x + dx, y + dy)) {
            x += dx;
            y += dy;
            break search;
          }
        }
      }
    }
    setProject((p) => ({ ...p, parts: [...p.parts, { id, kind, x, y, props: { ...def.props } }] }));
    setSelected(id);
    setReveal((r) => ({ id, seq: (r?.seq ?? 0) + 1 }));
  };

  const shareFirmware = useMemo<ShareFirmware | undefined>(
    () => (firmware ? { name: firmware, example: firmwareExample ?? undefined, bytes: firmwareBytes ?? undefined } : undefined),
    [firmware, firmwareExample, firmwareBytes],
  );

  const deleteSelected = useCallback(() => {
    if (!selected) return;
    setProject((p) => ({
      parts: p.parts.filter((x) => x.id !== selected),
      wires: p.wires.filter((w) => w.id !== selected && w.a.part !== selected && w.b.part !== selected),
    }));
    setSelected(null);
  }, [selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && !(e.target instanceof HTMLInputElement)) deleteSelected();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelected]);

  const selectedPart = project.parts.find((p) => p.id === selected);
  const selectedWire = project.wires.find((w) => w.id === selected);
  const selectedDef = selectedPart && PART_BY_KIND[selectedPart.kind];
  const categories = [...new Set(PARTS.map((p) => p.category))];

  return (
    <div className={lessonOpen ? "app with-lesson" : "app"}>
      <header className="toolbar">
        <strong>Simucleo</strong>
        {/* M30: the share button sits inside the name field's box, so the
            toolbar keeps its width budget and height (the canvas below must
            not move: drags in progress would land elsewhere). */}
        <span className="project-name-box">
          <input
            className="project-name"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            aria-label="프로젝트 이름"
          />
          <button
            className="share-btn"
            onClick={() => setShare({ mode: "share", lesson: activeLesson })}
            aria-label="🔗 공유"
            title="회로·펌웨어·설정을 링크나 QR 코드로 보내기 (주소의 # 뒤에 담겨 서버로 가지 않습니다)"
          >
            🔗 공유
          </button>
        </span>
        <ProjectMenu project={project} name={projectName} runner={runner} onNew={onNew} onOpenText={openText} />
        <RunControls runner={runner} examples={examples} onExampleProject={onExampleProject} onUserLoad={userLoad} />
        <button
          className={lessonOpen ? "lesson-toggle on" : "lesson-toggle"}
          onClick={() => {
            if (lessonOpen) setPreview(null);
            setLessonOpen(!lessonOpen);
          }}
          aria-pressed={lessonOpen}
          title="단계별 실습과 자동 채점"
        >
          📝 실습
        </button>
        <label className="sound-toggle" title="부저 소리 (브라우저 정책상 클릭으로 켜야 합니다)">
          <input
            type="checkbox"
            checked={sound}
            onChange={(e) => {
              if (e.target.checked) unlockAudio();
              setSound(e.target.checked);
            }}
          />{" "}
          🔊 소리
        </label>
        <span className="version" title="시뮬레이터 코어 버전">
          {simError ? `WASM 로드 실패: ${simError}` : sim ? `core v${sim.version}` : "WASM 로딩 중…"}
        </span>
      </header>
      <UpdateBanner running={runner.running} />

      <aside className="library">
        {categories.map((cat) => (
          <section key={cat}>
            <h3>{CATEGORY_LABEL[cat]}</h3>
            {PARTS.filter((p) => p.category === cat).map((p) => (
              <button key={p.kind} onClick={() => addPart(p.kind)}>{p.name}</button>
            ))}
          </section>
        ))}
        <section>
          <h3>와이어 색</h3>
          <div className="swatches">
            {WIRE_COLORS.map((c) => (
              <button
                key={c}
                className={c === wireColor ? "swatch on" : "swatch"}
                style={{ background: c }}
                onClick={() => setWireColor(c)}
                aria-label={c}
              />
            ))}
          </div>
        </section>
      </aside>

      <main className={view === "schematic" ? "schematic-on" : undefined}>
        <div className="view-toggle" role="group" aria-label="보기">
          <button className={view === "board" ? "on" : ""} onClick={() => setView("board")}>
            브레드보드
          </button>
          <button className={view === "schematic" ? "on" : ""} onClick={() => setView("schematic")}>
            회로도
          </button>
        </div>
        {view === "schematic" && (
          <SchematicView
            schematic={schematic}
            pins={runner.frame?.pins}
            visuals={visuals}
            selected={selected}
            onSelect={setSelected}
            parts={project.parts}
            onAction={onPartAction}
            allPins={allPins}
            onAllPins={setAllPins}
            onConnect={connectEnds}
            onDisconnect={disconnectEnd}
            marks={markSet}
          />
        )}
        <div className="view-board" hidden={view !== "board"}>
          <Canvas
            project={project}
            netOf={netOf}
            selected={selected}
            onSelect={setSelected}
            onMovePart={(id, x, y) =>
              setProject((p) => ({ ...p, parts: p.parts.map((q) => (q.id === id ? { ...q, x, y } : q)) }))
            }
            visuals={visuals}
            onPartAction={onPartAction}
            fitKey={shownFitKey}
            onViewCenter={(p) => (viewCenter.current = p)}
            reveal={reveal}
            marks={markSet}
            onAddWire={(a, b, points) =>
              setProject((p) => {
                // Both ends must exist when the wire is made (#2).
                const exists = (r: PinRef) => p.parts.some((q) => q.id === r.part);
                if (!exists(a) || !exists(b)) return p;
                const wire = { id: newId("w", taken()), a, b, color: wireColor, ...(points.length ? { points } : {}) };
                return { ...p, wires: [...p.wires, wire] };
              })
            }
            onPropChange={(id, key, value) =>
              setProject((p) => ({
                ...p,
                parts: p.parts.map((q) => (q.id === id ? { ...q, props: { ...q.props, [key]: value } } : q)),
              }))
            }
            onMoveWireEnd={(id, end, pin) =>
              setProject((p) => ({ ...p, wires: p.wires.map((w) => (w.id === id ? { ...w, [end]: pin } : w)) }))
            }
            onUpdateWire={(id, points) =>
              setProject((p) => ({ ...p, wires: p.wires.map((w) => (w.id === id ? { ...w, points } : w)) }))
            }
          />
        </div>
        {runner.frame?.stopped && (
          <div className="diagnosis" role="alert">
            <b>펌웨어가 멈췄습니다.</b> {runner.frame.stopped}
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            {notice} <button onClick={() => setNotice(null)} aria-label="닫기">×</button>
          </div>
        )}
        <div className="warnings">
          {runner.frame?.circuitWarnings.map((w) => (
            <div key={w} className="warning circuit" data-testid="circuit-warning">
              ⚡ 전기 규칙: {w}
            </div>
          ))}
          {runner.frame?.warnings.map((w) => (
            <div key={w} className="warning">
              ⚠ {w}
            </div>
          ))}
        </div>
      </main>

      <BottomPanel
        runner={runner}
        parts={project.parts}
        scope={project.scope}
        scopeSeq={scopeSeq}
        onScope={onScope}
        status={<PwaStatus />}
        upload={sourceUpload}
      />
      {dropping && !teacherOpen && (
        <div className="drop-overlay" data-testid="drop-overlay">
          📁 프로젝트 폴더나 zip(ELF·소스)을 놓으면 불러옵니다
        </div>
      )}

      {lessonOpen && (
        <LessonPanel
          key={lessonKey}
          runner={runner}
          mineLoaded={mineLoaded}
          project={project}
          netlist={netlist}
          onStart={startLesson}
          onSetProp={setPartProp}
          onRestoreBackup={() => void restoreBackup()}
          hasBackup={hasBackup}
          onClose={() => {
            setLessonOpen(false);
            setPreview(null);
          }}
          myLessons={myLessons}
          onSaveMine={saveMine}
          onRemoveMine={removeMine}
          onEdit={openEditor}
          onTeacher={() => setTeacherOpen(true)}
          preview={preview}
          onMarks={setGradeMarks}
          onActive={setActiveLesson}
          onSendToTeacher={(result, lesson) => setShare({ mode: "teacher", result, lesson })}
        />
      )}
      {editorOpen && draft && (
        <LessonEditor
          draft={draft}
          onChange={changeDraft}
          examples={examples}
          project={project}
          wiring={wiringCtx}
          onSaveMine={(l) => saveMine([l])}
          onPreview={(l) => {
            setPreview((p) => ({ lesson: l, seq: (p?.seq ?? 0) + 1 }));
            setEditorOpen(false);
            setLessonOpen(true);
          }}
          onNew={() => changeDraft(blankLesson(myLessons.map((m) => m.id)))}
          onClose={() => setEditorOpen(false)}
        />
      )}
      {teacherOpen && <TeacherView files={teacherFiles} onFiles={setTeacherFiles} onClose={() => setTeacherOpen(false)} />}
      {share && (
        <ShareDialog
          project={project}
          name={projectName}
          firmware={shareFirmware}
          lesson={share.lesson ?? undefined}
          result={share.result}
          mode={share.mode}
          onSaveFile={() => saveProjectFile(project, projectName, runner, true)}
          onClose={() => setShare(null)}
        />
      )}
      {incoming && restoredDone && (
        <ReceiveDialog
          incoming={incoming}
          current={{ name: projectName, parts: project.parts.length, wires: project.wires.length, dirty }}
          lessonTitle={incoming.received?.lesson ? (lessonById(incoming.received.lesson)?.title ?? null) : null}
          onOpen={() => void openIncoming()}
          onCancel={cancelIncoming}
          onSaveCurrent={() => saveProjectFile(project, projectName, runner, true)}
          onAddResult={() => {
            const r = incoming.received?.result;
            if (r) setTeacherFiles((f) => [...f, r]);
            setTeacherOpen(true);
            cancelIncoming();
          }}
        />
      )}

      <aside className="inspector">
        <h3>속성</h3>
        {selectedPart && selectedDef ? (
          <>
            <p><b>{selectedPart.id}</b> · {selectedDef.name}</p>
            {selectedDef.description && <p className="hint">{selectedDef.description}</p>}
            {Object.entries(selectedPart.props).map(([k, v]) => {
              // Resistor: tolerance has no band on 3-band parts, the
              // temperature coefficient only on 6-band parts.
              const nb = String(selectedPart.props.bands ?? "");
              if ((k === "tolerance" && nb === "3") || (k === "tempco" && nb !== "6")) return null;
              const set = (value: string) =>
                setProject((p) => ({
                  ...p,
                  parts: p.parts.map((q) => (q.id === selectedPart.id ? { ...q, props: { ...q.props, [k]: value } } : q)),
                }));
              const setNum = (value: number) =>
                setProject((p) => ({
                  ...p,
                  parts: p.parts.map((q) => (q.id === selectedPart.id ? { ...q, props: { ...q.props, [k]: value } } : q)),
                }));
              const options = selectedDef.propOptions?.[k];
              const range = selectedDef.ranges?.[k];
              if (range) {
                // Live input: a slider (log scale for light), plus the value.
                const num = Number(v);
                const toSlider = (x: number) => (range.log ? Math.log10(Math.max(range.min, x)) : x);
                const fromSlider = (x: number) => (range.log ? Math.round(10 ** x) : x);
                return (
                  <label key={k} className="prop">
                    {range.label}: {range.unit ? `${num} ${range.unit}` : `${Math.round(num * 100)}%`}
                    <input
                      type="range"
                      aria-label={k}
                      min={toSlider(range.min)}
                      max={toSlider(range.max)}
                      step={range.log ? 0.01 : range.step}
                      value={toSlider(num)}
                      onChange={(e) => setNum(fromSlider(Number(e.target.value)))}
                    />
                  </label>
                );
              }
              if (k === "ohms") {
                // Any value: typed, or picked from common ones.
                const r = parseOhms(v);
                return (
                  <label key={k} className="prop">
                    저항값 (Ω)
                    <input value={String(v)} onChange={(e) => set(e.target.value)} list="ohms-list" aria-label={k} />
                    <datalist id="ohms-list">
                      {options?.map((o) => <option key={o} value={o} />)}
                    </datalist>
                    <OhmsInfo r={r} props={selectedPart.props} />
                  </label>
                );
              }
              return (
                <label key={k} className="prop">
                  {PROP_LABEL[k] ?? k}
                  {options ? (
                    <select value={String(v)} onChange={(e) => set(e.target.value)} aria-label={k}>
                      {[...new Set([...options, String(v)])].map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  ) : (
                    <input value={String(v)} onChange={(e) => set(e.target.value)} aria-label={k} />
                  )}
                </label>
              );
            })}
            {selectedPart.kind === "sd-card" && <SdImageButtons part={selectedPart.id} runner={runner} onWipe={sdCards.wipe} />}
            <button onClick={deleteSelected}>삭제</button>
          </>
        ) : selectedWire ? (
          <>
            <p>
              <b>와이어</b> {selectedWire.a.part}.{selectedWire.a.pin} — {selectedWire.b.part}.{selectedWire.b.pin}
            </p>
            <div className="swatches">
              {WIRE_COLORS.map((c) => (
                <button
                  key={c}
                  className={c === selectedWire.color ? "swatch on" : "swatch"}
                  style={{ background: c }}
                  aria-label={`와이어 색 ${c}`}
                  onClick={() =>
                    setProject((p) => ({ ...p, wires: p.wires.map((w) => (w.id === selectedWire.id ? { ...w, color: c } : w)) }))
                  }
                />
              ))}
            </div>
            <p className="hint">양 끝의 네모를 끌어 다른 핀에 놓으면 끝점이 옮겨집니다. 꺾는 점은 끌어서 옮기고, 더블클릭하면 지웁니다.</p>
            {(selectedWire.points?.length ?? 0) > 0 && (
              <button
                onClick={() =>
                  setProject((p) => ({ ...p, wires: p.wires.map((w) => (w.id === selectedWire.id ? { ...w, points: [] } : w)) }))
                }
              >
                꺾는 점 모두 지우기
              </button>
            )}{" "}
            <button onClick={deleteSelected}>삭제</button>
          </>
        ) : (
          <p className="hint">
            부품이나 와이어를 선택하세요.
            <br />
            배선: 핀을 클릭한 뒤 다른 핀을 클릭하거나, 핀에서 끌어다 놓기. 가는 길에 빈 곳을 클릭하면 꺾는 점.
            <br />
            회로도에서도 배선: 핀 끝에서 다른 핀 끝으로 끌어 놓기. 핀 끝을 클릭해 고르면 연결 끊기.
            <br />
            Delete 삭제 · 휠/＋−로 확대·축소 · 빈 곳 끌기로 이동
          </p>
        )}
        <h3>넷리스트 ({visibleNets.length})</h3>
        <ul className="nets">
          {visibleNets.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

/** Download or replace the contents of a simulated SD card. */
function SdImageButtons({
  part,
  runner,
  onWipe,
}: {
  part: string;
  runner: ReturnType<typeof useRunner>;
  onWipe: (part: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="prop">
      카드 내용 (디스크 이미지)
      <div>
        <button
          onClick={async () => {
            const img = await runner.sdImage(part);
            if (!img.length) return setMsg("카드가 아직 회로에 없습니다.");
            const url = URL.createObjectURL(new Blob([img], { type: "application/octet-stream" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = `${part}.img`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            setMsg(`${(img.length / 1048576).toFixed(0)} MB 이미지를 내려받았습니다.`);
          }}
        >
          이미지 내려받기
        </button>{" "}
        <button onClick={() => input.current?.click()}>이미지 넣기</button>{" "}
        <button
          onClick={() => {
            if (!window.confirm("카드의 내용을 모두 지울까요? 파일 시스템도 지워져 빈 카드가 됩니다.")) return;
            onWipe(part);
            setMsg("카드를 비웠습니다.");
          }}
        >
          카드 비우기
        </button>
        <input
          ref={input}
          type="file"
          accept=".img,.bin,application/octet-stream"
          hidden
          data-testid="sd-image-input"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            runner.sdLoad(part, await f.arrayBuffer());
            setMsg(`${f.name}을(를) 카드에 넣었습니다.`);
          }}
        />
      </div>
      <span className="hint">카드 내용은 이 브라우저에 프로젝트별로 저장되어, 다시 열면 그대로 들어 있습니다.</span>
      {msg && <span className="hint">{msg}</span>}
    </div>
  );
}
