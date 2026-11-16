// Autosave (every 5 s, only when something changed; big pictures left out), restore after a reload, "새 회의",
// the new-meeting question when 시작 is pressed with an old meeting still loaded (meeting mode only), and the closing check.
import { $, hhmm } from "../util";
import { S, type CardData } from "../state";
import { ls } from "../storage/ls";
import { ai, aiCall, errText } from "../ai/client";
import { checkPrompt } from "../ai/prompts";
import { addNode, clearCards, setFocusItem } from "../hud/cards";
import { BASE_TERMS, LIB_TERMS } from "../library/dict";
import { kwMap, renderKwBar, clearKeywords } from "../analysis/keywords";
import { mdToHtml } from "../minutes/md";
import { M, setStage, showReview, clearMinutesState, defaultTitle } from "../minutes/minutes";
import { renderActions } from "./actions";
import { agenda, renderAgBar, updatePrepCount, plannedMin, minutesFacts, prepSig } from "./prep";
import { carry } from "./carry";
import { renderTranscript, reconcileManual, annotatedTranscript, resetTranscriptView } from "../transcript";
import { toggle } from "../controls";
import { dropRecording, recKey } from "../speech/recorder";
import { spk } from "../minutes/speakers";

export const session = { prepAtMinutes: null as string | null, continueOk: false, lastSaved: "" };
export const agLogForAnnotate = () => S.agLog;

function snapshot() {
  return {
    v: 1, savedAt: Date.now(), meetingStart: S.meetingStart, sentUpTo: S.sentUpTo,
    segs: S.segs.map((s) => ({ raw: s.raw, fix: s.fix == null ? s.raw : s.fix, at: s.at, manual: s.manual || undefined })),
    notes: S.notes, marks: S.marks.map((m) => ({ at: m.at })),
    history: S.history.slice(0, 200).map((d) => (d.img && (d.img.pending || d.img.error || (d.img.src || "").length > 120000) ? { ...d, img: null } : d)),
    shownTitles: S.shownTitles.slice(-30), qaLog: S.qaLog.slice(-10),
    actions: S.actions, agIdx: S.agIdx, agLog: S.agLog, agAlerted: S.agAlerted, totAlert: S.totAlert,
    prep: { title: $("pTitle").value, dur: $("pDur").value, agenda: $("pAgenda").value, people: $("pPeople").value },
    minutesText: M.text, minutesForLen: M.forLen, minutesDocId: M.docId, mode: $("mode").value, minTitle: $("minTitle").value,
    spk: spk.cur, minutesKeyAt: M.keyAt, minTitleAuto: M.titleAuto, prepAtMinutes: session.prepAtMinutes, continueOk: session.continueOk, pendingFinal: M.pendingFinal, minStage: M.stage,
    kw: [...kwMap.values()].slice(-80).map((e) => ({ k: e.k, at: e.at, last: e.last, count: e.count, origin: e.origin, defT: e.def && e.def.t, recall: e.recall, wiki: e.wiki, web: e.web && !e.web.pending ? e.web : null, ctx: e.ctx })),
  };
}
export function saveSession() {
  const s = JSON.stringify(snapshot()); const cmp = s.replace(/"savedAt":\d+,/, ""); if (cmp === session.lastSaved) return; session.lastSaved = cmp;
  try { localStorage.setItem("ms.session", s); } catch { /* full */ }
}
export function restoreSession() {
  const s = ls.json<any>("ms.session", null);
  if (!s || s.v !== 1) return false; const p = s.prep || {};
  const has = (s.segs || []).length || (s.notes || []).length || (s.history || []).length || (s.actions || []).length || p.agenda || p.title || p.people; if (!has) return false;
  S.meetingStart = s.meetingStart || 0; S.segs = s.segs || []; S.sentUpTo = Math.min(s.sentUpTo || 0, S.segs.length); S.notes = s.notes || []; S.marks = s.marks || [];
  S.history.push(...((s.history || []) as CardData[])); S.shownTitles.push(...(s.shownTitles || [])); S.qaLog = s.qaLog || []; S.actions = s.actions || [];
  S.agIdx = s.agIdx ?? -1; S.agLog = s.agLog || []; S.agAlerted = s.agAlerted || {}; S.totAlert = s.totAlert || 0;
  $("pTitle").value = p.title || ""; $("pDur").value = p.dur || ""; $("pAgenda").value = p.agenda || ""; $("pPeople").value = p.people || "";
  M.text = s.minutesText || ""; M.forLen = s.minutesForLen ?? -1; M.docId = s.minutesDocId || null; if (s.mode) $("mode").value = s.mode; $("minTitle").value = s.minTitle || "";
  spk.cur = s.spk || null;
  M.keyAt = s.minutesKeyAt || ""; M.titleAuto = s.minTitleAuto !== false; session.prepAtMinutes = s.prepAtMinutes ?? null; session.continueOk = !!s.continueOk; M.pendingFinal = s.pendingFinal || null;
  if (s.minStage) setStage(s.minStage.step, s.minStage.label, s.minStage.state === "run" ? "review" : s.minStage.state); if (M.pendingFinal) showReview(M.pendingFinal.issues || []);
  (s.kw || []).forEach((o: any) => { const def = o.defT ? [...BASE_TERMS, ...LIB_TERMS].find((x) => x.t === o.defT) || null : null; kwMap.set(o.k.toLowerCase(), { ...o, def }); }); renderKwBar();
  if (M.text) { $("minOut").innerHTML = mdToHtml(M.text); $("minActions").hidden = false; }
  $("histCount").textContent = S.history.length; $("markCount").textContent = S.marks.length || "";
  renderTranscript();
  S.history.filter((d) => !d.dismissed).slice(0, 4).reverse().forEach((d) => addNode(d, { restore: true }));
  if (S.segs.length || S.notes.length || S.history.length) { $("restoreMsg").textContent = `${hhmm(s.savedAt)}에 자동 저장된 회의를 불러왔습니다 · 받아쓰기 ${S.segs.length}문장, 메모 ${S.notes.length}개, 할 일 ${S.actions.length}개. 새 회의는 '준비' 탭의 '새 회의'.`; $("restoreBar").hidden = false; }
  return true;
}
/** wipe the transcript and everything said (the 비우기 button) */
export function clearTranscript() {
  S.segs = []; S.sentUpTo = 0; S.marks.forEach((m) => clearTimeout(m.timer)); S.marks = []; S.notes = []; S.focusAt = 0; $("markCount").textContent = "";
  resetTranscriptView(); renderTranscript(); if (!$("rawView").hidden) $("rawView").textContent = ""; void dropRecording(recKey()); S.meetingStart = 0; clearMinutesState(); // the recording belongs to the meeting being cleared
}
/** wipe the last meeting; keepPrep keeps the 준비 fields (e.g. already filled in for the next meeting) */
export function resetMeeting(keepPrep: boolean) {
  if (S.running) void toggle();
  clearTranscript();
  S.history.length = 0; S.shownTitles.length = 0; S.qaLog = []; S.actions = []; S.agIdx = -1; S.agLog = []; S.agAlerted = {}; S.totAlert = 0; clearKeywords();
  clearCards(); setFocusItem(null); $("histCount").textContent = "0"; renderActions(true);
  if (!keepPrep) ["pTitle", "pDur", "pAgenda", "pPeople"].forEach((id) => { $(id).value = ""; });
  $("mailBox").hidden = true; $("chkOut").textContent = ""; $("restoreBar").hidden = true; $("minSheet").hidden = true;
  session.prepAtMinutes = null; session.continueOk = false;
  renderAgBar(); updatePrepCount(); try { localStorage.removeItem("ms.session"); } catch { /* blocked */ } session.lastSaved = "";
}
function lastActivity() { const t = [...S.segs.map((s) => s.at || 0), ...S.notes.map((n) => n.at)]; return t.length ? Math.max(...t) : 0; }
/** meeting mode only: minutes were written, or 30 min passed since the last word */
export function needsBoundary() {
  if (S.appMode === "conv") return false; if (session.continueOk || !(S.segs.length || S.notes.length)) return false;
  return !!M.text || Date.now() - lastActivity() > 30 * 60000;
}
export function askBoundary() {
  const last = lastActivity();
  $("boundaryMsg").textContent = `지난 회의 기록이 남아 있습니다 (${M.text ? "회의록 작성됨, " : ""}받아쓰기 ${S.segs.length}문장, 마지막 ${last ? hhmm(last).slice(0, 5) : "-"}).`;
  $("boundaryBar").hidden = false;
}

/* ---------- closing check ---------- */
let chkBusy = false;
async function runCheck() {
  $("chkSheet").hidden = false; if (chkBusy) return; const out = $("chkOut");
  if (!ai.apiKey) { out.textContent = errText({ code: "no_key" }); return; }
  reconcileManual(); const ann = annotatedTranscript();
  if (ann.length < 40 && !S.actions.length) { out.innerHTML = '<div class="note">아직 점검할 대화가 거의 없습니다.</div>'; return; }
  chkBusy = true; $("chkRun").disabled = true; out.innerHTML = '<div class="note mono" style="font-size:10px">CHECKING…</div>';
  const A = agenda();
  const prompt = checkPrompt({ ann, hasCarry: carry.items.length > 0, title: $("pTitle").value.trim() || defaultTitle(), elapsedMin: S.meetingStart ? Math.round((Date.now() - S.meetingStart) / 60000) : 0, plannedMin: plannedMin(), facts: minutesFacts(), current: A.length ? (S.agIdx >= 0 && A[S.agIdx] ? A[S.agIdx].title : "(시작 전)") : "" });
  const render = (t: string) => { out.innerHTML = mdToHtml(t); };
  try { const t = await aiCall(prompt, { maxTokens: 1500, onText: render, kind: "check" }); render(t); }
  catch (e) { const p = document.createElement("div"); p.className = "hint warn"; p.textContent = errText(e); out.append(p); }
  chkBusy = false; $("chkRun").disabled = false;
}

export function initSession() {
  setInterval(saveSession, 5000);
  addEventListener("pagehide", saveSession); document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveSession(); });
  addEventListener("beforeunload", (e) => { saveSession(); if (S.running) { e.preventDefault(); (e as any).returnValue = ""; } });
  $("restoreOk").addEventListener("click", () => { $("restoreBar").hidden = true; });
  const nb = $("newMeeting"); let armed = false;
  nb.addEventListener("click", () => {
    if (!armed) { armed = true; nb.textContent = "정말 비울까요? 한 번 더"; nb.classList.add("arm"); $("newMsg").textContent = M.text ? "" : "이번 회의의 회의록을 아직 만들지 않았습니다. 비우면 받아쓰기는 되돌릴 수 없습니다."; setTimeout(() => { armed = false; nb.textContent = "새 회의"; nb.classList.remove("arm"); }, 4000); return; }
    armed = false; nb.textContent = "새 회의"; nb.classList.remove("arm"); resetMeeting(false); $("newMsg").textContent = "새 회의를 시작할 준비가 됐습니다. 이름·안건·참석자를 적고 '시작'을 누르세요.";
  });
  $("bNew").addEventListener("click", () => { $("boundaryBar").hidden = true; const keep = session.prepAtMinutes !== null ? prepSig() !== session.prepAtMinutes : false; resetMeeting(keep); void toggle(); });
  $("bCont").addEventListener("click", () => { $("boundaryBar").hidden = true; session.continueOk = true; void toggle(); });
  $("clearBtn").addEventListener("click", clearTranscript);
  ["chkBtn", "chkBtn2"].forEach((id) => $(id).addEventListener("click", runCheck));
  $("chkRun").addEventListener("click", runCheck); $("chkClose").addEventListener("click", () => { $("chkSheet").hidden = true; });
}
export const initialSnapshot = () => { session.lastSaved = JSON.stringify(snapshot()).replace(/"savedAt":\d+,/, ""); };
