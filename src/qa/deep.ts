// DEEP SCAN (넓게 찾기): when the quick look is not enough —
//  (a) the same question again within 20 min (short questions: exact match only), (b) a question about what was said
//  that the quick look cannot find, (c) the quick answer ends with ⟪더찾기⟫.
// 1) the AI widens the question (12–18 related wordings and terms), 2) all minutes/material (14 chunks) and the whole
// conversation are scanned, 3) the best passages show as RECALL cards, 4) one answer, in time order.
import { hhmm } from "../util";
import { S, joined, segText } from "../state";
import { aiCall, searchCall, errText } from "../ai/client";
import { deepExpandPrompt, deepAnswerPrompt } from "../ai/prompts";
import { addNode, type NodeHandle } from "../hud/cards";
import { index, retrieveScored, isFinal } from "../library/docs";
import { wake } from "../hud/field";
import { setStatus } from "../controls";
import { bestSentence } from "../analysis/keywords";
import { qTokens, withLead } from "./ask";
import { logLine } from "../memory/daylog";

export const PAST_Q = /아까|전에|지난|저번|예전|회의|미팅|했었|했지|했나|했더라|뭐였|뭐라고|말했|얘기했|이야기했|결정|합의|정했|언제였|누가.*(하기로|맡)|어떻게\s*하기로|정리|모아|전부|다\s*찾아/;
export const DEEP_MARK = /⟪\s*더\s*찾기\s*⟫/g;
const normQ = (q: string) => q.toLowerCase().replace(/[\s?？!.,~·]/g, "").replace(/(요|죠|지|니|냐|나|까)$/, "");
function bigrams(s: string) { const o = new Set<string>(); for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); return o; }
export function isRepeat(q: string) {
  const a = normQ(q), A = bigrams(a); if (a.length < 2) return false;
  return S.qaLog.some((x) => {
    if (Date.now() - x.at > 20 * 60000) return false; const b = normQ(x.q); if (a === b) return true; if (a.length < 6 || b.length < 6) return false;
    const B = bigrams(b); let n = 0; A.forEach((g) => { if (B.has(g)) n++; });
    return n / Math.max(1, Math.min(A.size, B.size)) >= 0.75 && Math.abs(a.length - b.length) <= Math.max(3, a.length * 0.3);
  });
}
/** this conversation, scored sentence by sentence with the widened query (all of it when ≤ maxChars) */
function wideTranscript(query: string, maxChars: number) {
  const qt = qTokens(query); if (!qt.size) return { text: "", n: 0 }; const total = joined().length;
  if (total <= maxChars) return { text: S.segs.map((s) => `[${s.at ? hhmm(s.at) : "--"}] ${segText(s)}`).join("\n"), n: S.segs.length, all: true };
  const sc: [number, number][] = []; S.segs.forEach((s, i) => { const st = qTokens(segText(s)); let v = 0; qt.forEach((t) => { if (st.has(t)) v += /^[a-z0-9]/.test(t) ? 3 : 1; }); if (v >= 2) sc.push([v, i]); });
  sc.sort((a, b) => b[0] - a[0]); const pick = new Set<number>(); for (const [, i] of sc.slice(0, 14)) for (let k = i - 1; k <= i + 1; k++) if (k >= 0 && k < S.segs.length) pick.add(k);
  return { text: [...pick].sort((a, b) => a - b).map((i) => `[${S.segs[i].at ? hhmm(S.segs[i].at) : "--"}] ${segText(S.segs[i])}`).join("\n").slice(0, maxChars), n: sc.length };
}
function deepOn(node: NodeHandle, on: boolean) { S.deepRuns = Math.max(0, S.deepRuns + (on ? 1 : -1)); node.setDeep(on); setStatus(); wake(2000); }
export async function deepAsk(q: string, node: NodeHandle, { reason, tail, canSearch }: { reason: string; tail: string; canSearch: boolean }) {
  const step = (n: number, t: string) => node.setBody(`⟲ 넓게 찾는 중 — ${reason}\n${["", "① ", "② ", "③ "][n] || ""}${t}`);
  deepOn(node, true);
  try {
    step(1, "같은 뜻의 다른 표현과 관련 용어로 질문을 넓히는 중…");
    let terms: string[] = [];
    try { const t = await aiCall(deepExpandPrompt(q), { maxTokens: 220, kind: "deep" }); terms = t.split(/[,，、\n]/).map((x) => x.replace(/^[-\d.\s]+/, "").trim()).filter((x) => x && x.length <= 30).slice(0, 18); }
    catch (e: any) { if (e && e.code === "no_key") throw e; }
    const query = [q, ...terms].join(" ");
    const nDocs = S.docs.filter(isFinal).length;
    step(2, `${terms.length ? "넓힌 검색어: " + terms.slice(0, 6).join(", ") + (terms.length > 6 ? " 외 " + (terms.length - 6) + "개" : "") + "\n" : ""}회의록·자료 ${nDocs}개 (${index.chunks.length}조각)와 지금 대화 전체를 훑는 중…`);
    const hits = index.chunks.length ? retrieveScored(query, 14).filter((x) => x.n >= 2) : [];
    const conv = wideTranscript(query, 12000);
    const seen = new Set<string>(); let shown = 0;
    for (const h of hits) { if (shown >= 3) break; if (seen.has(h.c.doc)) continue; seen.add(h.c.doc); const sent = bestSentence(h.c.text, query); if (sent) { addNode({ type: "past", title: h.c.doc, body: sent, source: "넓게 찾은 대목" }); shown++; } }
    const docsHit = new Set(hits.map((h) => h.c.doc)).size;
    step(3, `찾은 대목: 회의록·자료 ${docsHit}곳 ${hits.length}조각, 지금 대화 ${conv.all ? "전체" : conv.n + "곳"} — 답을 정리하는 중…`);
    let mat = hits.map((h) => "<<" + h.c.doc + ">>\n" + h.c.text).join("\n---\n"); if (mat.length > 14000) mat = mat.slice(0, 14000);
    const prompt = deepAnswerPrompt({ q, terms, mat, conv, tail, canSearch });
    const head = `넓게 찾은 결과 · 회의록·자료 ${docsHit}곳, 대화 ${conv.all ? "전체" : conv.n + "곳"}\n`;
    const onText = (t: string) => node.setBody(head + withLead(t.replace(DEEP_MARK, "").trim()));
    let t: string, links: { t: string; u: string }[] = [];
    if (canSearch) {
      try { const r = await searchCall(prompt, { maxTokens: 1200, onText, kind: "deep" }); t = r.text; links = r.links; }
      catch (e: any) { if (e && (e.code === "http" || e.code === "bad_model") && /search|tool/i.test(e.message || "")) t = await aiCall(prompt, { maxTokens: 1200, onText, kind: "deep" }); else throw e; }
    } else t = await aiCall(prompt, { maxTokens: 1200, onText, kind: "deep" });
    t = (t || "").replace(DEEP_MARK, "").trim(); node.setBody(head + withLead(t)); if (links.length) node.setLinks(links);
    S.qaLog.push({ q, a: t, at: Date.now(), deep: true }); logLine(q, "질문"); logLine(t.slice(0, 400), "답");
  } catch (e: any) { node.setBody((e && e.text) || errText(e)); }
  deepOn(node, false);
}
