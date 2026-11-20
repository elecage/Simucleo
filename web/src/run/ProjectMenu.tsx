// Project file actions: new, open, save (.simucleo.json), image export.
import { useRef, useState } from "react";
import { download, exportSvg, serialize, svgToPng, toBase64 } from "../editor/project";
import type { Project } from "../editor/model";
import type { Runner } from "../sim/useRunner";
import { t } from "../i18n";

interface Props {
  project: Project;
  name: string;
  runner: Runner;
  onNew(): void;
  onOpenText(text: string): void;
}

// Keep letters of any script (Korean names stay readable), digits, . and -.
const slug = (s: string) => s.trim().replace(/[^\p{L}\p{N}.-]+/gu, "_") || "simucleo";

/** Download the project as a `.simucleo.json` file. */
export function saveProjectFile(project: Project, name: string, runner: Pick<Runner, "firmware" | "firmwareExample" | "firmwareBytes">, withElf: boolean) {
  let fw;
  if (runner.firmware) {
    fw = { name: runner.firmware, example: runner.firmwareExample ?? undefined } as {
      name: string;
      example?: string;
      data?: string;
    };
    if (withElf && runner.firmwareBytes) fw.data = toBase64(runner.firmwareBytes);
  }
  download(`${slug(name)}.simucleo.json`, new Blob([serialize(project, name, fw)], { type: "application/json" }));
}

export function ProjectMenu({ project, name, runner, onNew, onOpenText }: Props) {
  const [withElf, setWithElf] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  const save = () => saveProjectFile(project, name, runner, withElf);

  // The view on screen: the schematic or the breadboard.
  const svg = () =>
    [...document.querySelectorAll<SVGSVGElement>("svg.schematic, svg.canvas")].find((e) => e.getClientRects().length > 0) ??
    null;
  const saveSvg = () => {
    const el = svg();
    if (el) download(`${slug(name)}.svg`, new Blob([exportSvg(el)], { type: "image/svg+xml" }));
  };
  const savePng = async () => {
    const el = svg();
    if (el) download(`${slug(name)}.png`, await svgToPng(exportSvg(el)));
  };

  return (
    <div className="project-menu">
      <button onClick={onNew} title={t("빈 보드와 브레드보드로 시작")}>{t("새로")}</button>
      <button onClick={() => fileRef.current?.click()} title={t(".simucleo.json 프로젝트 열기")}>{t("열기")}</button>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        data-testid="project-input"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) onOpenText(await f.text());
          e.target.value = "";
        }}
      />
      <button onClick={save} title={t("배선과 부품 속성(선택: ELF 포함)을 파일로 저장")}>{t("저장")}</button>
      <label className="check" title={t("저장할 때 불러온 ELF를 파일에 넣습니다")}>
        <input type="checkbox" checked={withElf} onChange={(e) => setWithElf(e.target.checked)} /> {t("ELF 포함")}
      </label>
      <button onClick={saveSvg} title={t("보고 있는 배선도나 회로도를 SVG 그림으로 저장")}>SVG</button>
      <button onClick={savePng} title={t("보고 있는 배선도나 회로도를 PNG 그림으로 저장 (2배 해상도)")}>PNG</button>
    </div>
  );
}
