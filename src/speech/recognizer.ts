// Live speech-to-text (Web Speech API), designed around iPad Safari:
//  - restart only when the browser really ended the session (each new start can show "마이크 액세스 허용됨" and clip speech);
//    no periodic "refresh" restarts (changed from legacy, which restarted Safari every 45 s)
//  - a recogniser that went silent (30 s, or 12 s while the meter hears speech) is replaced
//  - a sentence that stopped changing for 2 s is taken as said, without restarting; repeats are removed afterwards
//  - "not-allowed" in the middle of a session is retried (3×, 1.2 s apart); slow starts (= asking for permission each time) show a hint
import { $, IOS, simText } from "../util";
import { S, dailyTalk, type Seg, segText } from "../state";
import { cfg } from "../settings/settings";
import { ls } from "../storage/ls";
import { glossary } from "../library/glossary";
import { dictHits, shortName, BASE_TERMS, LIB_TERMS, GENERIC } from "../library/dict";
import { people } from "../meeting/prep";
import { wake } from "../hud/field";
import { addUtterance } from "../transcript";
import { updateTopic } from "../analysis/topic";
import { voiceVisual } from "../qa/visual";
import { instantScan, instantScanSoon } from "../analysis/keywords";
import { scheduleAnalyze } from "../analysis/analyze";
import { vad, vadLive, vadStop } from "./gauge";
import { wakeUp } from "../power/standby";
import { renderGauge, gaugeState } from "./gauge";

const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
export const speechSupported = () => !!SR;
export const rs = {
  rec: null as any, wanted: false, restarts: 0, phase: "off" as "off" | "starting" | "on",
  alive: 0, born: 0, lastResultAt: 0, lastHeardAt: Date.now(), lastErr: "",
};
let restartTimer: any = null, lastFinal = "", capTimer: any = null;
let interimSince = 0, interimSeen = "", committed = "", rawInterim = "", lastHeardText = "", lastHeardTextAt = 0;
let everHeard = false, permRetries = 0, slowStarts = 0, phrasesOk = true;

/* ---------- the live caption line ---------- */
function showInterim(t: string) {
  const cap = $("live"); clearTimeout(capTimer); $("ticker").classList.toggle("on", rs.wanted);
  if (t) { cap.classList.remove("idle"); cap.textContent = t; return; }
  if (lastFinal && rs.wanted) { cap.classList.remove("idle"); cap.textContent = lastFinal; capTimer = setTimeout(() => { lastFinal = ""; showInterim(""); }, 4000); return; }
  cap.classList.add("idle"); cap.textContent = rs.wanted ? "LISTENING…" : "STANDBY";
}
export const live = {
  show: showInterim,
  /** the last sentence was corrected: show the corrected text in the caption */
  showFixed(seg: Seg) { if (lastFinal && !$("live").classList.contains("idle") && lastFinal === seg.raw) { lastFinal = segText(seg); $("live").textContent = lastFinal; } },
};

function appendFinal(t: string) { lastFinal = t; S.curInterim = ""; updateTopic(t); addUtterance(t); voiceVisual(t); instantScan(t); scheduleAnalyze(); }
/** the full text the recogniser has said in this run of speech (what it may repeat next time) */
const rawFinalBase = (f: string) => ((lastHeardText && Date.now() - lastHeardTextAt < 20000 ? lastHeardText + " " : "") + f).slice(-400);

/* ---------- alternatives & hints ---------- */
function vocabScore(t: string) {
  const c = t.toLowerCase(); let n = 0;
  dictHits(c).forEach((x) => { n += 2; if (c.includes(shortName(x).toLowerCase())) n += 1; }); // the written form beats a spelled-out pronunciation
  people().forEach((p) => { const nm = p.split(/[\s(]/)[0]; if (nm && nm.length >= 2 && t.includes(nm)) n += 2; });
  (glossary.text || "").split("\n").forEach((l) => { const w = l.split(/[=·:]/)[0].trim(); if (w.length >= 2 && c.includes(w.toLowerCase())) n += 1; });
  return n;
}
/** in work talk, prefer the alternative that contains known terms / names */
export function bestAlt(res: any): string {
  if (res.length < 2 || dailyTalk()) return res[0].transcript; let best = res[0].transcript, bs = vocabScore(best) + 0.5;
  for (let k = 1; k < res.length; k++) { const t = res[k].transcript, sc = vocabScore(t); if (sc > bs) { bs = sc; best = t; } }
  return best;
}
/** Chrome contextual biasing: attendee names, own glossary words, dictionary terms (120 at most) */
export function hintPhrases() {
  const out = new Set<string>(); people().forEach((p) => { const nm = p.split(/[\s(]/)[0]; if (nm.length >= 2) out.add(nm); });
  (glossary.text || "").split("\n").forEach((l) => { const w = l.split(/[=·:]/)[0].trim(); if (w.length >= 2 && w.length <= 30) out.add(w); });
  for (const arr of [BASE_TERMS, LIB_TERMS]) for (const x of arr) { if (out.size >= 120) break; const k = shortName(x); if (k.length >= 2 && !GENERIC.has(x.t)) out.add(k); }
  return [...out].slice(0, 120);
}

/* ---------- the recogniser ---------- */
function makeRec() {
  const r = new SR(); r.continuous = true; r.interimResults = true; r.maxAlternatives = 3; r.lang = $("lang").value;
  const W = window as any;
  if (phrasesOk && !dailyTalk() && "phrases" in r && W.SpeechRecognitionPhrase) { try { r.phrases = hintPhrases().map((p) => new W.SpeechRecognitionPhrase(p, 3)); } catch { phrasesOk = false; } }
  const touch = () => { rs.alive = Date.now(); };
  r.onstart = () => {
    rs.lastErr = ""; touch(); rs.born = Date.now(); everHeard = true; if (r === rs.rec) { rs.phase = "on"; renderGauge(true); }
    if (r._askedAt && Date.now() - r._askedAt > 1500 && ++slowStarts >= 2) showMicHint(false);
  };
  r.onaudiostart = touch; r.onsoundstart = touch; r.onspeechstart = touch;
  r.onresult = (e: any) => {
    if (r !== rs.rec) return; touch(); permRetries = 0; rs.phase = "on"; rs.lastResultAt = Date.now(); rs.lastHeardAt = rs.lastResultAt; gaugeState.deafRestarts = 0;
    setTimeout(() => renderGauge(true), 0); if (S.standby) wakeUp("speech");
    let interim = "", finals = "";
    for (let i = e.resultIndex; i < e.results.length; i++) { const x = e.results[i]; if (x.isFinal) finals += bestAlt(x); else interim += x[0].transcript; }
    S.level = Math.min(1, S.level + 0.45); wake(1);
    finals = finals.trim();
    if (finals && committed) { // part of this sentence was already taken while the recogniser sat on it
      if (finals === committed || committed.startsWith(finals)) finals = "";
      else if (finals.startsWith(committed)) finals = finals.slice(committed.length).trim();
      else if (finals.length <= committed.length * 1.25 && simText(finals, committed) >= 0.7) finals = "";
      else if (simText(finals.slice(0, committed.length), committed) >= 0.7) finals = finals.slice(committed.length).trim();
    }
    // some recognisers send the previous sentence again at the start of the next one: keep only what is new
    if (finals && lastHeardText && Date.now() - lastHeardTextAt < 20000) {
      const pv = lastHeardText; if (finals === pv || pv.endsWith(finals)) finals = ""; else if (finals.startsWith(pv)) finals = finals.slice(pv.length).trim();
    }
    if (finals || (!interim.trim() && committed)) committed = "";
    if (finals) { appendFinal(finals); lastHeardText = rawFinalBase(finals); lastHeardTextAt = Date.now(); }
    let it = interim.trim(); rawInterim = it;
    if (committed) { if (it.startsWith(committed)) it = it.slice(committed.length).trim(); else if (committed.startsWith(it)) it = ""; }
    S.curInterim = it; showInterim(S.curInterim);
    if (S.curInterim !== interimSeen) { interimSeen = S.curInterim; interimSince = Date.now(); }
    if (S.curInterim) { voiceVisual(S.curInterim); instantScanSoon(S.curInterim); scheduleAnalyze(true); } // react while the sentence is being spoken
  };
  r.onerror = (e: any) => {
    if (r !== rs.rec) return; rs.lastErr = e.error;
    // errors after which a fresh recogniser follows: detach this one first, so its own "end" does not also restart it
    const replaceLater = (ms: number, why: string) => { rs.rec = null; try { r.abort(); } catch { /* gone */ } setTimeout(() => restartRec(why), ms); };
    if (e.error === "phrases-not-supported") { phrasesOk = false; replaceLater(50, "no-phrases"); return; }
    if ((e.error === "not-allowed" || e.error === "service-not-allowed") && everHeard && permRetries < 3) { permRetries++; showMicHint(true); replaceLater(1200, "perm-retry"); return; }
    if (e.error === "not-allowed" || e.error === "service-not-allowed") micFail(location.protocol === "https:" || location.hostname === "localhost" ? "마이크 사용이 막혀 있어요. 주소창 왼쪽 아이콘(사이트 설정)에서 마이크를 '허용'으로 바꾼 뒤 다시 '시작'을 눌러 주세요." : "마이크는 https 주소에서만 작동해요. Netlify 등에 올린 주소로 열어 주세요.");
    else if (e.error === "audio-capture") { if (vadLive()) { vad.failed = true; vadStop(); vad.err = "막대 끔 (마이크를 인식에 양보)"; replaceLater(200, "mic-conflict"); return; } micFail("마이크를 찾지 못했어요. 마이크 연결을 확인해 주세요."); }
    else if (e.error === "network") { $("aiNote").textContent = "음성 인식 서버 연결이 끊겨 다시 연결하는 중…"; }
  };
  r.onend = () => {
    if (r !== rs.rec) return; if (!(rs.wanted && S.running)) { showInterim(""); return; }
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => { // same instance first; a fresh one only if that fails
      if (!(rs.wanted && S.running) || r !== rs.rec) return;
      try { r.lang = $("lang").value; r._askedAt = Date.now(); rs.phase = "starting"; rs.restarts++; r.start(); } catch { restartRec("reuse-failed"); }
    }, rs.lastErr === "network" ? 1500 : 60);
  };
  return r;
}
let onMicFail: (msg: string) => void = () => {};
export const setMicFailHandler = (f: (msg: string) => void) => { onMicFail = f; };
function micFail(msg: string) { rs.wanted = false; $("aiNote").className = "hint warn"; $("aiNote").textContent = msg; onMicFail(msg); }
function showMicHint(refused: boolean) {
  if (cfg.micHintOff && !refused) return;
  $("micHintMsg").textContent = (refused ? "마이크 허용이 끊겨 다시 켜는 중이에요. " : "마이크 허용을 자꾸 묻고 있어요. ") + (IOS ? "Safari 주소창 왼쪽 'ᴀA' 아이콘 → 웹사이트 설정 → 마이크 → '허용'으로 바꾸면 다시 묻지 않습니다." : "주소창 왼쪽 자물쇠(사이트 정보) → 마이크 → '허용'으로 바꾸면 다시 묻지 않습니다.");
  $("micHint").hidden = false;
}
/** throw the old recogniser away and start a fresh one */
export function restartRec(_why: string) {
  if (!(rs.wanted && S.running)) return; const old = rs.rec; rs.rec = null;
  if (old) { try { old.abort(); } catch { /* gone */ } }
  rs.rec = makeRec(); rs.restarts++; rs.phase = "starting"; rs.alive = Date.now(); rs.rec._askedAt = Date.now();
  try { rs.rec.start(); } catch { setTimeout(() => { if (rs.wanted && S.running) restartRec("start-failed"); }, 700); }
}
export function startRec() {
  if (!SR) return false; rs.wanted = true; committed = ""; interimSeen = ""; permRetries = 0;
  everHeard = false; rs.restarts = 0; rs.phase = "starting"; rs.rec = makeRec(); rs.alive = Date.now(); rs.rec._askedAt = Date.now();
  try { rs.rec.start(); } catch { /* already started */ }
  showInterim(""); return true;
}
/** switch the recogniser off (standby with the meter, mic check) without stopping the session */
export function pauseRec() { rs.wanted = false; clearTimeout(restartTimer); if (rs.rec) { const r = rs.rec; rs.rec = null; try { r.abort(); } catch { /* gone */ } } }
export function stopRec() { rs.wanted = false; clearTimeout(restartTimer); if (rs.rec) { try { rs.rec.stop(); } catch { /* gone */ } } lastFinal = ""; showInterim(""); rs.phase = "off"; }

/** watchdog, once a second */
function watchdog() {
  if (!(rs.wanted && S.running && rs.rec)) return; const now = Date.now();
  // a sentence that has stopped changing for 2 s is taken as said — without restarting, so nothing that follows is lost
  if (S.curInterim && S.curInterim === interimSeen && now - interimSince > 2000) {
    const t = S.curInterim; S.curInterim = ""; interimSeen = ""; committed = rawInterim || t; appendFinal(t); lastHeardText = rawFinalBase(t); lastHeardTextAt = Date.now(); showInterim(""); return;
  }
  // nothing at all from the recogniser: it has quietly died
  if (vadLive() ? vad.speaking && now - rs.alive > 12000 : now - rs.alive > 30000) restartRec("silent");
}
export function initRecognizer() {
  setInterval(watchdog, 1000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && rs.wanted && S.running) setTimeout(() => restartRec("resume"), 300); });
  $("micHintClose").addEventListener("click", () => { $("micHint").hidden = true; cfg.micHintOff = true; ls.set("ms.micHintOff", "1"); });
  $("lang").addEventListener("change", () => { if (rs.rec && rs.wanted) { try { rs.rec.stop(); } catch { /* gone */ } } });
  showInterim("");
}
