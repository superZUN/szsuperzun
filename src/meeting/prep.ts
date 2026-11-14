// 준비 tab: title, planned length, agenda ("제목 10" = 10 min), attendees; the agenda bar with time alerts.
import { $, mmss } from "../util";
import { S } from "../state";
import { addNode } from "../hud/cards";
import { carry } from "./carry";

export interface AgendaItem { title: string; min: number }
export function agenda(): AgendaItem[] {
  const el = $("pAgenda"); if (!el) return [];
  return el.value.split("\n").map((l: string) => l.trim()).filter(Boolean).map((l: string) => {
    const m = l.match(/^(.*?)[\s·\-–—:,]*(\d{1,3})\s*(분|m|min)?$/i);
    return m && m[1].trim() ? { title: m[1].trim(), min: +m[2] } : { title: l, min: 0 };
  });
}
export function people(): string[] { const el = $("pPeople"); return el ? el.value.split("\n").map((l: string) => l.trim()).filter(Boolean) : []; }
export const plannedMin = () => Math.max(0, Math.round(+$("pDur").value || 0));
export function updatePrepCount() { $("prepCount").textContent = agenda().length || ""; }
export function agElapsed(i: number, now = Date.now()) {
  let t = 0; for (let k = 0; k < S.agLog.length; k++) { if (S.agLog[k].idx !== i) continue; t += (k + 1 < S.agLog.length ? S.agLog[k + 1].at : now) - S.agLog[k].at; } return t;
}
export function setAgenda(i: number) {
  const A = agenda(); if (!A.length) return; i = Math.max(0, Math.min(A.length - 1, i)); if (i === S.agIdx) return;
  S.agIdx = i; S.agLog.push({ idx: i, at: Date.now(), title: A[i].title }); if (!S.meetingStart) S.meetingStart = Date.now(); renderAgBar();
}
export function renderAgBar() {
  const A = agenda(), bar = $("agBar"), now = Date.now(); bar.classList.remove("warn", "over");
  if (!A.length) { $("agPos").textContent = "AGENDA"; $("agTitle").textContent = "안건 없음 · '준비' 탭에서 추가"; $("agTime").textContent = ""; }
  else if (S.agIdx < 0) { $("agPos").textContent = `AGENDA 0/${A.length}`; $("agTitle").textContent = "시작 전 · 첫 안건: " + A[0].title; $("agTime").textContent = A[0].min ? A[0].min + "분 배정" : ""; }
  else {
    const i = Math.min(S.agIdx, A.length - 1), it = A[i], el = agElapsed(S.agIdx, now), lim = it.min * 60000;
    $("agPos").textContent = `AGENDA ${i + 1}/${A.length}`; $("agTitle").textContent = it.title; $("agTime").textContent = mmss(el) + (lim ? " / " + mmss(lim) : "");
    if (lim && el > lim) bar.classList.add("over"); else if (lim && el > lim * 0.9) bar.classList.add("warn");
  }
  const P = plannedMin() * 60000, tot = S.meetingStart ? now - S.meetingStart : 0;
  $("totTime").textContent = "TOTAL " + mmss(tot) + (P ? " / " + mmss(P) : ""); $("totTime").classList.toggle("over", !!P && tot > P);
  $("agPrev").disabled = S.agIdx <= 0; $("agNext").disabled = A.length > 0 && S.agIdx >= A.length - 1;
}
/** time keeping (meeting mode only): one alert per overrunning item, one at 80 % and one at 100 % of the planned length */
function agendaTick() {
  renderAgBar(); if (!S.running || S.appMode === "conv") return;
  const A = agenda(), now = Date.now();
  if (S.agIdx >= 0 && A[S.agIdx] && A[S.agIdx].min) {
    const el = agElapsed(S.agIdx, now), lim = A[S.agIdx].min * 60000, key = S.agIdx + "|" + A[S.agIdx].title;
    if (el > lim && !S.agAlerted[key]) {
      S.agAlerted[key] = 1; const left = A.slice(S.agIdx + 1);
      addNode({ type: "risk", title: `안건 ${S.agIdx + 1} 시간 초과`, body: `'${A[S.agIdx].title}' 배정 ${A[S.agIdx].min}분을 넘겼습니다(${Math.floor(el / 60000)}분 경과).${left.length ? ` 남은 안건 ${left.length}개: ${left.map((x) => x.title).join(", ")}` : ""}` });
    }
  }
  const P = plannedMin() * 60000;
  if (P && S.meetingStart) {
    const tot = now - S.meetingStart, left = S.agIdx >= 0 ? A.slice(S.agIdx + 1) : A;
    if (tot > P * 0.8 && S.totAlert < 1) { S.totAlert = 1; addNode({ type: "risk", title: `남은 시간 약 ${Math.max(1, Math.round((P - tot) / 60000))}분`, body: left.length ? `아직 다루지 않은 안건 ${left.length}개: ${left.map((x) => x.title).join(", ")}` : "남은 안건이 없습니다. '마무리 점검'으로 놓친 것이 없는지 확인해 보세요." }); }
    if (tot > P && S.totAlert < 2) { S.totAlert = 2; addNode({ type: "risk", title: "예정 시간 종료", body: "'마무리 점검'으로 담당·기한 없는 할 일과 다루지 않은 안건을 확인해 보세요." }); }
  }
}
/** context the model gets about the meeting itself */
export function meetingBlock() {
  const A = agenda(), P = people(), open = carry.items.filter((x) => !x.done), out: string[] = [];
  if (A.length) out.push("[안건] " + A.map((x, i) => `${i + 1}. ${x.title}${i === S.agIdx ? " (지금 진행 중)" : ""}`).join(" / "));
  if (P.length) out.push("[참석자] " + P.join(", "));
  if (open.length) out.push("[지난 회의 미완료 할 일] " + open.map((x) => x.text + (x.owner || x.due ? ` (${[x.owner, x.due].filter(Boolean).join(", ")})` : "")).join(" / "));
  if (S.actions.length) out.push("[이번 회의에서 이미 잡은 할 일] " + S.actions.map((a) => a.text).join(" / "));
  return out.length ? "\n" + out.join("\n") + "\n" : "";
}
export function minutesFacts() {
  const A = agenda(), P = people(), out: string[] = [];
  if (P.length) out.push("[참석자]\n" + P.map((x) => "- " + x).join("\n"));
  if (A.length) out.push("[안건과 실제 소요 시간]\n" + A.map((x, i) => `${i + 1}. ${x.title}${x.min ? ` (배정 ${x.min}분` : " ("}${S.agLog.some((g) => g.idx === i) ? `, 실제 ${Math.round(agElapsed(i) / 60000)}분)` : ", 진행 안 됨)"}`).join("\n"));
  if (S.actions.length) out.push("[회의 중 정리한 할 일 — 사용자가 확인·수정한 목록. 할 일 표는 이것을 기준으로 하고, 대화에서 더 찾은 것만 추가]\n" + S.actions.map((a) => `- ${a.text} | 담당: ${a.owner || "미정"} | 기한: ${a.due || "미정"}`).join("\n"));
  if (carry.items.length) out.push(`[지난 회의 할 일 점검${carry.from ? " — " + carry.from : ""}]\n` + carry.items.map((x) => `- ${x.text} | ${x.owner || "미정"} | ${x.done ? "완료(사용자 확인)" : "미완료 — 이번 회의 대화에서 진행 상황을 찾아 적을 것"}`).join("\n"));
  return out.join("\n\n");
}
export const prepSig = () => ["pTitle", "pDur", "pAgenda", "pPeople"].map((id) => $(id).value).join("\u0001");

export function initPrep(showPrepTab: () => void) {
  $("agNext").addEventListener("click", () => { if (!agenda().length) { showPrepTab(); $("pAgenda").focus(); return; } setAgenda(S.agIdx < 0 ? 0 : S.agIdx + 1); });
  $("agPrev").addEventListener("click", () => setAgenda(S.agIdx - 1));
  ["pTitle", "pDur", "pAgenda", "pPeople"].forEach((id) => $(id).addEventListener("input", () => { renderAgBar(); updatePrepCount(); }));
  setInterval(agendaTick, 1000);
}
