// 마이크 점검: is it the microphone, the recogniser, or the two getting in each other's way?
//  1) 5 s with only a level meter (no recogniser): does speech reach the mic, and how loud?
//  2) 6 s with only the recogniser (no meter): does it turn speech into words on its own?
// Verdicts: mic problem (almost nothing), distance (quiet), conflict (each works alone → "게이지 끄고 인식만 쓰기"),
// recogniser problem (loud enough, no words). Afterwards everything goes back as it was.
import { $, sleep } from "../util";
import { S } from "../state";
import { rs, pauseRec, startRec } from "./recognizer";
import { vadStart, vadStop, setVadOn } from "./gauge";

let busy = false;
const say = (t: string) => { $("mcStep").textContent = t; };
export interface MeterResult { ok: boolean; peak: number; voiced: number; err: string; muted?: boolean }
async function meterOnly(ms: number): Promise<MeterResult> {
  const AC = (window as any).AudioContext || (window as any).webkitAudioContext; const out: MeterResult = { ok: false, peak: -100, voiced: 0, err: "" };
  if (!AC || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { out.err = "이 브라우저는 소리 크기 측정을 지원하지 않아요"; return out; }
  let ctx: AudioContext | undefined, stream: MediaStream;
  try { ctx = new AC(); stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true } }); }
  catch (e: any) { out.err = e && e.name === "NotAllowedError" ? "마이크 권한이 없어요" : "마이크를 열 수 없어요"; try { ctx && ctx.close(); } catch { /* closed */ } return out; }
  const c = ctx!; const an = c.createAnalyser(); an.fftSize = 1024; c.createMediaStreamSource(stream).connect(an); const buf = new Float32Array(an.fftSize); let n = 0, v = 0; const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (c.state === "suspended") c.resume().catch(() => {}); an.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    const db = 20 * Math.log10(Math.max(Math.sqrt(s / buf.length), 1e-5)); out.peak = Math.max(out.peak, db); n++; if (db > -45) v++;
    $("mcLvl").style.width = Math.max(0, Math.min(100, (db + 60) * 2)).toFixed(0) + "%"; await sleep(80);
  }
  out.voiced = n ? v / n : 0; out.muted = !!(stream.getAudioTracks()[0] && stream.getAudioTracks()[0].muted);
  stream.getTracks().forEach((t) => t.stop()); c.close().catch(() => {}); $("mcLvl").style.width = "0%"; out.ok = true; return out;
}
function recogniserOnly(ms: number): Promise<{ words: string; err: string; started: boolean }> {
  return new Promise((res) => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition; const out = { words: "", err: "", started: false };
    if (!SR) { out.err = "음성 인식을 지원하지 않는 브라우저"; res(out); return; }
    const r = new SR(); r.lang = $("lang").value; r.continuous = true; r.interimResults = true; let fin = "", intr = "";
    r.onstart = () => { out.started = true; };
    r.onresult = (e: any) => { intr = ""; for (let i = e.resultIndex; i < e.results.length; i++) { const x = e.results[i]; if (x.isFinal) fin += x[0].transcript + " "; else intr += x[0].transcript; } $("mcHeard").textContent = (fin + intr).trim(); };
    r.onerror = (e: any) => { if (e.error !== "no-speech" && e.error !== "aborted") out.err = e.error; };
    let done = false; const finish = () => { if (done) return; done = true; out.words = (fin + intr).trim(); res(out); };
    const t0 = Date.now();
    r.onend = () => { if (!done && Date.now() - t0 < ms - 300) { try { r.start(); } catch { /* gone */ } } else finish(); };
    try { r.start(); } catch { out.err = "시작 실패"; finish(); return; }
    setTimeout(() => { try { r.stop(); } catch { /* gone */ } setTimeout(finish, 800); }, ms);
  });
}
/** the verdict from the two measurements (exported for tests) */
export function verdict(m: MeterResult, g: { words: string; err: string }): { text: string; fix: "" | "vadoff"; kind: string } {
  const loud = m.ok && m.peak > -35 && m.voiced > 0.12, weak = m.ok && !loud && m.peak > -50, silent = m.ok && m.peak <= -50;
  const heard = g.words.replace(/\s/g, "").length >= 4;
  if (!m.ok && !heard) return { kind: "none", fix: "", text: `마이크를 열지 못했고(${m.err}), 음성 인식도 아무것도 받지 못했어요. 마이크 권한(Safari 'ᴀA' → 웹사이트 설정 → 마이크 → 허용)과 아이패드 설정 → 일반 → 키보드 → '받아쓰기 활성화'를 확인해 주세요.` };
  if (silent && !heard) return { kind: "mic", fix: "", text: "마이크로 소리가 거의 들어오지 않아요 (가장 큰 소리 " + m.peak.toFixed(0) + " dB). 음성 인식도 아무것도 받지 못했어요. → 마이크 문제입니다. 마이크 구멍이 막혀 있지 않은지, 말하는 쪽을 향하는지 확인하고, 멀리서 말하는 회의라면 외장 마이크가 필요해요." };
  if (weak && !heard) return { kind: "distance", fix: "", text: "소리가 들어오긴 하지만 작아요 (가장 큰 소리 " + m.peak.toFixed(0) + " dB). 음성 인식이 알아듣기엔 부족해요. → 아이패드를 말하는 사람 가까이(1m 안쪽) 두거나 외장 마이크를 쓰면 좋아집니다." };
  if (heard && (loud || weak || !m.ok)) return { kind: "conflict", fix: "vadoff", text: "마이크와 음성 인식 모두 각자 따로는 잘 됩니다" + (g.words ? ` (알아들은 말: "${g.words.slice(0, 40)}")` : "") + ". 앱에서 둘을 동시에 켤 때 아이패드가 마이크를 한쪽에만 주는 것으로 보여요. → 마이크 게이지(음성 감지)를 끄면 인식이 정상으로 돌아옵니다." };
  if (loud && !heard) return { kind: "recogniser", fix: "", text: "마이크로는 소리가 충분히 들어와요 (가장 큰 소리 " + m.peak.toFixed(0) + " dB). 그런데 음성 인식이 글자로 바꾸지 못했어요" + (g.err ? ` (오류: ${g.err})` : "") + ". → 마이크 문제가 아니에요. 아이패드 설정 → 일반 → 키보드 → '받아쓰기 활성화'와 받아쓰기 언어(한국어), 인터넷 연결을 확인해 주세요. 앱의 언어가 KO인지도 확인해 주세요." };
  return { kind: "unknown", fix: "", text: "판단하기 어려웠어요. 조용한 곳에서 한 번 더 해 보세요." };
}
export const micCheckTiming = { meterMs: 5000, recMs: 6000, gapMs: 600 }; // tests shorten these
export async function micCheck() {
  if (busy) return; busy = true; const wasRunning = S.running;
  if (S.running) { pauseRec(); vadStop(); } // step out of the way: the check needs the microphone to itself
  $("mcSheet").hidden = false; $("mcResult").textContent = ""; $("mcBtns").textContent = ""; $("mcHeard").textContent = "";
  say("① 5초 동안 평소 목소리로 아무 말이나 계속 해 주세요 (마이크 소리 크기만 잽니다)");
  await sleep(micCheckTiming.gapMs); const m = await meterOnly(micCheckTiming.meterMs);
  say("② 이번엔 6초 동안 같은 문장을 다시 말해 주세요 (음성 인식만 켭니다)"); await sleep(500);
  const g = await recogniserOnly(micCheckTiming.recMs);
  const v = verdict(m, g);
  say("결과"); $("mcResult").textContent = v.text; $("mcResult").dataset.kind = v.kind;
  const btn = (t: string, f: () => void) => { const b = document.createElement("button"); b.textContent = t; b.addEventListener("click", f); $("mcBtns").append(b); };
  const restore = () => { if (wasRunning && S.running && !rs.wanted) { startRec(); void vadStart(); } };
  const close = () => { $("mcSheet").hidden = true; restore(); };
  if (v.fix === "vadoff") btn("게이지 끄고 인식만 쓰기", () => { setVadOn(false); close(); });
  btn("다시 점검", () => { $("mcSheet").hidden = true; busy = false; setTimeout(micCheck, 50); });
  btn("닫기", close);
  busy = false;
}
export function initMicCheck() {
  $("micCheckBtn").addEventListener("click", micCheck); $("micCheckBtn2").addEventListener("click", micCheck);
  $("mcClose").addEventListener("click", () => { $("mcSheet").hidden = true; if (S.running && !rs.wanted) { startRec(); void vadStart(); } });
}
