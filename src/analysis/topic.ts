// Conversation mode: is this everyday talk (일상) or has it turned to work (업무)?
// Decided locally on every sentence (instant), corrected by the AI's own reading ("topic" in the analysis), with hysteresis
// so it does not flicker; tapping the chip fixes it by hand for 5 minutes.
import { $ } from "../util";
import { S } from "../state";
import { ls } from "../storage/ls";
import { dictHits } from "../library/dict";
import { index, retrieveScored } from "../library/docs";
import { ai } from "../ai/client";
import { analyze } from "./analyze";
import { updateEndBar } from "../minutes/minutes";

const WORK_RE = /회의|미팅|보고서?|결재|납기|일정|마감|고객사?|거래처|견적|발주|계약|매출|단가|원가|예산|생산|라인|공정|설비|품질|불량|수율|샘플|출하|검사|양산|사양|스펙|이슈|대책|원인\s*분석|팀장|부장|과장|차장|대리|담당자?|프로젝트|기한|데드라인|진행\s*상황|결정|합의|승인|검토|메일|자료|데이터|셀|배터리|전지|모듈|양극|음극|전해액|분리막|파일럿|고객\s*클레임|클레임|본사|공장|출장/g;
const UNIT_RE = /\d+(\.\d+)?\s*(%|퍼센트|프로|ah|mah|kwh|mm|㎜|v|볼트|개|대|일|주|건|억|만\s*원|ppm|시간|분|호기)/gi;
/** dictionary hits ×2 (max 6) + work words (max 4) + number+unit ×0.5 (max 2) + strong match with past minutes +2 */
export function workScore(text: string) {
  const t = text.toLowerCase();
  let sc = Math.min(6, dictHits(t).length * 2) + Math.min(4, (text.match(WORK_RE) || []).length) + Math.min(2, (text.match(UNIT_RE) || []).length * 0.5);
  if (index.chunks.length) { const r = retrieveScored(text, 1, { skipToday: true })[0]; if (r && r.s >= 6 && r.n >= 4) sc += 2; }
  return sc;
}
const T = { log: [] as { at: number; s: number }[], ai: "", aiAt: 0, lastWorkAt: 0, manualUntil: 0 };
/** score summed with a 45 s half-life over the last 2 minutes */
function topicSum(now: number) { T.log = T.log.filter((x) => now - x.at < 120000); return T.log.reduce((a, x) => a + x.s * Math.pow(0.5, (now - x.at) / 45000), 0); }
export function updateTopic(text: string) {
  if (S.appMode !== "conv" || !text) return; const now = Date.now(), sc = workScore(text); T.log.push({ at: now, s: sc }); if (sc >= 2) T.lastWorkAt = now;
  if (now < T.manualUntil) return; const sum = topicSum(now), aiWork = T.ai === "work" && now - T.aiAt < 60000;
  if (!S.convWork && (sum >= 5 || sc >= 5 || (aiWork && sum >= 2))) setWork(true);
  else if (S.convWork && sum < 1.5 && now - T.lastWorkAt > 60000 && !aiWork) setWork(false); // back to daily only after a work-free minute
}
export function aiTopic(t: string) {
  if (S.appMode !== "conv" || (t !== "work" && t !== "daily")) return; const now = Date.now(); T.ai = t; T.aiAt = now; if (now < T.manualUntil) return;
  if (t === "work" && !S.convWork) setWork(true);
  else if (t === "daily" && S.convWork && now - T.lastWorkAt > 30000 && topicSum(now) < 3) setWork(false);
}
function setWork(on: boolean) {
  if (S.convWork === on) return; S.convWork = on; renderTopicChip();
  if (S.running && ai.apiKey && !S.busy) setTimeout(() => analyze(true), 50); // the switch itself is worth a fresh look at what was just said
}
export function resetTopic() { S.convWork = false; T.log = []; T.ai = ""; T.manualUntil = 0; }
export function renderTopicChip() {
  const c = $("topicChip"); c.hidden = S.appMode !== "conv"; c.textContent = S.convWork ? "업무" : "일상";
  c.setAttribute("aria-label", S.convWork ? "지금은 업무 이야기로 판단 중" : "지금은 일상 대화로 판단 중"); c.classList.toggle("work", S.convWork); c.classList.toggle("manual", Date.now() < T.manualUntil);
}
/** meeting / conversation mode */
export function setAppMode(m: string) {
  if (m !== S.appMode) resetTopic();
  S.appMode = m === "conv" ? "conv" : "meet"; ls.set("ms.appMode", S.appMode === "conv" ? "conv" : "");
  document.body.classList.toggle("conv", S.appMode === "conv");
  $("modeMeet").setAttribute("aria-selected", String(S.appMode === "meet")); $("modeConv").setAttribute("aria-selected", String(S.appMode === "conv"));
  renderTopicChip(); updateEndBar(); if (S.appMode === "conv") $("boundaryBar").hidden = true;
}
export function initTopic() {
  $("topicChip").addEventListener("click", () => { T.manualUntil = Date.now() + 5 * 60000; S.convWork = !S.convWork; renderTopicChip(); setTimeout(renderTopicChip, 5 * 60000 + 50); });
  $("modeMeet").addEventListener("click", () => setAppMode("meet")); $("modeConv").addEventListener("click", () => setAppMode("conv"));
  setAppMode(S.appMode);
}
