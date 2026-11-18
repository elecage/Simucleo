// Project file actions: new, open, save (.simucleo.json), image export.
import { useRef, useState } from "react";
import { download, exportSvg, serialize, svgToPng, toBase64 } from "../editor/project";
import type { Project } from "../editor/model";
import type { Runner } from "../sim/useRunner";

interface Props {
  project: Project;
  name: string;
  runner: Runner;
  onNew(): void;
  onOpenText(text: string): void;
}

// Keep letters of any script (Korean names stay readable), digits, . and -.
const slug = (s: string) => s.trim().replace(/[^\p{L}\p{N}.-]+/gu, "_") || "simucleo";

export function ProjectMenu({ project, name, runner, onNew, onOpenText }: Props) {
  const [withElf, setWithElf] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  const save = () => {
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
  };

  const svg = () => document.querySelector<SVGSVGElement>("svg.canvas");
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
      <button onClick={onNew} title="빈 보드와 브레드보드로 시작">새로</button>
      <button onClick={() => fileRef.current?.click()} title=".simucleo.json 프로젝트 열기">열기</button>
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
      <button onClick={save} title="배선과 부품 속성(선택: ELF 포함)을 파일로 저장">저장</button>
      <label className="check" title="저장할 때 불러온 ELF를 파일에 넣습니다">
        <input type="checkbox" checked={withElf} onChange={(e) => setWithElf(e.target.checked)} /> ELF 포함
      </label>
      <button onClick={saveSvg} title="배선도를 SVG 그림으로 저장">SVG</button>
      <button onClick={savePng} title="배선도를 PNG 그림으로 저장 (2배 해상도)">PNG</button>
    </div>
  );
}
