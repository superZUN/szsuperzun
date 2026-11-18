// 작은 목소리 → Gemini 자동 (toggle in the MIC bar, needs a Gemini key):
//  • the gauge hears someone talking (4 s of voice) but Safari has turned nothing into words for 6 s → Gemini takes over
//    (Safari off, the gauge's microphone feeds Gemini; quiet WAVs are boosted before sending)
//  • while on Gemini, speech that gets clearly louder (≥ 8 dB over the quiet level, or loud outright) for 2 s of the
//    last 4 s → back to the mode chosen in 설정, after at least 15 s (longer if it keeps flipping)
//  • iPad, where Safari holds the microphone and the gauge hears nothing: after 30 s without words Jay listens with the
//    gauge for 8 s; speech there → stays on Gemini, silence → back to Safari (waiting twice as long before the next look)
// The switch only changes the mode in memory; the mode saved in 설정 is never touched.
import { $ } from "../util";
import { S } from "../state";
import { cfg } from "../settings/settings";
import { ls } from "../storage/ls";
import { rs, pauseRec, startRec } from "./recognizer";
import { vad, vadStart, vadStop, vadLive, gaugeState, renderGauge } from "./gauge";
import { cloud, sttKey, resetCloud, cloudAttach } from "./cloud";

type Mode = "safari" | "hybrid" | "cloud";
export const QUIET = { triggerVoiceMs: 4000, triggerSilentMs: 6000, minStayMs: 15000, loudGainDb: 8, loudDb: -36, loudWindowMs: 4000, loudVoiceMs: 2000, probeMs: 8000, probeGapMs: 30000 }; // tests shorten these
export const quiet = {
  on: ls.get("ms.quietAuto") === "1", active: false, probe: false, from: "safari" as Mode, since: 0, quietDb: -60,
  voicedMs: 0, dbSum: 0, dbN: 0, seenResult: 0, conflict: false, probeAt: 0, probeGap: 0, stay: 0, lastLeft: 0, switches: 0,
  recent: [] as { at: number; db: number; ms: number }[], lastTick: 0,
};
const levelDb = () => 20 * Math.log10(Math.max(vad.level, 1e-5));
const voiceNow = (now: number) => vad.speaking && now - vad.voiceAt < 250;
function note(t: string) { const n = $("aiNote"); if (n) { n.className = "hint"; n.textContent = t; } }

function enter(probe: boolean) {
  const now = Date.now(); quiet.active = true; quiet.probe = probe; quiet.from = cfg.sttMode as Mode; quiet.since = now; quiet.recent = []; quiet.switches++;
  quiet.quietDb = quiet.dbN ? quiet.dbSum / quiet.dbN : -60;
  quiet.stay = now - quiet.lastLeft < 120000 ? Math.min(quiet.stay * 2 || QUIET.minStayMs, 5 * 60000) : QUIET.minStayMs; // flipping back and forth: stay longer
  cfg.sttMode = "cloud"; pauseRec(); resetCloud();
  if (vadLive() && vad.ctx && vad.src && !quiet.conflict) void cloudAttach(vad.ctx, vad.src); // the gauge hears fine: Gemini joins its microphone
  else { vadStop(); vad.failed = false; void vadStart(true); } // the gauge was shut out (iPad): open the microphone again now that Safari let go
  renderGauge(true); render();
  if (!probe) note("목소리가 작아 Safari가 알아듣지 못해서 Gemini로 받아쓰고 있어요. 목소리가 커지면 원래대로 돌아갑니다.");
}
function leave(why: "loud" | "probe" | "stop" | "fail") {
  if (!quiet.active) return; quiet.active = false; quiet.probe = false; quiet.lastLeft = Date.now(); cfg.sttMode = quiet.from;
  quiet.voicedMs = 0; quiet.dbSum = 0; quiet.dbN = 0; quiet.seenResult = rs.lastResultAt;
  if (why !== "stop" && S.running) { startRec(); renderGauge(true); }
  if (why === "loud") note("목소리가 커져서 원래 받아쓰기로 돌아왔어요.");
  render();
}
/** every 200 ms while listening */
export function quietTick(now = Date.now()) {
  const dt = quiet.lastTick ? Math.min(500, now - quiet.lastTick) : 200; quiet.lastTick = now;
  if (!S.running) { if (quiet.active) leave("stop"); return; }
  if (quiet.active && cfg.sttMode !== "cloud") { quiet.active = false; quiet.probe = false; render(); return; } // the user picked another mode in 설정
  if (!quiet.on || !sttKey() || S.standby) { if (quiet.active) leave("stop"); return; }
  if (!quiet.active) {
    if (cfg.sttMode === "cloud" || !rs.wanted) return; // already Gemini only, or Safari is off for another reason
    if (rs.lastResultAt !== quiet.seenResult) { quiet.seenResult = rs.lastResultAt; quiet.voicedMs = 0; quiet.dbSum = 0; quiet.dbN = 0; quiet.probeGap = 0; }
    if (voiceNow(now)) { quiet.voicedMs += dt; quiet.dbSum += levelDb(); quiet.dbN++; }
    const silentFor = now - Math.max(rs.lastResultAt, quiet.lastLeft, S.startedAt);
    if (quiet.voicedMs >= QUIET.triggerVoiceMs && silentFor > QUIET.triggerSilentMs && !S.curInterim) { enter(false); return; }
    // iPad: Safari makes words while the gauge stays empty → the gauge cannot hear for itself
    if (vadLive() && gaugeState.quietSince && now - gaugeState.quietSince > 12000 && now - rs.lastResultAt < 8000) quiet.conflict = true;
    if (quiet.conflict && silentFor > (quiet.probeGap || QUIET.probeGapMs) && now > quiet.probeAt && !S.curInterim) { quiet.voicedMs = 0; quiet.dbSum = 0; quiet.dbN = 0; enter(true); }
    return;
  }
  if (cloud.fellBack) { leave("fail"); return; } // Gemini kept failing: Safari is back already
  const v = voiceNow(now); if (v) quiet.recent.push({ at: now, db: levelDb(), ms: dt });
  quiet.recent = quiet.recent.filter((x) => now - x.at <= QUIET.loudWindowMs);
  if (quiet.probe) {
    if (v) { quiet.voicedMs += dt; quiet.dbSum += levelDb(); quiet.dbN++; }
    if (quiet.voicedMs >= 1500) { quiet.probe = false; quiet.quietDb = quiet.dbSum / quiet.dbN; quiet.since = now; note("목소리가 작아 Safari가 알아듣지 못해서 Gemini로 받아쓰고 있어요. 목소리가 커지면 원래대로 돌아갑니다."); render(); return; }
    if (now - quiet.since > QUIET.probeMs) { quiet.probeGap = Math.min((quiet.probeGap || QUIET.probeGapMs) * 2, 8 * 60000); quiet.probeAt = now + quiet.probeGap; leave("probe"); }
    return;
  }
  if (now - quiet.since < quiet.stay) return;
  const voicedMs = quiet.recent.reduce((s, x) => s + x.ms, 0);
  if (voicedMs < QUIET.loudVoiceMs) return;
  const avg = quiet.recent.reduce((s, x) => s + x.db, 0) / quiet.recent.length;
  if (avg >= Math.min(quiet.quietDb + QUIET.loudGainDb, QUIET.loudDb)) leave("loud");
}
/** the session stops: give the mode back at once */
export function quietStop() { leave("stop"); }
export const quietActive = () => quiet.active && !quiet.probe;
export function render() {
  const b = $("quietBtn"); if (!b) return;
  b.setAttribute("aria-pressed", String(quiet.on)); b.classList.toggle("on", quiet.on); b.classList.toggle("act", quiet.active && !quiet.probe);
  b.textContent = quiet.active && !quiet.probe ? "작은 목소리 · Gemini 중" : "작은 목소리 → Gemini";
  const c = $("quietAuto"); if (c) c.checked = quiet.on;
  b.title = quiet.on ? "켜짐: 소리는 들리는데 Safari가 알아듣지 못하면 Gemini로 바꾸고, 목소리가 커지면 돌아옵니다" : "꺼짐: 누르면 작은 목소리일 때 Gemini로 자동 전환";
}
export function setQuiet(on: boolean) {
  if (on && !sttKey()) { note("이 기능은 Gemini 키가 필요해요. 설정 → Audio에서 Gemini API 키를 넣어 주세요."); return; }
  quiet.on = on; ls.set("ms.quietAuto", on ? "1" : "");
  if (!on && quiet.active) { leave("stop"); if (S.running) { startRec(); renderGauge(true); } }
  render();
}
export function initQuiet() {
  $("quietBtn").addEventListener("click", () => setQuiet(!quiet.on));
  $("quietAuto").addEventListener("change", () => { setQuiet($("quietAuto").checked); render(); });
  setInterval(() => quietTick(), 200); render();
}
