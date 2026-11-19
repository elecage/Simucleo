// "선생님용 결과 모아보기" (M24): drop many students' results files and see
// them in one table, with pass rates, sorting, filters and a CSV of it all.
// Files are read in the browser; nothing is uploaded anywhere.
import { useMemo, useState, type DragEvent } from "react";
import { download } from "../editor/project";
import {
  fmtDuration,
  mergeResults,
  parseResults,
  passRates,
  ratePercent,
  tableCsv,
  tableRows,
  type LoadedResult,
  type Rate,
  type TableOptions,
} from "./teacher";

interface Props {
  files: LoadedResult[];
  onFiles(files: LoadedResult[]): void;
  onClose(): void;
}

const BADGE: Record<string, string> = { verified: "✅ 검증됨", tampered: "⚠ 변조됨", unverified: "검증 안 됨" };

function RateCell({ r }: { r: Rate | undefined }) {
  const p = ratePercent(r);
  return p === null ? <td className="dim">–</td> : <td className={p >= 80 ? "rate good" : p < 50 ? "rate low" : "rate"}>{`${p}% (${r!.passed}/${r!.n})`}</td>;
}

export function TeacherView({ files, onFiles, onClose }: Props) {
  const [filter, setFilter] = useState("");
  const [lesson, setLesson] = useState("");
  const [incompleteOnly, setIncompleteOnly] = useState(false);
  const [tamperedOnly, setTamperedOnly] = useState(false);
  const [sort, setSort] = useState<NonNullable<TableOptions["sort"]>>({ by: "student" });
  const [over, setOver] = useState(false);

  const merged = useMemo(() => mergeResults(files), [files]);
  const rates = useMemo(() => passRates(merged), [merged]);
  const opts: TableOptions = { filter, lesson: lesson || undefined, incompleteOnly, tamperedOnly, sort };
  const rows = tableRows(merged, opts);
  const cols = merged.lessons.filter((c) => !lesson || c.id === lesson);

  const add = async (list: File[]) => {
    const read: LoadedResult[] = [];
    for (const f of list) read.push(...(await parseResults(f.name, await f.text())));
    onFiles([...files, ...read]);
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void add([...e.dataTransfer.files]);
  };
  const sortBy = (by: string) => setSort((s) => (s.by === by ? { by, desc: !s.desc } : { by, desc: by !== "student" }));
  const arrow = (by: string) => (sort.by === by ? (sort.desc ? " ▼" : " ▲") : "");
  const th = (by: string, text: string, title?: string) => (
    <th className="sortable" onClick={() => sortBy(by)} title={title ?? "눌러서 정렬"} aria-sort={sort.by === by ? (sort.desc ? "descending" : "ascending") : undefined}>
      {text}
      {arrow(by)}
    </th>
  );
  const sources = [...new Set(files.map((f) => f.source))];
  const tampered = files.filter((f) => f.integrity === "tampered" && f.file);

  return (
    <div className="overlay" role="dialog" aria-label="선생님용 결과 모아보기">
      <div className="overlay-box teacher">
        <header>
          <b>👩‍🏫 선생님용 결과 모아보기</b>
          <span className="dim">파일은 이 브라우저 안에서만 읽습니다. 어디에도 올라가지 않습니다.</span>
          <button className="close" onClick={onClose} aria-label="결과 모아보기 닫기">
            ×
          </button>
        </header>
        <div
          className={over ? "drop-zone over" : "drop-zone"}
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={drop}
          data-testid="teacher-drop"
        >
          학생들이 낸 결과 파일(<code>lesson-results_*.json</code>, CSV도 됨)을 여기에 끌어다 놓거나{" "}
          <label className="file-btn">
            파일 고르기
            <input
              type="file"
              multiple
              accept=".json,.csv,application/json,text/csv"
              hidden
              data-testid="teacher-input"
              onChange={(e) => {
                void add([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </label>
          {files.length > 0 && (
            <>
              {" "}
              <button onClick={() => onFiles([])}>모두 지우기</button>
            </>
          )}
        </div>

        {sources.length > 0 && (
          <details className="teacher-files" open={merged.errors.length > 0 || tampered.length > 0}>
            <summary>
              파일 {sources.length}개 · 학생 {merged.students.length}명
              {merged.duplicates.length > 0 && ` · 중복 ${merged.duplicates.length}건 (최신 것만 사용)`}
              {tampered.length > 0 && ` · ⚠ 변조 의심 ${tampered.length}개`}
              {merged.errors.length > 0 && ` · 읽지 못한 파일 ${merged.errors.length}개`}
            </summary>
            <ul>
              {files.map((f, i) => (
                <li key={i} data-testid="teacher-file" data-integrity={f.integrity}>
                  <code>{f.source}</code> {f.file ? `${f.file.student || "(이름 없음)"} · ` : ""}
                  {f.error ? <span className="error">{f.error}</span> : <span className={`badge ${f.integrity}`}>{BADGE[f.integrity]}</span>}
                  {f.kind === "csv" && <span className="dim"> (CSV에는 해시가 없습니다)</span>}{" "}
                  <button className="small" onClick={() => onFiles(files.filter((_, j) => j !== i))} aria-label={`${f.source} 빼기`}>
                    빼기
                  </button>
                </li>
              ))}
            </ul>
            {merged.duplicates.length > 0 && (
              <ul className="dim" data-testid="teacher-duplicates">
                {merged.duplicates.map((d, i) => (
                  <li key={i}>
                    중복: {d.student} · {d.lessonId} — {d.kept} 사용, {d.dropped} 무시
                  </li>
                ))}
              </ul>
            )}
          </details>
        )}

        {merged.students.length > 0 && (
          <>
            <div className="teacher-tools">
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="학생 이름 검색" aria-label="학생 검색" />
              <select value={lesson} onChange={(e) => setLesson(e.target.value)} aria-label="실습 고르기">
                <option value="">모든 실습</option>
                {merged.lessons.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
              <label>
                <input type="checkbox" checked={incompleteOnly} onChange={(e) => setIncompleteOnly(e.target.checked)} /> 미완료만
              </label>
              <label>
                <input type="checkbox" checked={tamperedOnly} onChange={(e) => setTamperedOnly(e.target.checked)} /> 변조 의심만
              </label>
              <button
                onClick={() => download("lesson-results-table.csv", new Blob([tableCsv(merged, rows, lesson || undefined)], { type: "text/csv" }))}
                title="지금 보이는 표(검색·필터·정렬 적용)를 CSV로 저장"
              >
                표 CSV로 내보내기
              </button>
            </div>
            <div className="teacher-scroll">
              <table className="teacher-table" data-testid="teacher-table">
                <thead>
                  <tr>
                    <th rowSpan={2}>학생</th>
                    <th rowSpan={2}>검증</th>
                    {cols.map((c) => (
                      <th key={c.id} colSpan={2 + c.steps.length} className="lesson-head">
                        {c.title}
                      </th>
                    ))}
                  </tr>
                  <tr>
                    {cols.map((c) => [
                      th(`score:${c.id}`, "점수", "통과한 검사 비율"),
                      th(`time:${c.id}`, "걸린 시간", "시작부터 완료까지"),
                      ...c.steps.map((s) => (
                        <th key={`${c.id}:${s.index}`} className="sortable step-head" onClick={() => sortBy(`step:${c.id}:${s.index}`)} title={s.title}>
                          {s.index + 1}. {s.title}
                          {arrow(`step:${c.id}:${s.index}`)}
                        </th>
                      )),
                    ])}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.student} data-student={r.student} className={r.integrity === "tampered" ? "tampered" : undefined}>
                      <th scope="row">{r.student}</th>
                      <td data-testid="row-integrity" data-integrity={r.integrity} title={r.sources.join(", ")}>
                        <span className={`badge ${r.integrity}`}>{BADGE[r.integrity]}</span>
                      </td>
                      {cols.map((c) => {
                        const cell = r.cells[c.id];
                        if (!cell)
                          return [
                            <td key={`${c.id}:s`} className="dim">
                              –
                            </td>,
                            <td key={`${c.id}:t`} />,
                            ...c.steps.map((s) => <td key={`${c.id}:${s.index}`} />),
                          ];
                        return [
                          <td key={`${c.id}:s`} data-cell={`${c.id}:score`} className={cell.completed ? "pass" : undefined}>
                            {cell.completed ? "✅ " : ""}
                            {cell.score}% <span className="dim">({cell.passed}/{cell.total})</span>
                          </td>,
                          <td key={`${c.id}:t`} data-cell={`${c.id}:time`}>
                            {cell.completed ? fmtDuration(cell.timeMs) : <span className="dim">미완료</span>}
                          </td>,
                          ...c.steps.map((s) => {
                            const sc = cell.steps[s.index];
                            return (
                              <td
                                key={`${c.id}:${s.index}`}
                                data-cell={`${c.id}:${s.index}`}
                                data-status={sc?.status}
                                className={sc?.status}
                                title={sc ? `${sc.passed}/${sc.total} 통과` : undefined}
                              >
                                {!sc ? "" : sc.status === "pass" ? "✅" : sc.status === "partial" ? `◐ ${sc.passed}/${sc.total}` : "❌"}
                                {sc?.timeMs !== undefined && <span className="dim"> {fmtDuration(sc.timeMs)}</span>}
                              </td>
                            );
                          }),
                        ];
                      })}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr data-testid="pass-rates">
                    <th scope="row">통과율</th>
                    <td className="dim">제출한 학생 중</td>
                    {cols.map((c) => [
                      <RateCell key={`${c.id}:c`} r={rates[c.id]?.completed} />,
                      <td key={`${c.id}:t`} className="dim">
                        완료
                      </td>,
                      ...c.steps.map((s) => (
                        <td key={`${c.id}:${s.index}`} data-rate={`${c.id}:${s.index}`} className={undefined}>
                          {ratePercent(rates[c.id]?.steps[s.index]) === null ? "–" : `${ratePercent(rates[c.id]?.steps[s.index])}%`}
                        </td>
                      )),
                    ])}
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="hint">
              ⚠ 변조됨: 파일 안의 해시(SHA-256)가 내용과 맞지 않습니다. 결과를 손으로 고쳤을 수 있습니다. 검증 안 됨: 해시가 없는 파일(이전
              버전에서 내보냈거나 CSV). 해시는 메모장으로 고치는 정도만 잡아내며, 마음먹고 고치면 막을 수 없습니다.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
