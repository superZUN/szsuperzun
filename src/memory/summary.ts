// 하루 요약: once a day is over, the AI summarises that day's conversation logs (all devices) into "sum-YYYY-MM-DD",
// and passes term candidates to the learning box. Days without a log are skipped; only the last 7 days are caught up.
// The 회의록 tab also has "오늘 요약 만들기" for the day so far.
import { $ } from "../util";
import { S, type Doc } from "../state";
import { cfg } from "../settings/settings";
import { ai, aiCall, errText } from "../ai/client";
import { daySummaryPrompt, TERMS_MARK } from "../ai/prompts";
import { saveLocal } from "../storage/idb";
import { indexDoc, pushDoc } from "../library/docs";
import { renderDocs } from "../library/ui";
import { addNode } from "../hud/cards";
import { completeObjects } from "../util";
import { dayKey, flushLog } from "./daylog";
import { addAITerms } from "./learn";

let busy = false;
const logsOf = (day: string) => S.docs.filter((d) => d.id.startsWith(`day-${day}-`));
/** the day's lines from every device, in time order (headers dropped) */
export function dayText(day: string) {
  return logsOf(day).flatMap((d) => d.text.split("\n").filter((l) => l.startsWith("["))).sort().join("\n");
}
export async function summariseDay(day: string, manual = false): Promise<Doc | null> {
  if (busy || !ai.apiKey) return null; const log = dayText(day); if (log.length < 40) { if (manual) $("sumMsg").textContent = "이날 기록된 대화가 거의 없습니다."; return null; }
  busy = true; if (manual) $("sumMsg").textContent = `${day} 대화를 요약하는 중…`;
  try {
    const t = await aiCall(daySummaryPrompt(day, log.length > 300000 ? log.slice(-300000) : log), { maxTokens: 2500, kind: "daysum" });
    const cut = t.indexOf(TERMS_MARK); const body = (cut >= 0 ? t.slice(0, cut) : t).trim();
    const terms = cut >= 0 ? (completeObjects(t.slice(cut)).find((o) => Array.isArray(o.terms)) || { terms: [] }).terms : [];
    const id = `sum-${day}`; let d = S.docs.find((x) => x.id === id);
    if (!d) { d = { id, name: `${day} 하루 요약`, text: "", added: new Date(day + "T23:59:00").getTime() || Date.now() }; S.docs.push(d); }
    d.text = body; d.dirty = true; saveLocal(d); indexDoc(d); renderDocs(); void pushDoc(d);
    addAITerms(terms, day);
    if (manual) $("sumMsg").textContent = `${day} 하루 요약을 저장했습니다.`;
    busy = false; return d;
  } catch (e) { if (manual) $("sumMsg").textContent = errText(e); busy = false; return null; }
}
/** summarise finished days that have a log but no summary yet (newest first, at most 7 days back) */
export async function catchUp() {
  if (!cfg.daySumOn || !ai.apiKey) return; const today = dayKey();
  const days = [...new Set(S.docs.filter((d) => d.id.startsWith("day-")).map((d) => d.id.slice(4, 14)))].filter((d) => d < today && d >= dayKey(Date.now() - 7 * 864e5)).sort().reverse();
  for (const day of days) {
    if (S.docs.some((x) => x.id === `sum-${day}`)) continue;
    const d = await summariseDay(day); if (!d) continue;
    const first = (d.text.split("## 한 줄 요약")[1] || "").split("\n").map((l) => l.replace(/^[-\s]+/, "").trim()).find(Boolean) || "";
    addNode({ type: "info", title: `${day} 하루 요약`, body: first || "하루 대화를 요약해 회의록 탭에 저장했습니다.", source: "하루 요약" });
  }
}
export function initSummary() {
  $("sumToday").addEventListener("click", () => { flushLog(true); void summariseDay(dayKey(), true); });
  let lastDay = dayKey();
  setInterval(() => { const d = dayKey(); if (d !== lastDay) { lastDay = d; flushLog(true); void catchUp(); } }, 60000); // midnight while running all day
}
