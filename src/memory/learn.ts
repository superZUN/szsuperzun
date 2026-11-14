// 용어 자동 학습: candidates for the glossary, from two sources —
//  1) the live corrector: a word it keeps fixing the same way (e.g. "쎌라인" → "셀 라인", 2+ times) is a misrecognition
//  2) the daily summary: new names / terms the AI noticed in the day's conversation
// Nothing is added on its own: the 설정 tab lists the suggestions with 등록 / 무시.
import { $ } from "../util";
import { ls } from "../storage/ls";
import { glossary, storeGlossary, addToGlossary, gMsg } from "../library/glossary";

export interface PairStat { wrong: string; right: string; n: number; last: number }
export interface AITerm { term: string; note: string; wrong: string[]; day: string }
const pairs: Record<string, PairStat> = ls.json("ms.learn.pairs", {});
let aiTerms: AITerm[] = ls.json("ms.learn.ai", []);
const ignored = new Set<string>(ls.json<string[]>("ms.learn.ignore", []));
const save = () => { ls.set("ms.learn.pairs", JSON.stringify(pairs)); ls.set("ms.learn.ai", JSON.stringify(aiTerms.slice(-200))); ls.set("ms.learn.ignore", JSON.stringify([...ignored].slice(-500))); };

/** word-level differences between what was heard and the correction (replaced spans only) */
export function diffSpans(raw: string, fixed: string): [string, string][] {
  const a = raw.split(/\s+/).filter(Boolean), b = fixed.split(/\s+/).filter(Boolean);
  if (a.length > 60 || b.length > 60) return [];
  const L = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: [string, string][] = []; let i = 0, j = 0, wa: string[] = [], wb: string[] = [];
  const close = () => { if (wa.length && wb.length) out.push([wa.join(" "), wb.join(" ")]); wa = []; wb = []; };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { close(); i++; j++; }
    else if (j < b.length && (i >= a.length || L[i][j + 1] >= L[i + 1][j])) wb.push(b[j++]);
    else wa.push(a[i++]);
  }
  close(); return out;
}
const strip = (s: string) => s.replace(/[\s.,!?~·'"()]/g, "");
/** called with every corrected sentence */
export function recordFix(raw: string, fixed: string) {
  if (!fixed || raw === fixed) return;
  for (const [w, r] of diffSpans(raw, fixed)) {
    const ws = strip(w), rs = strip(r);
    if (!ws || !rs || ws === rs) continue; // spacing / punctuation only
    if (/\d/.test(r) || w.length > 16 || r.length > 24) continue; // numbers and long rewrites are not terms
    const key = ws + "→" + rs; const p = pairs[key] || (pairs[key] = { wrong: w, right: r, n: 0, last: 0 }); p.n++; p.last = Date.now();
  }
  save();
}
export function addAITerms(list: any[], day: string) {
  for (const t of list || []) {
    const term = String(t.term || "").trim(); if (!term || term.length > 40) continue;
    if (aiTerms.some((x) => x.term === term)) continue;
    aiTerms.push({ term, note: String(t.note || "").trim().slice(0, 120), wrong: (Array.isArray(t.wrong) ? t.wrong : []).map((x: any) => String(x).trim()).filter(Boolean).slice(0, 4), day });
  }
  save(); renderLearn();
}
const inGlossary = (term: string) => glossary.text.toLowerCase().includes(term.toLowerCase());
export interface Suggestion { key: string; label: string; detail: string; apply: () => string }
export function suggestions(): Suggestion[] {
  const out: Suggestion[] = [];
  Object.entries(pairs).filter(([k, p]) => p.n >= 2 && !ignored.has(k) && !(inGlossary(p.right) && glossary.text.includes(p.wrong))).sort((a, b) => b[1].n - a[1].n).slice(0, 30)
    .forEach(([k, p]) => out.push({ key: k, label: `${p.wrong} → ${p.right}`, detail: `교정기가 ${p.n}번 고친 말 · 오인식으로 등록`, apply: () => addToGlossary(glossary.text, p.right, p.wrong) }));
  aiTerms.filter((t) => !ignored.has("ai:" + t.term) && !inGlossary(t.term)).slice(-30).reverse()
    .forEach((t) => out.push({ key: "ai:" + t.term, label: t.term, detail: `${t.note || "새로 나온 용어"}${t.wrong.length ? " · 오인식: " + t.wrong.join(", ") : ""} (${t.day} 대화)`, apply: () => {
      let text = (glossary.text ? glossary.text + "\n" : "") + t.term + (t.note ? " = " + t.note : "");
      for (const w of t.wrong) text = addToGlossary(text, t.term, w);
      return text.trim();
    } }));
  return out;
}
export function renderLearn() {
  const box = $("learnBox"); if (!box) return; const list = suggestions(); box.textContent = "";
  $("learnCount").textContent = list.length || "";
  if (!list.length) { const p = document.createElement("div"); p.className = "hint"; p.textContent = "아직 제안이 없습니다. 대화가 쌓이면 자주 틀리게 받아써지는 말과 새로 나온 용어를 여기에 모읍니다."; box.append(p); return; }
  list.forEach((s) => {
    const row = document.createElement("div"); row.className = "lrow"; row.dataset.key = s.key;
    const t = document.createElement("div"); t.className = "ltext"; const b = document.createElement("b"); b.textContent = s.label; const d = document.createElement("span"); d.className = "hint"; d.textContent = s.detail; t.append(b, d);
    const add = document.createElement("button"); add.textContent = "등록"; add.className = "primary";
    add.addEventListener("click", async () => { const r = await storeGlossary(s.apply()); gMsg(r.msg, r.warn); ignored.add(s.key); save(); renderLearn(); });
    const no = document.createElement("button"); no.textContent = "무시"; no.addEventListener("click", () => { ignored.add(s.key); save(); renderLearn(); });
    row.append(t, add, no); box.append(row);
  });
}
