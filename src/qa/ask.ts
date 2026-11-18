// Questions: a picture the user asked for starts first, then matching past-minutes passages (instantly), then the
// streamed answer. The first line of the answer ([보기] …) names a picture; the app acts on it and never shows it.
// Material first; if it is not there, a web search (Claude / Gemini) without saying "not in the material".
// Questions about the present (최신, 가격, 출시…) must be searched; an answer written without searching is asked again.
import { $, hhmm } from "../util";
import { S, joined, segText, dailyTalk } from "../state";
import { cfg } from "../settings/settings";
import { ai, aiCall, searchCall, errText, keepWarm } from "../ai/client";
import { askPrompt, ASK_RETRY_SEARCH, timeSensitive, needsThinking } from "../ai/prompts";
import { addNode } from "../hud/cards";
import { index, retrieveScored, contextBlock } from "../library/docs";
import { meetingBlock } from "../meeting/prep";
import { reconcileManual, userFocusBlock } from "../transcript";
import { bestSentence } from "../analysis/keywords";
import { routeVisual, showVisual, visSubject } from "./visual";
import { isRepeat, deepAsk, PAST_Q, DEEP_MARK } from "./deep";
import { logLine } from "../memory/daylog";
import { askAll, WORK_Q } from "../work/work";

const Q_STOP = new Set(["아까", "방금", "그거", "이거", "저거", "뭐라", "라고", "했지", "했었", "었지", "는데", "그럼", "얼마", "언제", "어떻", "떻게", "뭐였", "였지", "무슨", "누가", "어디"]);
/** question tokens: Korean bigrams (minus question filler) + Latin words of 2+ letters, so short codes like IR / NG count */
export function qTokens(s: string) {
  s = s.toLowerCase(); const out = new Set<string>();
  for (const m of s.matchAll(/[가-힣]+/g)) { const w = m[0]; for (let i = 0; i < w.length - 1; i++) { const b = w.slice(i, i + 2); if (!Q_STOP.has(b)) out.add(b); } }
  for (const m of s.matchAll(/[a-z0-9][a-z0-9.\-/]+/g)) out.add(m[0]); return out;
}
/** earlier parts of THIS conversation that match the question (up to 4 places ± 1 sentence; the recent tail is sent anyway) */
export function relevantTranscript(q: string, tailFrom: number) {
  const qt = qTokens(q); if (!qt.size) return ""; const scored: [number, number][] = [];
  S.segs.forEach((s, i) => { if (i >= tailFrom) return; const st = qTokens(segText(s)); let sc = 0; qt.forEach((t) => { if (st.has(t)) sc += /^[a-z0-9]/.test(t) ? 3 : 1; }); if (sc >= 2) scored.push([sc, i]); });
  scored.sort((a, b) => b[0] - a[0]); const pick = new Set<number>(); scored.slice(0, 4).forEach(([, i]) => { for (let k = i - 1; k <= i + 1; k++) if (k >= 0 && k < tailFrom) pick.add(k); });
  return [...pick].sort((a, b) => a - b).map((i) => `[${S.segs[i].at ? hhmm(S.segs[i].at) : "--"}] ${segText(S.segs[i])}`).join("\n").slice(0, 2500);
}
/** index of the first utterance in the last `chars` characters */
export function tailStart(chars: number) { let n = 0; for (let i = S.segs.length - 1; i >= 0; i--) { n += segText(S.segs[i]).length + 1; if (n > chars) return i + 1; } return 0; }
/** how every answer opens (set in 설정); added by the app, so it is always there exactly once */
export function withLead(t: string) {
  t = String(t || ""); const lead = cfg.answerLead; if (!lead || !t.trim()) return t; const core = lead.replace(/[\s.,!~]+$/, "");
  let x = t.replace(/^\s+/, ""); if (x.startsWith(core)) return x; if (/^네/.test(core)) x = x.replace(/^네[,.!]\s*/, ""); // no "네, 장군님. 네, …"
  return lead + " " + x;
}
const VIS_TAG: Record<string, string> = { 사진: "photo", 다이어그램: "diagram", 도면: "drawing", 차트: "chart" };

export async function ask(qIn?: string) {
  const q = (qIn || $("askInput").value).trim(); if (!q) return;
  if (!qIn) { $("askInput").value = ""; $("askInput").focus(); }
  S.lastUserAct = Date.now();
  reconcileManual(); const full = joined(), t0 = tailStart(1500), tail = S.segs.slice(t0).map((s) => `${s.at ? "[" + hhmm(s.at) + "] " : ""}${segText(s)}`).join("\n");
  // 1) a picture the user explicitly asked for starts first — before any lookup or AI call
  const route = routeVisual(q); let launched = route ? showVisual(route, visSubject(q), tail, { title: visSubject(q) }) : false;
  const canSearch = cfg.webMode !== "off" && (ai.provider === "anthropic" || ai.provider === "gemini");
  // asked again, or a question about what was said that the quick look cannot find: straight to the wide search
  if (ai.apiKey && !(route && !PAST_Q.test(q))) {
    const repeat = isRepeat(q), quick = index.chunks.length ? retrieveScored(q, 3) : [], early = relevantTranscript(q, t0);
    const weak = PAST_Q.test(q) && !early && !(quick[0] && (quick[0].n >= 3 || quick[0].s >= 3)) && (index.chunks.length > 0 || t0 > 0);
    if (repeat || weak) { const node = addNode({ type: "answer", title: q, body: "…" }); void deepAsk(q, node, { reason: repeat ? "같은 질문을 다시 하셔서" : "빠른 검색에서 관련 대목을 못 찾아서", tail, canSearch }); return; }
  }
  // a question about the 할 일 list or a past period (when not about what was just said): every record, by date
  if (ai.apiKey && !route && WORK_Q.test(q) && !/아까|방금|지금\s*(얘기|말|회의)/.test(q)) { const node = addNode({ type: "answer", title: q, body: "…" }); await askAll(q, { set: (t) => node.setBody(withLead(t)) }); return; }
  // 2) matching passages from saved minutes, instantly
  if (index.chunks.length) {
    const seen = new Set<string>(), cv = dailyTalk();
    retrieveScored(q, 3).filter((x) => (cv ? x.n >= 4 && x.s >= 6 : x.n >= 2 && x.s >= 2)).forEach((x) => { if (seen.has(x.c.doc)) return; seen.add(x.c.doc); const sent = bestSentence(x.c.text, q); if (sent) addNode({ type: "past", title: x.c.doc, body: sent, source: "질문 관련 회의록" }); });
  }
  // 3) the answer, streamed
  const node = addNode({ type: "answer", title: q, body: "…" });
  if (!ai.apiKey) { node.setBody(errText({ code: "no_key" })); return; }
  const earlier = relevantTranscript(q, t0), think = needsThinking(q), conv = S.appMode === "conv";
  const prev = S.qaLog.slice(-3).map((x) => `Q: ${x.q}\nA: ${x.a.slice(0, 400)}`).join("\n");
  const { system, prompt } = askPrompt({
    q, conv, convWork: S.convWork, launched, canSearch, tail, full, focusBlock: userFocusBlock(), meetingBlock: conv ? "" : meetingBlock(),
    notes: S.notes.slice(-8).map((n) => `- ${hhmm(n.at)} ${n.text}`).join("\n"), prev, pastBlock: contextBlock(q + " " + full.slice(-300), 4), earlier,
  });
  let tagDone = false;
  const body = (t: string) => { let x = t; const m = x.match(/^\s*\[보기\][^\n]*(\n|$)/); if (m) x = x.slice(m[0].length); return x.replace(DEEP_MARK, "").replace(/^\s+/, "").trimEnd(); };
  const onText = (t: string) => {
    if (!tagDone) {
      const s = t.replace(/^\s+/, "");
      if (s.startsWith("[") || "[보기]".startsWith(s)) {
        const nl = s.indexOf("\n"); if (nl < 0 && s.length < 80) return;
        tagDone = true; const m = s.slice(0, nl < 0 ? s.length : nl).match(/\[보기\]\s*(사진|다이어그램|도면|차트)\s*[:：]\s*(.+)/);
        if (m && !launched) launched = showVisual(VIS_TAG[m[1]], m[2].trim().slice(0, 80), tail, { title: m[2].trim().slice(0, 40) });
      } else tagDone = true;
    }
    const b = body(t); if (b) node.setBody(withLead(b));
  };
  try {
    let t: string;
    if (canSearch) {
      try {
        let res = await searchCall(prompt, { system, maxTokens: 900, onText, think, kind: "ask" });
        if (!res.searched && timeSensitive(q)) { // a question about the present answered from (stale) memory: ask again, insisting
          tagDone = true; node.setBody("최신 정보를 웹에서 확인하는 중…");
          res = await searchCall(prompt + ASK_RETRY_SEARCH, { system, maxTokens: 900, onText, think, kind: "ask" });
        }
        t = res.text; if (res.links.length) node.setLinks(res.links);
        if (!res.searched && timeSensitive(q)) t = (t || "") + "\n(웹 검색을 하지 못해 최신 정보와 다를 수 있습니다)";
      } catch (e: any) { // web search refused (e.g. disabled for the organisation): answer from the material only
        if (e && (e.code === "http" || e.code === "bad_model") && /search|tool/i.test(e.message || "")) t = await aiCall(prompt, { system, maxTokens: think ? 2500 : 600, onText, think, effort: think ? "medium" : "low", kind: "ask" }); else throw e;
      }
    } else t = await aiCall(prompt, { system, maxTokens: think ? 2500 : 600, onText, think, effort: think ? "medium" : "low", kind: "ask" });
    if (t) { onText(t + "\n"); node.setBody(withLead(body(t) || "그림으로 보여 드립니다.")); }
    // the quick answer says the material was not enough: widen the search on the same card
    if (t && DEEP_MARK.test(t)) { DEEP_MARK.lastIndex = 0; await deepAsk(q, node, { reason: "빠른 답에 필요한 내용이 없어서", tail, canSearch }); return; }
    DEEP_MARK.lastIndex = 0; S.qaLog.push({ q, a: body(t || ""), at: Date.now() }); logLine(q, "질문"); logLine(body(t || "").slice(0, 400), "답");
  } catch (e: any) { node.setBody((e && e.text && body(e.text)) || errText(e)); }
}
export function initAsk() {
  $("askChips").addEventListener("click", (e: Event) => { const b = (e.target as HTMLElement).closest("button[data-q]") as HTMLElement | null; if (b) void ask(b.dataset.q); });
  $("askBtn").addEventListener("click", () => ask());
  $("askInput").addEventListener("focus", () => { S.lastUserAct = Date.now(); keepWarm(); });
  $("askInput").addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); void ask(); } });
}
