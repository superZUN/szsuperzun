// The microphone gauge, independent of the recogniser (getUserMedia + AnalyserNode):
//  1) shows whether the mic hears anything, and whether that is speech (voice band ≥ 45 % of the energy, 3× the adaptive
//     noise floor, for 0.4 s — hum and keyboard clicks are not speech)
//  2) speech heard but no words for 3 s → restart the recogniser (once per 8 s; after 2 useless tries, rest 2 min)
//  3) feeds the all-day sleep / wake
// It is never switched off permanently by itself; on "audio-capture" from the recogniser it steps aside for that session.
import { $ } from "../util";
import { S } from "../state";
import { cfg } from "../settings/settings";
import { ls } from "../storage/ls";
import { rs, restartRec, startRec } from "./recognizer";
import { wakeUp } from "../power/standby";

export const vad = {
  failed: false, pauseUntil: 0, ctx: null as AudioContext | null, stream: null as MediaStream | null, an: null as AnalyserNode | null, full: null as AnalyserNode | null,
  buf: null as Float32Array | null, fbuf: null as Float32Array | null, floor: 0.003, level: 0, hits: 0, speaking: false, voiceStart: 0, voiceAt: 0, timer: 0 as any, err: "",
};
export const gaugeState = { deafRestarts: 0, lastDeafFix: 0, quietSince: 0, lastGauge: 0 };
export const vadLive = () => !!vad.timer;

export async function vadStart() {
  if (!cfg.vadOn || vad.failed || vad.timer || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  const AC = (window as any).AudioContext || (window as any).webkitAudioContext; if (!AC) return;
  try {
    vad.ctx = vad.ctx || new AC(); // created inside the tap, so iPad lets it run
    vad.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (!S.running) { vadStop(); return; }
    const ctx = vad.ctx!; const src = ctx.createMediaStreamSource(vad.stream!), bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 900; bp.Q.value = 0.6; // speech band
    vad.an = ctx.createAnalyser(); vad.an.fftSize = 1024; src.connect(bp); bp.connect(vad.an); vad.buf = new Float32Array(vad.an.fftSize);
    vad.full = ctx.createAnalyser(); vad.full.fftSize = 1024; src.connect(vad.full); vad.fbuf = new Float32Array(vad.full.fftSize);
    vad.floor = 0.003; vad.timer = setInterval(vadTick, 100); vad.err = "";
  } catch (e: any) { vad.failed = true; vad.err = e && e.name === "NotAllowedError" ? "막대용 권한 없음" : "막대를 켤 수 없음"; vadStop(); }
}
export function vadStop() {
  clearInterval(vad.timer); vad.timer = 0; if (vad.stream) vad.stream.getTracks().forEach((t) => t.stop()); vad.stream = null;
  if (vad.ctx) { vad.ctx.close().catch(() => {}); vad.ctx = null; }
  vad.level = 0; vad.speaking = false; vad.hits = 0; const m = $("micMeter"); if (m) { m.className = "meter"; m.firstElementChild.style.width = "0%"; }
}
function vadTick() {
  if (!vad.an || !vad.ctx) return; if (vad.ctx.state === "suspended") vad.ctx.resume().catch(() => {});
  vad.an.getFloatTimeDomainData(vad.buf as any); let s = 0; for (let i = 0; i < vad.buf!.length; i++) s += vad.buf![i] * vad.buf![i]; const rms = Math.sqrt(s / vad.buf!.length);
  vad.floor = Math.max(0.0006, rms < vad.floor ? vad.floor * 0.85 + rms * 0.15 : vad.floor * 0.997 + rms * 0.003); vad.level = rms; // noise floor: drops fast, rises slowly
  let fs = 0; vad.full!.getFloatTimeDomainData(vad.fbuf as any); for (let i = 0; i < vad.fbuf!.length; i++) fs += vad.fbuf![i] * vad.fbuf![i]; const frms = Math.sqrt(fs / vad.fbuf!.length) || 1e-9;
  const now = Date.now(), loud = rms > Math.max(vad.floor * 3, 0.004) && rms / frms > 0.45; // most of the energy in the voice band
  if (loud) { if (++vad.hits >= 4) { if (!vad.speaking) { vad.speaking = true; vad.voiceStart = now; if (S.standby) wakeUp("voice"); } vad.voiceAt = now; rs.lastHeardAt = now; } }
  else { vad.hits = 0; if (vad.speaking && now - vad.voiceAt > 1200) vad.speaking = false; }
  // deaf recogniser: someone has been talking for 3 s and no words came
  if (vad.speaking && !S.standby && rs.wanted && S.running && now > vad.pauseUntil && now - vad.voiceStart > 3000 && now - rs.lastResultAt > 3000 && !S.curInterim && now - gaugeState.lastDeafFix > 8000) {
    gaugeState.lastDeafFix = now; gaugeState.deafRestarts++;
    if (gaugeState.deafRestarts >= 3) { gaugeState.deafRestarts = 0; vad.pauseUntil = now + 120000; return; } // two restarts did not help: noise, another language, or the browser holding the mic
    restartRec("deaf");
  }
  renderMeter();
}
/** MIC [level] state · 인식 ● state · 다시 켬 N회 */
export function renderGauge(force?: boolean) {
  const now = Date.now(); if (!force && now - gaugeState.lastGauge < 90) return; gaugeState.lastGauge = now;
  const bar = $("micBar"); bar.hidden = !S.running; if (!S.running) return;
  const ms = $("micState"), rsEl = $("recState"), dot = $("recDot");
  if (vadLive()) {
    const db = 20 * Math.log10(Math.max(vad.level, 1e-5)); if (db > -58) gaugeState.quietSince = 0; else if (!gaugeState.quietSince) gaugeState.quietSince = now;
    if (vad.speaking) { ms.textContent = "말소리"; ms.className = "mstate good"; }
    else if (gaugeState.quietSince && now - gaugeState.quietSince > 8000) { ms.textContent = "입력 없음 — 마이크 확인"; ms.className = "mstate bad"; }
    else { ms.textContent = "조용함"; ms.className = "mstate"; }
  } else { ms.textContent = vad.err || (cfg.vadOn ? "준비 중" : "막대 꺼짐"); ms.className = "mstate" + (vad.err ? " warn" : ""); }
  const deaf = vadLive() && vad.speaking && now - vad.voiceStart > 2500 && now - rs.lastResultAt > 2500 && !S.curInterim;
  if (S.standby) { rsEl.textContent = "대기 (목소리에 깨어남)"; rsEl.className = "mstate"; dot.className = "rdot"; }
  else if (!rs.wanted || !rs.rec) { rsEl.textContent = "꺼짐"; rsEl.className = "mstate bad"; dot.className = "rdot off"; }
  else if (rs.phase === "starting") { rsEl.textContent = "켜는 중…"; rsEl.className = "mstate warn"; dot.className = "rdot warn"; }
  else if (deaf) { rsEl.textContent = "소리는 들리는데 글자가 안 나옴"; rsEl.className = "mstate warn"; dot.className = "rdot warn"; }
  else { rsEl.textContent = now - rs.lastResultAt < 1200 ? "알아듣는 중" : "듣는 중"; rsEl.className = "mstate good"; dot.className = "rdot " + (now - rs.lastResultAt < 350 ? "hit" : "on"); }
  $("recCount").textContent = rs.restarts ? `다시 켬 ${rs.restarts}회` : "";
}
function renderMeter() {
  renderGauge(); const m = $("micMeter"); const db = 20 * Math.log10(Math.max(vad.level, 1e-5)), pct = Math.max(0, Math.min(100, (db + 60) * 2));
  m.firstElementChild.style.width = pct.toFixed(0) + "%";
  const deaf = vad.speaking && Date.now() - vad.voiceStart > 1500 && rs.lastResultAt < vad.voiceStart;
  m.className = "meter" + (vad.speaking ? (deaf ? " deaf" : " voice") : ""); m.title = vad.speaking ? (deaf ? "소리는 들리는데 글자가 안 나옴 — 음성 인식을 다시 켜는 중" : "말소리 감지됨") : "마이크 입력 크기";
}
export function setVadOn(on: boolean) {
  cfg.vadOn = on; $("vadOn").checked = on; ls.set("ms.vadOff", on ? "" : "1"); ls.set("ms.vadOn", on ? "1" : "");
  if (!on) vadStop(); else if (S.running) { vad.failed = false; void vadStart(); }
}
export function initGauge() {
  $("vadOn").checked = cfg.vadOn;
  $("vadOn").addEventListener("change", () => setVadOn($("vadOn").checked));
  setInterval(() => renderGauge(), 500);
  void startRec; // (imported for the type graph; the gauge never starts recognition itself)
}
