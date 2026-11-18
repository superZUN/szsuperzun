// 업무 tab: the morning briefing (tasks due + yesterday's key points, one AI call a day), "Jay에게 묻기" over every record
// (minutes, day summaries, conversation logs, the 할 일 list — a period in the question picks the material by date), and the
// weekly report (made on its own from Friday 3 p.m.; a missed week is made the next Monday), saved as a "wr-" doc.
import { $, download, fileSafe } from "../util";
import { S, joined, docKind, type Doc } from "../state";
import { ls } from "../storage/ls";
import { cfg } from "../settings/settings";
import { ai, aiCall, errText } from "../ai/client";
import { briefPrompt, weeklyReportPrompt, askAllPrompt } from "../ai/prompts";
import { saveLocal } from "../storage/idb";
import { indexDoc, pushDoc, retrieveScored } from "../library/docs";
import { renderDocs } from "../library/ui";
import { addNode } from "../hud/cards";
import { mdToHtml } from "../minutes/md";
import { liveTasks, parseDue, dueTag, type Task } from "../tasks/tasks";
import { collectMaterial, weekStart } from "../mindmap/mindmap";
import { dayKey, flushLog, logLine } from "../memory/daylog";
import { dayText } from "../memory/summary";

const DAY = 864e5;
const WD = ["일", "월", "화", "수", "목", "금", "토"];
const md = (t: number) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
const dayStart = (t: number) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
export const work = { briefBusy: false, reportBusy: false, askBusy: false, qa: [] as { q: string; a: string }[] };

/* ---------- the 할 일 list as text ---------- */
const byDue = (a: Task, b: Task) => (parseDue(a.due)?.getTime() ?? 9e15) - (parseDue(b.due)?.getTime() ?? 9e15) || a.at - b.at;
function taskLine(t: Task) {
  const tag = dueTag(t);
  return `- ${t.text}${t.owner ? " / 담당 " + t.owner : ""}${t.due ? " / 기한 " + t.due : ""}${tag ? ` (${tag.text})` : ""}${t.done ? " / 완료" + (t.result ? ": " + t.result : "") : ""}${t.from ? " / 출처 " + t.from : ""}`;
}
export function tasksBlock(withDone = true) {
  const L = liveTasks(); const open = L.filter((t) => !t.done).sort(byDue).slice(0, 50);
  const done = withDone ? L.filter((t) => t.done && Date.now() - t.doneAt < 14 * DAY).sort((a, b) => b.doneAt - a.doneAt).slice(0, 15) : [];
  return [open.length ? "진행 중:\n" + open.map(taskLine).join("\n") : "", done.length ? "최근 2주 끝낸 일:\n" + done.map(taskLine).join("\n") : ""].filter(Boolean).join("\n");
}

/* ---------- morning briefing ---------- */
interface Brief { at: number; text: string; day: string }
const briefKey = (day = dayKey()) => `ms.brief.${day}`;
/** the last day before today with a summary or a conversation log (up to 4 days back) */
function lastRecordedDay(now = Date.now()) {
  for (let i = 1; i <= 4; i++) {
    const day = dayKey(now - i * DAY), sum = S.docs.find((d) => d.id === `sum-${day}`);
    if (sum && sum.text.length > 80) return { day, text: sum.text.slice(0, 6000) };
    const log = dayText(day); if (log.length > 80) return { day, text: log.slice(-12000) };
  }
  return { day: "", text: "" };
}
/** due-date groups, drawn locally (no AI) every time the tab opens */
function renderBriefTasks() {
  const box = $("briefTasks"); box.textContent = ""; const open = liveTasks().filter((t) => !t.done).sort(byDue);
  const now = Date.now(), end = dayStart(now) + 2 * DAY;
  const groups: [string, Task[], string][] = [
    ["기한 지남", open.filter((t) => { const d = parseDue(t.due); return d && d.getTime() < now; }), "over"],
    ["오늘·내일", open.filter((t) => { const d = parseDue(t.due); return d && d.getTime() >= now && d.getTime() < end; }), "soon"],
    ["이번 주", open.filter((t) => { const d = parseDue(t.due); return d && d.getTime() >= end && d.getTime() < now + 7 * DAY; }), ""],
  ];
  const noDue = open.filter((t) => !parseDue(t.due)).length;
  groups.forEach(([label, list, cls]) => {
    if (!list.length) return; const g = document.createElement("div"); g.className = "bgroup";
    const h = document.createElement("div"); h.className = "bhead"; const tag = document.createElement("span"); tag.className = "tdue " + cls; tag.textContent = `${label} ${list.length}`; h.append(tag); g.append(h);
    list.slice(0, 8).forEach((t) => { const r = document.createElement("div"); r.className = "bitem"; r.textContent = `${t.text}${t.owner ? " · " + t.owner : ""}${t.due ? " · " + t.due : ""}`; g.append(r); });
    if (list.length > 8) { const r = document.createElement("div"); r.className = "hint"; r.textContent = `외 ${list.length - 8}개`; g.append(r); }
    box.append(g);
  });
  const p = document.createElement("div"); p.className = "hint";
  p.textContent = open.length ? `진행 중 ${open.length}개${noDue ? ` (기한 없음 ${noDue}개)` : ""} — 자세한 건 '할 일' 탭` : "진행 중인 할 일이 없습니다.";
  box.append(p);
}
export function renderBrief() {
  const now = new Date(); $("briefDate").textContent = `${now.getMonth() + 1}월 ${now.getDate()}일 ${WD[now.getDay()]}요일`;
  renderBriefTasks();
  const b = ls.json<Brief | null>(briefKey(), null), out = $("briefOut");
  if (!work.briefBusy) out.innerHTML = b && b.text ? mdToHtml(b.text) : `<div class="note">${ai.apiKey ? "'브리핑 만들기'를 누르면 어제 기록과 할 일로 오늘 챙길 것을 정리합니다. 매일 아침 처음 열 때 자동으로 만들어집니다." : "AI 키를 넣으면 어제 기록으로 오늘 챙길 것을 정리해 드립니다."}</div>`;
}
export async function makeBrief(manual = false): Promise<Brief | null> {
  if (work.briefBusy) return null;
  if (!ai.apiKey) { if (manual) $("briefMsg").textContent = errText({ code: "no_key" }); return null; }
  const today = dayKey(), last = lastRecordedDay(), tasks = tasksBlock(false);
  if (!tasks && !last.text) { const b: Brief = { at: Date.now(), text: "", day: today }; ls.set(briefKey(), JSON.stringify(b)); if (manual) $("briefMsg").textContent = "최근 기록과 할 일이 없어 브리핑할 내용이 없습니다."; return null; }
  work.briefBusy = true; $("briefMake").disabled = true; $("briefMsg").textContent = "브리핑을 만드는 중…"; const out = $("briefOut");
  const d = new Date(); const lastLabel = last.day ? `${md(new Date(last.day + "T12:00:00").getTime())}(${WD[new Date(last.day + "T12:00:00").getDay()]})` : "";
  try {
    const t = await aiCall(briefPrompt({ today: `${d.getMonth() + 1}/${d.getDate()}`, weekday: WD[d.getDay()], tasks, lastDay: lastLabel, lastText: last.text }), { maxTokens: 900, kind: "brief", onText: (x) => { out.innerHTML = mdToHtml(x); } });
    const b: Brief = { at: Date.now(), text: t.trim(), day: today }; ls.set(briefKey(), JSON.stringify(b));
    $("briefMsg").textContent = `${d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}에 만듦`;
    work.briefBusy = false; $("briefMake").disabled = false; renderBrief(); return b;
  } catch (e) { $("briefMsg").textContent = errText(e); work.briefBusy = false; $("briefMake").disabled = false; return null; }
}
/** at start-up and every 10 minutes: the day's briefing once, from 5 a.m. */
export async function autoBrief(now = Date.now()) {
  if (!cfg.briefOn || !ai.apiKey || S.standby || work.briefBusy) return;
  if (new Date(now).getHours() < 5 || ls.get(briefKey(dayKey(now)))) return;
  const b = await makeBrief(); if (!b || !b.text) return;
  const first = b.text.split("\n").map((l) => l.replace(/^[-*\s]+/, "").trim()).filter((l) => l && !l.startsWith("#") && l !== "없음").slice(0, 2).join(" · ");
  addNode({ type: "info", title: "오늘 브리핑", body: (first || "오늘 챙길 것을 정리했습니다.") + "\n눌러서 '업무' 탭에서 보기", source: "아침 브리핑", go: "tabWork" });
}

/* ---------- weekly report ---------- */
export const reportId = (ws: number) => `wr-${dayKey(ws)}`;
const reportLabel = (ws: number, end: number) => `${md(ws)}–${md(Math.min(end - 1, ws + 6 * DAY))}`;
export async function makeReport(ws: number, end: number, manual = false): Promise<Doc | null> {
  if (work.reportBusy) return null;
  if (!ai.apiKey) { if (manual) $("wrMsg").textContent = errText({ code: "no_key" }); return null; }
  const id = reportId(ws), label = reportLabel(ws, end);
  const mat = collectMaterial({ start: ws, end, scope: "work" });
  const L = liveTasks(), inWin = (t: number) => t >= ws && t < end;
  const done = L.filter((t) => t.done && inWin(t.doneAt)).map(taskLine).join("\n"), added = L.filter((t) => inWin(t.at)).map(taskLine).join("\n"), open = L.filter((t) => !t.done).sort(byDue).slice(0, 40).map(taskLine).join("\n");
  if (mat.text.length < 200 && !done && !added) { if (manual) $("wrMsg").textContent = `${label}에 보고서로 정리할 업무 기록이 거의 없습니다.`; else ls.set("ms.wr.empty", id); return null; }
  work.reportBusy = true; $("wrMake").disabled = true; $("wrMsg").textContent = `${label} 업무보고를 쓰는 중… (자료 ${mat.n}개)`; const out = $("wrOut");
  try {
    const t = await aiCall(weeklyReportPrompt({ label, material: mat.text.slice(0, 120000), done, added, open }), { maxTokens: 3500, tier: "deep", kind: "report", onText: (x) => { out.innerHTML = mdToHtml(x); } });
    let d = S.docs.find((x) => x.id === id);
    if (!d) { d = { id, name: `주간 업무보고 ${label}`, text: "", added: ws + 4 * DAY }; S.docs.push(d); }
    d.name = `주간 업무보고 ${label}`; d.text = t.trim(); d.dirty = true; saveLocal(d); indexDoc(d); renderDocs(); void pushDoc(d);
    $("wrMsg").textContent = `${label} 업무보고를 저장했습니다 (회의록 탭에도 있음).`;
    work.reportBusy = false; $("wrMake").disabled = false; renderReports(id); return d;
  } catch (e) { $("wrMsg").textContent = errText(e); work.reportBusy = false; $("wrMake").disabled = false; return null; }
}
let reportTriedAt = 0;
/** this week's report from Friday 3 p.m.; on Monday–Thursday, last week's if it was never made */
export async function autoReport(now = Date.now()) {
  if (!cfg.reportOn || !ai.apiKey || S.standby || work.reportBusy || now - reportTriedAt < 3600e3) return;
  const ws = weekStart(now), wd = (new Date(now).getDay() + 6) % 7, h = new Date(now).getHours();
  const thisWeek = wd > 4 || (wd === 4 && h >= 15);
  const start = thisWeek ? ws : ws - 7 * DAY, end = thisWeek ? now : ws, id = reportId(start);
  if (S.docs.some((d) => d.id === id) || ls.get("ms.wr.empty") === id) return;
  if (!thisWeek && h < 6) return; // Monday night: wait for the morning
  reportTriedAt = now; if (cfg.dayLogOn) flushLog(true);
  const d = await makeReport(start, end); if (!d) return;
  const first = (d.text.split("## 1.")[1] || "").split("\n").slice(1).map((l) => l.replace(/^[-*\s]+/, "").trim()).find(Boolean) || "";
  addNode({ type: "info", title: `주간 업무보고 · ${reportLabel(start, end)}`, body: (first || "이번 주 업무를 보고서로 정리했습니다.") + "\n눌러서 '업무' 탭에서 보기", source: "주간 업무보고", go: "tabWork" });
}
let shownReport = "";
export function renderReports(sel?: string) {
  const s = $("wrSel"); const reps = S.docs.filter((d) => docKind(d) === "report").sort((a, b) => b.id.localeCompare(a.id));
  if (sel) shownReport = sel; if (!reps.some((d) => d.id === shownReport)) shownReport = reps[0] ? reps[0].id : "";
  s.textContent = ""; if (!reps.length) { const o = document.createElement("option"); o.value = ""; o.textContent = "아직 없음"; s.append(o); }
  reps.forEach((d) => { const o = document.createElement("option"); o.value = d.id; o.textContent = d.name.replace("주간 업무보고 ", ""); s.append(o); });
  s.value = shownReport; const d = reps.find((x) => x.id === shownReport);
  $("wrCopy").disabled = $("wrSave").disabled = !d;
  if (!work.reportBusy) $("wrOut").innerHTML = d ? mdToHtml(d.text) : `<div class="note">금요일 오후 3시가 지나면 이번 주 회의록·하루 요약·할 일로 주간 업무보고를 자동으로 씁니다. 지금 쓰려면 '이번 주 보고서 쓰기'.</div>`;
}

/* ---------- Jay에게 묻기: every record ---------- */
/** a period named in the question → that window of records */
export function spanOf(q: string, now = Date.now()): { start: number; end: number; label: string } | null {
  const t0 = dayStart(now), ws = weekStart(now); let m: RegExpMatchArray | null;
  if (/그제|그저께/.test(q)) return { start: t0 - 2 * DAY, end: t0 - DAY, label: md(t0 - 2 * DAY) };
  if (/어제/.test(q)) return { start: t0 - DAY, end: t0, label: `어제(${md(t0 - DAY)})` };
  if (/오늘/.test(q) && !/할\s*일|해야/.test(q)) return { start: t0, end: Infinity, label: "오늘" };
  if (/지난\s*주|저번\s*주|전\s*주/.test(q)) return { start: ws - 7 * DAY, end: ws, label: `지난주(${md(ws - 7 * DAY)}–${md(ws - DAY)})` };
  if (/이번\s*주|금주/.test(q)) return { start: ws, end: Infinity, label: `이번 주(${md(ws)}~)` };
  if (/지난\s*달|저번\s*달/.test(q)) { const d = new Date(now); const s = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(), e = new Date(d.getFullYear(), d.getMonth(), 1).getTime(); return { start: s, end: e, label: "지난달" }; }
  if (/이번\s*달/.test(q)) { const d = new Date(now); return { start: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), end: Infinity, label: "이번 달" }; }
  if ((m = q.match(/최근\s*(\d{1,2})\s*일/))) return { start: t0 - (+m[1] - 1) * DAY, end: Infinity, label: `최근 ${m[1]}일` };
  if ((m = q.match(/(\d{1,2})\s*일\s*전/))) { const s = t0 - +m[1] * DAY; return { start: s, end: s + DAY, label: md(s) }; }
  if ((m = q.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/)) || (m = q.match(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/))) {
    const d = new Date(now); let s = new Date(d.getFullYear(), +m[1] - 1, +m[2]).getTime(); if (s > now + 30 * DAY) s = new Date(d.getFullYear() - 1, +m[1] - 1, +m[2]).getTime();
    return { start: s, end: s + DAY, label: md(s) };
  }
  return null;
}
/** questions the 업무 path answers better than the live-conversation path (tasks, a past period) */
export const WORK_Q = /할\s*일|해야\s*(할|하는|될)|마감|기한|투두|밀린|못\s*한|끝낸|완료한|어제|그제|지난\s*주|저번\s*주|이번\s*주|지난\s*달|이번\s*달|\d+\s*일\s*전|최근\s*\d+\s*일|\d{1,2}\s*월\s*\d{1,2}\s*일|주간|요약해|정리해/;
export async function askAll(q: string, sink: { set(t: string): void }) {
  q = q.trim(); if (!q) return;
  if (!ai.apiKey) { sink.set(errText({ code: "no_key" })); return; }
  work.askBusy = true; sink.set("기록을 찾는 중…");
  const span = spanOf(q); let material = "";
  if (span) material = collectMaterial({ start: span.start, end: span.end, scope: "all" }).text.slice(0, 60000);
  if (!span || material.length < 200) {
    const seen = new Set<string>();
    const hits = retrieveScored(q, 12).filter((x) => x.n >= 1).filter((x) => { const k = x.c.doc + x.c.text.slice(0, 40); if (seen.has(k)) return false; seen.add(k); return true; });
    const sums = S.docs.filter((d) => docKind(d) === "daysum").sort((a, b) => b.id.localeCompare(a.id)).slice(0, 3).map((d) => `<<${d.name}>>\n${d.text.slice(0, 1800)}`);
    material = [material, ...hits.map((h) => `<<${h.c.doc}>>\n${h.c.text}`), ...sums].filter(Boolean).join("\n---\n").slice(0, 40000);
  }
  const d = new Date(), now = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}(${WD[d.getDay()]}) ${d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`;
  const { system, prompt } = askAllPrompt({ q, now, tasks: tasksBlock(), material, span: span ? span.label : "", current: S.segs.length ? joined().slice(-3000) : "", prev: work.qa.slice(-2).map((x) => `Q: ${x.q}\nA: ${x.a.slice(0, 400)}`).join("\n") });
  try {
    const t = await aiCall(prompt, { system, maxTokens: 1200, kind: "askall", onText: (x) => sink.set(x) });
    sink.set(t.trim()); work.qa.push({ q, a: t.trim() }); logLine(q, "질문"); logLine(t.trim().slice(0, 400), "답");
  } catch (e: any) { sink.set((e && e.text) || errText(e)); }
  work.askBusy = false;
}
function askHere(qIn?: string) {
  const inp = $("workAsk"), q = (qIn || inp.value).trim(); if (!q || work.askBusy) return; if (!qIn) inp.value = "";
  const box = $("workAnswer"), item = document.createElement("div"); item.className = "waq";
  const qq = document.createElement("div"); qq.className = "wq"; qq.textContent = q;
  const a = document.createElement("div"); a.className = "minout wa"; item.append(qq, a); box.prepend(item);
  while (box.childElementCount > 6) box.lastElementChild!.remove();
  void askAll(q, { set: (t) => { a.innerHTML = mdToHtml(t); } });
}

export function renderWork() { renderBrief(); renderReports(); }
export function initWork() {
  $("briefMake").addEventListener("click", () => void makeBrief(true));
  $("wrMake").addEventListener("click", () => { const now = Date.now(); void makeReport(weekStart(now), now, true); });
  $("wrSel").addEventListener("change", () => renderReports($("wrSel").value));
  const cur = () => S.docs.find((d) => d.id === shownReport);
  $("wrCopy").addEventListener("click", async () => { const d = cur(); if (!d) return; try { await navigator.clipboard.writeText(d.text); $("wrMsg").textContent = "보고서를 복사했습니다. 메일이나 메신저에 붙여 넣으세요."; } catch { $("wrMsg").textContent = "복사하지 못했습니다."; } });
  $("wrSave").addEventListener("click", () => { const d = cur(); if (d) download(fileSafe(d.name) + ".md", d.text, "text/markdown"); });
  $("workAskBtn").addEventListener("click", () => askHere());
  $("workAsk").addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); askHere(); } });
  $("workChips").addEventListener("click", (e: Event) => { const b = (e.target as HTMLElement).closest("button[data-q]") as HTMLElement | null; if (b) askHere(b.dataset.q); });
  setInterval(() => { void autoBrief(); void autoReport(); }, 10 * 60000);
}
