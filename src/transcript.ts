// The transcript: utterances (raw + corrected), the editable view, memos, ★ highlights, the live corrector,
// and registering a misrecognition into the glossary.
import { $, hhmm } from "./util";
import { S, segText, joined, rawJoined, dailyTalk, type Seg } from "./state";
import { cfg } from "./settings/settings";
import { ai, aiCall } from "./ai/client";
import { fixPrompt } from "./ai/prompts";
import { effectivePace } from "./ai/usage";
import { addNode } from "./hud/cards";
import { glossary, storeGlossary, addToGlossary, gMsg } from "./library/glossary";
import { analyze } from "./analysis/analyze";
import { updateEndBar } from "./minutes/minutes";
import { agLogForAnnotate } from "./meeting/session";
import { live } from "./speech/recognizer";
import { logSeg, logLine } from "./memory/daylog";
import { recordFix } from "./memory/learn";

export const HL_BEFORE = 30000, HL_AFTER = 30000; // a highlight covers 30 s before and after the tap
let taShown = "", taDirty = false, fixing = false, fixTimer: any = null, lastSel = "";
export let lastFinalSeg: Seg | null = null;

/** correction is off when switched off, without a key, or (by default) in everyday talk */
export const fixActive = () => cfg.fixOn && !!ai.apiKey && (!dailyTalk() || cfg.fixDaily);
export function updateFixStat() {
  const n = S.segs.filter((s) => s.fix == null).length;
  $("fixStat").textContent = !cfg.fixOn ? "교정 꺼짐" : !ai.apiKey ? "교정하려면 API 키 필요" : dailyTalk() && !cfg.fixDaily ? "일상 대화 — 교정 쉼" : n ? `교정 중 · ${n}문장 대기` : S.segs.length ? "교정 완료" : "";
}
export function renderTranscript() {
  const ta = $("transcript");
  if (!$("rawView").hidden) $("rawView").textContent = rawJoined();
  updateFixStat(); updateEndBar();
  if (document.activeElement === ta) { taDirty = true; return; }
  const atEnd = ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 8; ta.value = joined(); taShown = ta.value; taDirty = false; if (atEnd) ta.scrollTop = ta.scrollHeight;
}
/** typed edits: appended text becomes a new utterance; edits in the middle replace the whole transcript */
export function reconcileManual() {
  const v = $("transcript").value; if (v === taShown) return;
  if (v.startsWith(taShown)) { const extra = v.slice(taShown.length).trim(); if (extra) S.segs.push({ raw: extra, fix: extra, at: Date.now() }); }
  else { S.segs = v.trim() ? [{ raw: rawJoined() || v, fix: v, manual: true, at: S.segs.length ? S.segs[0].at : Date.now() }] : []; S.sentUpTo = Math.min(S.sentUpTo, S.segs.length); }
  taShown = v;
}
export function resetTranscriptView() { taShown = ""; lastFinalSeg = null; $("transcript").value = ""; }
export function addUtterance(t: string) {
  const s: Seg = { raw: t, fix: fixActive() ? null : t, at: Date.now() }; S.segs.push(s); lastFinalSeg = s; logSeg(s); renderTranscript(); queueFix(); return s;
}

/* ---------- memo + highlight ---------- */
export function spanText(t0: number, t1: number, max?: number) { const s = S.segs.filter((x) => x.at >= t0 && x.at <= t1).map(segText).join(" ").trim(); return max && s.length > max ? "…" + s.slice(-max) : s; }
export function addMemo() {
  const inp = $("memoInput"), text = inp.value.trim(); if (!text) return;
  inp.value = ""; if (!S.meetingStart) S.meetingStart = Date.now();
  S.notes.push({ at: Date.now(), text }); logLine(text, "메모"); addNode({ type: "note", title: "", body: text }); updateEndBar(); inp.focus();
}
export function markNow() {
  const at = Date.now(); if (!S.meetingStart) S.meetingStart = at;
  const m: any = { at }; S.marks.push(m); S.markFlash = performance.now(); logLine("★ 중요 표시", "메모", at);
  const b = $("markNow"); b.classList.add("flash"); setTimeout(() => b.classList.remove("flash"), 500); $("markCount").textContent = S.marks.length;
  const before = spanText(at - HL_BEFORE, at, 140);
  const node = addNode({ type: "mark", title: "중요 표시 · " + hhmm(at), body: (before ? "앞: " + before + "\n" : "") + "뒤 30초 대화도 함께 중요 내용으로 기록 중…" });
  // once the 30 s after the tap have passed, show what the highlight captured
  m.timer = setTimeout(() => { const after = spanText(at + 1, at + HL_AFTER, 140); node.setBody((before ? "앞: " + before + "\n" : "") + (after ? "뒤: " + after : "(뒤 30초 동안 받아쓴 말 없음)")); }, HL_AFTER + 1500);
  S.focusAt = at; if (ai.apiKey && S.segs.length) { if (S.busy) S.pending = true; else void analyze(true); }
  updateEndBar();
}
/** notes and highlights for the analysis prompt */
export function userFocusBlock() {
  const out: string[] = []; const now = Date.now();
  if (now - S.focusAt < HL_AFTER + 5000) out.push(`[사용자가 ${hhmm(S.focusAt)}에 '중요' 표시를 눌렀다. 그 앞뒤 대화의 결정·숫자·일정·약속을 최우선으로 짚을 것]`);
  const recent = S.notes.slice(-3); if (recent.length) out.push("[사용자 메모]\n" + recent.map((n) => `- ${hhmm(n.at)} ${n.text}`).join("\n"));
  return out.length ? "\n" + out.join("\n") + "\n" : "";
}
/** transcript for the minutes: highlighted spans, memos and agenda changes marked inline, in time order */
export function annotatedTranscript() {
  const items: any[] = S.segs.map((s) => ({ at: s.at || 0, k: 0, s }));
  S.notes.forEach((n) => items.push({ at: n.at, k: 1, n })); S.marks.forEach((m) => items.push({ at: m.at, k: 2, m }));
  agLogForAnnotate().forEach((g) => items.push({ at: g.at, k: -1, g }));
  items.sort((a, b) => a.at - b.at || a.k - b.k);
  const inMark = (at: number) => S.marks.some((m) => at >= m.at - HL_BEFORE && at <= m.at + HL_AFTER);
  let out = "", open = false;
  for (const it of items) {
    if (it.k === 0) { const hot = inMark(it.at); if (hot && !open) { out += "\n⟦중요 구간 시작⟧ "; open = true; } else if (!hot && open) { out += " ⟦중요 구간 끝⟧\n"; open = false; } out += segText(it.s) + " "; }
    else if (it.k === -1) out += `\n\n⟦안건 ${it.g.idx + 1} 시작 ${hhmm(it.at)}: ${it.g.title}⟧\n`;
    else if (it.k === 1) out += `\n⟦사용자 메모 ${hhmm(it.at)}⟧ ${it.n.text}\n`;
    else out += ` ⟦★ 사용자가 ${hhmm(it.at)}에 중요 표시⟧ `;
  }
  if (open) out += " ⟦중요 구간 끝⟧"; return out.replace(/[ \t]+\n/g, "\n").trim();
}

/* ---------- live correction: batches of sentences, only spelling / terms / numbers / spacing ---------- */
export function queueFix() {
  if (!fixActive()) { // nothing to wait for: show the raw text as final
    let ch = false; S.segs.forEach((s) => { if (s.fix == null && !s.busy) { s.fix = s.raw; ch = true; } }); if (ch) renderTranscript(); return;
  }
  const waiting = S.segs.filter((s) => s.fix == null && !s.busy); const n = waiting.length; if (!n) { clearTimeout(fixTimer); return; }
  // changed from legacy (2 sentences / 0.7 s, i.e. about one call per sentence): batches by cost setting;
  // a lone sentence waits at most `maxWait` from when it was said (the minutes re-correct everything anyway)
  const pace = effectivePace(), batch = pace === "fast" ? 2 : pace === "save" ? 6 : 4, maxWait = pace === "fast" ? 700 : pace === "save" ? 20000 : 10000;
  if (n >= batch) { clearTimeout(fixTimer); void runFix(); return; }
  if (pace === "fast") { clearTimeout(fixTimer); fixTimer = setTimeout(runFix, maxWait); return; }
  if (!fixTimer) fixTimer = setTimeout(() => { fixTimer = null; void runFix(); }, Math.max(0, waiting[0].at + maxWait - Date.now()));
}
export const plausible = (fixed: string, raw: string) => !!fixed && fixed.length <= raw.length * 2 + 24 && fixed.length >= raw.length * 0.4;
async function runFix() {
  clearTimeout(fixTimer); fixTimer = null;
  if (fixing) return; const batch = S.segs.filter((s) => s.fix == null && !s.busy).slice(0, 6); if (!batch.length) return;
  fixing = true; batch.forEach((s) => { s.busy = true; });
  const i0 = S.segs.indexOf(batch[0]), before = S.segs.slice(Math.max(0, i0 - 6), i0).map(segText).join(" ").slice(-400);
  const { system, prompt } = fixPrompt({ daily: dailyTalk(), conv: S.appMode === "conv", before, lines: batch.map((s) => s.raw) });
  let arr: any[] | null = null, limited = false;
  try {
    const t = await aiCall(prompt, { system, maxTokens: 900, kind: "fix" }); const a = t.indexOf("["), b = t.lastIndexOf("]");
    if (a >= 0 && b > a) { const v = JSON.parse(t.slice(a, b + 1)); if (Array.isArray(v) && v.length === batch.length) arr = v; }
  } catch (e: any) { limited = e && e.code === "rate_limited"; }
  batch.forEach((s, i) => { const v = arr && typeof arr[i] === "string" ? arr[i].trim() : ""; s.fix = plausible(v, s.raw) ? v : s.raw; s.busy = false; if (s.fix !== s.raw) recordFix(s.raw, s.fix); });
  fixing = false; renderTranscript();
  if (lastFinalSeg && batch.includes(lastFinalSeg)) live.showFixed(lastFinalSeg);
  if (limited) setTimeout(queueFix, 15000); else queueFix();
}

/* ---------- view toggle + misrecognition registration ---------- */
function setView(raw: boolean) {
  $("viewRaw").setAttribute("aria-selected", String(raw)); $("viewFixed").setAttribute("aria-selected", String(!raw));
  $("rawView").hidden = !raw; $("transcript").hidden = raw; if (raw) { reconcileManual(); $("rawView").textContent = rawJoined() || "(아직 없음)"; }
}
export function initTranscriptUI(scheduleAnalyze: () => void) {
  $("fixOn").addEventListener("change", () => { if (!cfg.fixOn) S.segs.forEach((s) => { if (s.fix == null && !s.busy) s.fix = s.raw; }); renderTranscript(); });
  $("transcript").addEventListener("blur", () => { reconcileManual(); if (taDirty) renderTranscript(); });
  let typeTimer: any = null;
  $("transcript").addEventListener("input", () => { clearTimeout(typeTimer); typeTimer = setTimeout(() => { reconcileManual(); scheduleAnalyze(); updateEndBar(); updateFixStat(); }, 700); });
  $("memoAdd").addEventListener("click", addMemo);
  $("memoInput").addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); addMemo(); } });
  $("markNow").addEventListener("click", markNow);
  $("viewFixed").addEventListener("click", () => setView(false)); $("viewRaw").addEventListener("click", () => setView(true));
  document.addEventListener("selectionchange", () => {
    const ta = $("transcript"); let t = "";
    if (document.activeElement === ta && ta.selectionEnd > ta.selectionStart) t = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    else { const sel = getSelection(); if (sel && sel.rangeCount && $("rawView").contains(sel.anchorNode)) t = sel.toString(); }
    t = t.trim(); if (t && t.length <= 40) lastSel = t;
  });
  $("markBtn").addEventListener("click", () => { $("markForm").hidden = false; $("markWrong").value = lastSel; $("markRight").value = ""; $("markMsg").textContent = ""; ($("markWrong").value ? $("markRight") : $("markWrong")).focus(); });
  $("markCancel").addEventListener("click", () => { $("markForm").hidden = true; });
  $("markAdd").addEventListener("click", async () => {
    const wrong = $("markWrong").value.trim(), right = $("markRight").value.trim();
    if (!wrong || !right) { $("markMsg").className = "hint warn"; $("markMsg").textContent = "잘못 받아쓴 말과 올바른 용어를 모두 적어 주세요."; return; }
    reconcileManual(); let n = 0;
    S.segs.forEach((s) => { const cur = segText(s); if (cur.includes(wrong)) { n += cur.split(wrong).length - 1; s.fix = cur.split(wrong).join(right); } });
    renderTranscript(); $("markForm").hidden = true; if (lastFinalSeg) live.showFixed(lastFinalSeg);
    const r = await storeGlossary(addToGlossary(glossary.text, right, wrong));
    $("markMsg").className = "hint" + (r.warn ? " warn" : ""); $("markMsg").textContent = `'${wrong}' → '${right}' 사전에 등록${n ? ` · 지금까지 ${n}곳 바로잡음` : ""}${r.warn ? " · " + r.msg : ""}`; gMsg(r.msg, r.warn);
  });
  $("markRight").addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); $("markAdd").click(); } });
  $("rawBtn").addEventListener("click", () => { const w = $("transcriptWrap"), open = w.hidden; w.hidden = !open; $("rawBtn").setAttribute("aria-expanded", String(open)); });
}
