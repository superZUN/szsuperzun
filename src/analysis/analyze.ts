// Live analysis: when speech pauses (or enough new text piled up while talking), one streaming call returns a JSON array;
// cards appear as each object completes. First item = keywords (+ topic in conversation mode), then at most 2 cards.
// Pacing depends on the cost setting (균형 3 s·30자 / 빠르게 1 s·15자 / 절약 6 s·60자; twice as rare in everyday talk).
import { $, completeObjects } from "../util";
import { S, joined, segText, dailyTalk } from "../state";
import { ai, aiCall, errText, refreshNote } from "../ai/client";
import { analyzePrompt, OFFTOPIC } from "../ai/prompts";
import { paceParams } from "../ai/usage";
import { cfg } from "../settings/settings";
import { addNode } from "../hud/cards";
import { retrieveScored } from "../library/docs";
import { meetingBlock } from "../meeting/prep";
import { actionLine, sameAction } from "../meeting/actions";
import { reconcileManual, userFocusBlock } from "../transcript";
import { addKeyword } from "./keywords";
import { aiTopic } from "./topic";
import { routeVisual, showVisual } from "../qa/visual";
import { setStatus } from "../controls";

export const visAuto = () => cfg.visOn && Date.now() - S.visLast > 60000;
/** current pacing; everyday talk waits twice as long between calls */
export function pace() { const p = { ...paceParams() }; if (dailyTalk()) { p.gap *= 2; p.minChars = Math.round(p.minChars * 1.5); } return p; }

export async function analyze(force: boolean) {
  if (!ai.apiKey) { if (force) refreshNote(); return; }
  if (S.standby) return;
  if (S.busy) { S.pending = true; return; }
  reconcileManual(); const full = joined();
  // new = finals not yet analysed + what is being said right now (interim), so cards start before the sentence ends
  const finalsNew = S.segs.slice(Math.min(S.sentUpTo, S.segs.length)).map(segText).join(" ").trim();
  const fresh = (finalsNew + " " + (S.curInterim || "")).trim();
  if (!force && fresh.length < pace().minChars) return; if (!(full + fresh).trim()) return;
  S.busy = true; S.pending = false; setStatus(); S.lastCallAt = Date.now(); const sentCount = S.segs.length;
  const recent = (full + " " + (S.curInterim || "")).trim().slice(-900), conv = S.appMode === "conv", daily = conv && !S.convWork, work = conv && S.convWork;
  const past = retrieveScored((fresh || recent).slice(-500), 2, { skipToday: true }).filter((x) => (daily ? x.s >= 6 && x.n >= 4 : x.s > 2)).map((x) => "<<" + x.c.doc + ">>\n" + x.c.text.slice(0, 450)).join("\n---\n");
  const { system, prompt } = analyzePrompt({ conv, daily, work, meetingType: $("mode").value, visAuto: visAuto(), fresh, recent, past, shown: S.shownTitles, meetingBlock: conv ? "" : meetingBlock(), focusBlock: userFocusBlock() });
  let added = 0;
  const emit = (t: string) => {
    const objs = completeObjects(t);
    while (added < objs.length && added < 4) {
      const c = objs[added++]; if (!c || (!c.body && !c.title)) continue;
      if (c.type === "kw") { if (conv && c.topic) aiTopic(String(c.topic).trim()); String(c.title || "").split(/[,，、]/).map((s) => s.trim()).filter((s) => s.length >= 2 && s.length <= 30).slice(0, 3).forEach((k) => addKeyword(k, "ai", fresh)); continue; }
      if (c.type === "ask") c.type = "info"; // no question suggestions
      if (c.title && S.shownTitles.slice(-20).includes(c.title)) continue;
      if (OFFTOPIC.test((c.title || "") + " " + (c.body || ""))) continue; // never judge the conversation
      if (daily && (c.type === "risk" || c.type === "action")) continue;
      if (c.type === "visual") {
        if (!visAuto() || !c.title) continue; S.visLast = Date.now(); const k = routeVisual(c.title + " " + (c.body || "")) || "diagram";
        showVisual(k === "photo" ? "photo" : k, k === "photo" ? c.title : c.title + (c.body ? " — " + c.body : ""), recent, { title: c.title }); S.shownTitles.push(c.title); continue;
      }
      if (c.type === "action") { // changed: only a card; it goes to 할 일 when the user taps "할 일에 추가"
        if (daily) continue; const text = String(c.title || c.body || "").trim(); if (!text) continue;
        if (S.actions.some((a) => sameAction(a.text, text)) || S.history.some((d) => d.act && sameAction(d.act.text, text))) continue;
        const act = { text, owner: String(c.owner || "").trim(), due: String(c.due || "").trim() };
        addNode({ type: "action", title: text, body: actionLine(act) + "\n눌러서 '할 일에 추가'", act });
      }
      else { if (!c.body) continue; addNode(c); }
      S.shownTitles.push(c.title || c.body.slice(0, 20));
    }
  };
  try { const t = await aiCall(prompt, { system, maxTokens: 420, onText: emit, kind: "analyze" }); S.sentUpTo = Math.min(sentCount, S.segs.length); emit(t); $("aiNote").textContent = ""; }
  catch (e: any) { if (e && e.text) emit(e.text); if (e && e.code === "rate_limited") S.lastCallAt = Date.now() + 20000; $("aiNote").className = "hint warn"; $("aiNote").textContent = errText(e); }
  S.busy = false; setStatus();
  if (S.running && S.pending && Date.now() >= S.lastCallAt) { S.pending = false; setTimeout(() => analyze(false), 300); }
}

/* ---- scheduling ---- */
let debounce: any = null;
/** after a final sentence (or a long enough interim) and a short pause, analyse if the minimum gap has passed */
export function scheduleAnalyze(interim?: boolean) {
  if (!S.running) return; const p = pace();
  if (interim && S.curInterim.length < p.minChars) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => { if (Date.now() - S.lastCallAt > p.gap) void analyze(false); else S.pending = true; }, p.idle);
}
export function initAnalyzeTicker() {
  setInterval(() => {
    if (!S.running || S.busy || S.standby) return; const p = pace(), since = Date.now() - S.lastCallAt;
    if ((p.maxWait && since > p.maxWait) || (S.pending && since > p.gap)) void analyze(false);
  }, 500);
  $("analyzeBtn").addEventListener("click", () => analyze(true));
}
