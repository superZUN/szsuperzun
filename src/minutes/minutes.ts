// Minutes, confirmed before they count:
//  1) revise — the whole transcript re-read in 5,000-char parts (context before/after, 3 at a time); a part is taken only
//     if its length is 0.6–1.5× and every ⟦⟧ marker survived
//  2) write — streamed; the company template if there is one
//  3) verify — {ok, issues}; problems are fixed once and checked again
//  4) confirm — minutes + "부록: 최종 대화 기록 (교정본)" saved, uploaded, indexed; tasks carried over.
// Until then the library shows 준비중 (or 검토 필요 with the issues). A previous confirmed record of the same meeting
// stays until the new one is confirmed, then is replaced. Unchanged input → the existing minutes are reused.
import { $, stamp, download, fileSafe } from "../util";
import { S, joined, rawJoined, type Doc } from "../state";
import { cfg } from "../settings/settings";
import { ai, aiCall, errText } from "../ai/client";
import { revisePrompt, minutesPrompt, verifyPrompt, fixMinutesPrompt, mailPrompt } from "../ai/prompts";
import { saveLocal } from "../storage/idb";
import { server } from "../storage/server";
import { putDoc, delDoc, pushDoc, rebuildIndex, isFinal, contextBlock } from "../library/docs";
import { renderDocs } from "../library/ui";
import { mdToHtml } from "./md";
import { TYPE } from "../hud/cards";
import { completeObjects } from "../util";
import { agenda, people, plannedMin, minutesFacts, prepSig } from "../meeting/prep";
import { carry, carryForward } from "../meeting/carry";
import { annotatedTranscript, reconcileManual } from "../transcript";
import { session } from "../meeting/session";
import { diarize, namedText, renderSpeakers, spk, clearSpeakers } from "./speakers";
import { dropRecording, recKey } from "../speech/recorder";

export const M = { text: "", busy: false, forLen: -1, docId: null as string | null, keyAt: "", titleAuto: true, stage: null as any, pendingFinal: null as any };

export function defaultTitle() {
  const p = $("pTitle").value.trim(); if (p) return p; const d = new Date(S.meetingStart || Date.now());
  return `${d.getMonth() + 1}/${d.getDate()} ${S.appMode === "conv" ? "대화" : $("mode").selectedOptions[0].textContent}`;
}
/** the "회의록 작성" bar after a session (meeting mode only) */
export function updateEndBar() {
  const bar = $("endBar"); if (!bar) return;
  const has = joined().trim().length > 40 || $("transcript").value.trim().length > 40;
  bar.hidden = S.appMode === "conv" || !(has && !S.running && M.forLen !== S.segs.length);
}
const textSig = (t: string) => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return t.length + ":" + h; };
/** minutes are reused only if nothing was said, edited, noted, highlighted, assigned or moved on since they were written */
export const minutesKey = () => textSig(joined()) + "|" + S.segs.length + "|" + S.notes.length + "|" + S.marks.length + "|" + S.actions.length + "|" + S.agLog.length;
export function openMinutes() {
  reconcileManual(); if (M.titleAuto || !$("minTitle").value) { $("minTitle").value = defaultTitle(); M.titleAuto = true; } $("minSheet").hidden = false;
  const fresh = M.text && M.keyAt === minutesKey();
  if (!fresh && !M.busy) { if (M.text) $("minMsg").textContent = ""; void makeMinutes(); }
}
export function setStage(step: number, label: string, state?: string) {
  M.stage = { step, label, state }; const box = $("minStage"); box.hidden = false; box.className = "stagebar " + (state || "run");
  const steps = ["대화 교정", "회의록 작성", "검증", "확정"]; box.textContent = "";
  const pill = document.createElement("span"); pill.className = "stpill"; pill.textContent = state === "done" ? "확정" : state === "review" ? "검토 필요" : "준비중"; box.append(pill);
  const ol = document.createElement("span"); ol.className = "steps"; steps.forEach((s, i) => { const e = document.createElement("span"); e.textContent = i + 1 + ". " + s; e.className = i + 1 < step || state === "done" ? "ok" : i + 1 === step ? "now" : ""; ol.append(e); }); box.append(ol);
  const l = document.createElement("span"); l.className = "stlabel"; l.textContent = label || ""; box.append(l);
}
const cleanMarkers = (t: string) => t.replace(/⟦\s*중요 구간 시작\s*⟧/g, "[★ 중요]").replace(/⟦\s*중요 구간 끝\s*⟧/g, "[/중요]").replace(/⟦(.*?)⟧/g, "[$1]");
export function splitForRevise(t: string, size: number) {
  const out: string[] = []; let cur = "";
  for (const line of t.split(/\n/)) {
    if ((cur + line).length > size && cur) { out.push(cur); cur = ""; }
    if (line.length > size) { for (let i = 0; i < line.length; i += size) out.push(line.slice(i, i + size)); continue; }
    cur += (cur ? "\n" : "") + line;
  }
  if (cur) out.push(cur); return out;
}
async function reviseTranscript(ann: string, onProgress: (d: number, n: number) => void) {
  const parts = splitForRevise(ann, 5000), res = new Array<string>(parts.length); let done = 0;
  const one = async (i: number) => {
    const before = i ? parts[i - 1].slice(-400) : "", after = i + 1 < parts.length ? parts[i + 1].slice(0, 300) : "";
    const { system, prompt } = revisePrompt(parts[i], before, after);
    let t = ""; try { t = (await aiCall(prompt, { system, maxTokens: Math.min(8000, Math.ceil(parts[i].length * 1.6) + 200), kind: "minutes" })).trim(); } catch (e: any) { if (e && e.code === "no_key") throw e; }
    const ok = t && t.length >= parts[i].length * 0.6 && t.length <= parts[i].length * 1.5 && (parts[i].match(/⟦/g) || []).length === (t.match(/⟦/g) || []).length;
    res[i] = ok ? t : parts[i]; done++; onProgress(done, parts.length);
  };
  for (let i = 0; i < parts.length; i += 3) await Promise.all([i, i + 1, i + 2].filter((k) => k < parts.length).map(one));
  return res.join("\n");
}
function buildMinutesPrompt(text: string, title: string, speakers = "") {
  const cards = S.history.filter((d) => d.type !== "note" && d.type !== "mark" && d.type !== "web").slice(0, 30).reverse().map((d) => `- [${TYPE[d.type]}] ${d.title}: ${d.body}`).join("\n");
  return minutesPrompt({
    text, title, conv: S.appMode === "conv", hasFocus: !!(S.marks.length || S.notes.length), template: cfg.minTemplate, hasPeople: people().length > 0, hasAgenda: agenda().length > 0, hasCarry: carry.items.length > 0,
    typeLabel: S.appMode === "conv" ? "대화" : $("mode").selectedOptions[0].textContent, when: stamp(new Date(S.meetingStart || Date.now())),
    actualMin: S.meetingStart ? Math.round((Date.now() - S.meetingStart) / 60000) : 0, plannedMin: plannedMin(), facts: minutesFacts(), cards,
    past: contextBlock(text.slice(0, 800) + " " + text.slice(-1200), 4), speakers: speakers || undefined,
  });
}
async function verifyMinutes(minutes: string, text: string, speakers = "") {
  const t = await aiCall(verifyPrompt(minutes, text, speakers), { maxTokens: 800, tier: "deep", effort: "low", kind: "minutes" });
  const o = completeObjects(t).find((x) => typeof x.ok === "boolean");
  return o ? { ok: !!o.ok && !(o.issues || []).filter(Boolean).length ? true : !!o.ok, issues: (o.issues || []).filter(Boolean).slice(0, 6) as string[] } : { ok: false, issues: ["검증 결과를 읽지 못했습니다."] };
}
export async function makeMinutes() {
  if (M.busy) return; reconcileManual(); const full = joined().trim(); const out = $("minOut");
  if (!ai.apiKey) { out.innerHTML = ""; const p = document.createElement("div"); p.className = "note"; p.textContent = errText({ code: "no_key" }); out.append(p); return; }
  if (full.length < 40) { out.innerHTML = ""; const p = document.createElement("div"); p.className = "note"; p.textContent = "받아쓴 대화가 거의 없어 회의록을 만들 수 없습니다."; out.append(p); return; }
  M.busy = true; M.text = ""; M.pendingFinal = null; $("minGo").disabled = true; $("minActions").hidden = true; $("minReview").hidden = true; $("mailBox").hidden = true;
  const deep = $("minModel").value === "deep", title = $("minTitle").value.trim() || defaultTitle();
  // an unconfirmed earlier draft of this meeting is dropped now; a confirmed record stays until the new one is confirmed
  const prev = M.docId && S.docs.find((x) => x.id === M.docId); let replaces: string | null = null;
  if (prev && isFinal(prev)) replaces = prev.id; else { if (prev) replaces = prev.replaces || null; if (M.docId) delDoc(M.docId); }
  M.docId = Date.now() + "-m"; const id = M.docId;
  putDoc({ id, name: title + " (회의록)", text: "", added: Date.now(), status: "pending", replaces }); rebuildIndex();
  out.innerHTML = '<div class="note">대화 기록을 맥락에 맞게 교정하고 있습니다…</div>';
  try {
    setStage(1, "대화 기록을 맥락에 맞게 교정하는 중");
    const ann = annotatedTranscript(), src = ann.length > 120000 ? ann.slice(-120000) : ann;
    // the speaker split (from the meeting recording, if any) runs alongside the correction
    let spkErr = "";
    const [revised, sp] = await Promise.all([
      reviseTranscript(src, (d, n) => setStage(1, `대화 기록을 맥락에 맞게 교정하는 중 (${d}/${n})`)),
      diarize((t) => setStage(1, t)).catch((e: any) => { spkErr = e && e.code === "bad_key" ? "Gemini 키가 맞지 않아 화자를 나누지 못했습니다." : "화자 구분은 건너뛰었습니다" + (e && e.message ? ` (${e.message})` : "."); return null; }),
    ]);
    const speakers = sp ? namedText(sp) : ""; renderSpeakers(() => { M.keyAt = ""; void makeMinutes(); }); if (spkErr) $("minMsg").textContent = spkErr;
    setStage(2, "교정된 기록으로 회의록을 쓰는 중");
    const render = (t: string) => { M.text = t; out.innerHTML = mdToHtml(t); out.scrollTop = out.scrollHeight; };
    let minutes = await aiCall(buildMinutesPrompt(revised, title, speakers), { maxTokens: 6000, onText: render, tier: deep ? "deep" : "fast", effort: deep ? "medium" : "low", kind: "minutes" }); render(minutes); out.scrollTop = 0;
    setStage(3, "회의록이 대화 내용과 맞는지 검증하는 중");
    let v = await verifyMinutes(minutes, revised, speakers);
    if (!v.ok) {
      setStage(3, `문제 ${v.issues.length}건을 고치고 다시 검증하는 중`);
      minutes = await aiCall(fixMinutesPrompt(v.issues, minutes, revised), { maxTokens: 6000, onText: render, tier: deep ? "deep" : "fast", effort: "medium", kind: "minutes" }); render(minutes); out.scrollTop = 0;
      v = await verifyMinutes(minutes, revised, speakers);
    }
    M.forLen = S.segs.length; M.keyAt = minutesKey(); session.prepAtMinutes = prepSig(); session.continueOk = false;
    M.pendingFinal = { id, title, minutes, revised, issues: v.issues, speakers };
    if (v.ok) finalizeRecord(); else showReview(v.issues);
  } catch (e: any) {
    const d = S.docs.find((x) => x.id === id); if (d) { d.status = "review"; d.issues = ["작성 중 오류: " + errText(e)]; saveLocal(d); renderDocs(); }
    setStage(M.stage ? M.stage.step : 1, errText(e), "review"); if (e && e.text) M.text = e.text;
  }
  M.busy = false; $("minGo").disabled = false; updateEndBar();
}
const recordText = (p: any) => p.minutes.trim() + (p.speakers ? "\n\n---\n\n## 부록: 화자별 기록 (회의 녹음)\n\n" + p.speakers.trim() : "") + "\n\n---\n\n## 부록: 최종 대화 기록 (교정본)\n\n" + cleanMarkers(p.revised).trim() + "\n";
export function finalizeRecord() {
  const p = M.pendingFinal; if (!p) return; const d = S.docs.find((x) => x.id === p.id);
  const rec: Doc = { id: p.id, name: p.title + " (회의록)", text: recordText(p), added: d ? d.added : Date.now(), status: "final" };
  const old = d && d.replaces; if (old && old !== p.id) delDoc(old); // the confirmed new record replaces the old one
  if (d) { Object.assign(d, rec); delete d.issues; delete d.replaces; saveLocal(d); } else { S.docs.push(rec); saveLocal(rec); }
  void pushDoc(d || rec); rebuildIndex(); carryForward(p.title); M.pendingFinal = null;
  setStage(4, server.passcode ? "검증을 통과해 회의록 탭과 서버에 저장했습니다." : "검증을 통과해 회의록 탭에 저장했습니다.", "done");
  if (cfg.recDelete && p.speakers) void dropRecording(recKey()); // the recording has served its purpose (the speaker split stays, so names can still be fixed)
  $("minReview").hidden = true; $("minMsg").textContent = "최종 회의록으로 확정했습니다."; $("minActions").hidden = false;
}
export function showReview(issues: string[]) {
  const d = M.pendingFinal && S.docs.find((x) => x.id === M.pendingFinal.id); if (d) { d.status = "review"; d.issues = issues; d.text = recordText(M.pendingFinal); saveLocal(d); renderDocs(); }
  setStage(3, "자동 검증에서 문제가 남아 아직 확정하지 않았습니다.", "review");
  $("minReview").hidden = false; $("minIssues").textContent = ""; issues.forEach((i) => { const li = document.createElement("li"); li.textContent = i; $("minIssues").append(li); });
  $("minActions").hidden = false; $("minMsg").textContent = "검토 후 확정해 주세요.";
}
export function clearMinutesState() {
  clearSpeakers();
  M.text = ""; M.forLen = -1; M.docId = null; M.pendingFinal = null; M.stage = null; M.keyAt = ""; M.titleAuto = true;
  $("minTitle").value = ""; $("minStage").hidden = true; $("minReview").hidden = true;
  $("minOut").innerHTML = '<div class="note">\'작성\'을 누르면 지금까지 받아쓴 대화로 회의록을 만듭니다.</div>'; $("minActions").hidden = true;
}
export function initMinutesUI() {
  const upd = () => { const o = $("minModel").options; o[0].textContent = `빠르게 (${ai.model || "-"})`; o[1].textContent = `꼼꼼하게 (${ai.deepModel || ai.model || "-"})`; };
  upd(); $("minModel").addEventListener("focus", upd);
  $("minTitle").addEventListener("input", () => { M.titleAuto = false; });
  $("minutesBtn").addEventListener("click", openMinutes); $("minutesBtn2").addEventListener("click", openMinutes);
  $("minGo").addEventListener("click", makeMinutes);
  $("minAccept").addEventListener("click", finalizeRecord); $("minRedo").addEventListener("click", () => { M.keyAt = ""; void makeMinutes(); });
  $("minClose").addEventListener("click", () => { $("minSheet").hidden = true; });
  $("minCopy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(M.text); $("minMsg").textContent = "복사했습니다."; } catch { $("minMsg").textContent = "복사하지 못했습니다. 길게 눌러 선택해 주세요."; } });
  $("minSave").addEventListener("click", () => download(fileSafe($("minTitle").value) + ".md", M.text, "text/markdown"));
  $("rawSave").addEventListener("click", () => download(fileSafe($("minTitle").value) + " 받아쓰기.txt", "[교정본 · 중요 표시와 메모 포함]\n" + annotatedTranscript() + "\n\n[원문]\n" + rawJoined() + "\n", "text/plain"));
  $("minShare").addEventListener("click", async () => {
    const title = $("minTitle").value.trim() || defaultTitle();
    if ((navigator as any).share) { try { await (navigator as any).share({ title, text: M.text }); return; } catch (e: any) { if (e && e.name === "AbortError") return; } }
    try { await navigator.clipboard.writeText(M.text); $("minMsg").textContent = "공유 기능이 없어 복사했습니다."; } catch { $("minMsg").textContent = "공유하지 못했습니다."; }
  });
  let mailBusy = false;
  $("mailBtn").addEventListener("click", async () => {
    if (mailBusy || !M.text) return; mailBusy = true; $("mailBtn").disabled = true; $("mailBox").hidden = false;
    const body = $("mailBody"); body.value = "작성 중…"; $("mailSubj").value = "";
    const fill = (t: string) => { const m = t.match(/^\s*제목\s*[:：]\s*(.*)\n+([\s\S]*)$/); if (m) { $("mailSubj").value = m[1].trim(); body.value = m[2].trim(); } else body.value = t; };
    try { const t = await aiCall(mailPrompt(M.text, people()), { maxTokens: 1500, onText: fill, kind: "mail" }); fill(t); } catch (e) { body.value = errText(e); }
    mailBusy = false; $("mailBtn").disabled = false;
  });
  $("mailCopy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(($("mailSubj").value ? "제목: " + $("mailSubj").value + "\n\n" : "") + $("mailBody").value); $("minMsg").textContent = "메일 초안을 복사했습니다."; } catch { $("minMsg").textContent = "복사하지 못했습니다."; } });
  $("mailOpen").addEventListener("click", () => { const to = $("mailTo").value.split(/[,;\s]+/).filter(Boolean).join(","); location.href = `mailto:${encodeURIComponent(to).replace(/%2C/g, ",").replace(/%40/g, "@")}?subject=${encodeURIComponent($("mailSubj").value)}&body=${encodeURIComponent($("mailBody").value)}`; });
}
/** after a reload: a record that was being written is "검토 필요" */
export function markInterrupted() {
  S.docs.forEach((x) => { if (x.status === "pending" && !M.busy) { x.status = "review"; x.issues = ["작성 도중 앱이 닫혀 확정되지 않았습니다. 회의록 화면에서 '다시 작성'을 눌러 주세요."]; saveLocal(x); } });
}
