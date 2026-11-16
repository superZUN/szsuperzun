// Gemini 받아쓰기: the microphone audio (the same stream the gauge already opens) is cut into speech segments —
// only while the gauge hears speech, with a little lead-in, up to 12 s each — and sent to a cheap Gemini model as WAV.
//  - "hybrid" (Safari + Gemini 보정): Safari still shows words at once; when Gemini's text for that stretch arrives it
//    replaces Safari's sentences there (and fills stretches Safari missed entirely)
//  - "cloud" (Gemini만): Safari recognition is not used at all; words appear a few seconds after each phrase
// Silence is never sent. Three failures in a row in "cloud" mode fall back to Safari recognition until the next start.
import { $, hhmm } from "../util";
import { S, type Seg } from "../state";
import { cfg } from "../settings/settings";
import { ls } from "../storage/ls";
import { recordCall } from "../ai/usage";
import { glossary } from "../library/glossary";
import { BASE_TERMS, LIB_TERMS, shortName, GENERIC } from "../library/dict";
import { people } from "../meeting/prep";
import { vad } from "./gauge";
import { acceptCloudText, rs, startRec } from "./recognizer";
import { renderTranscript } from "../transcript";
import { recordSttDiff } from "../memory/learn";
import { recFeed, flushPart } from "./recorder";
import { ai } from "../ai/client";

export type SttMode = "safari" | "hybrid" | "cloud";
export const STT_DEFAULT_MODEL = "gemini-2.5-flash-lite";
const GEM = "https://generativelanguage.googleapis.com/v1beta";
export const sttKey = () => ls.get("ms.key.gemini");
export const cloudOn = () => cfg.sttMode !== "safari" && !!sttKey();
export const CLOUD_TIMING = { preRollMs: 600, endSilenceMs: 700, maxMs: 12000, minVoicedMs: 500 }; // tests read these

export const cloud = {
  state: "off" as "off" | "idle" | "recording" | "sending" | "error", error: "", sent: 0, failures: 0, fellBack: false,
  ctx: null as AudioContext | null, node: null as AudioNode | null, rate: 48000,
};
let pre: Float32Array[] = [], preLen = 0, cur: Float32Array[] = [], curLen = 0, recStart = 0, lastVoice = 0, voicedMs = 0;
let order = 0, nextEmit = 0; const done = new Map<number, () => void>(); let inflight = 0; const queue: { n: number; wav: Blob; t0: number; t1: number; sec: number }[] = [];

/* ---------- capture: an AudioWorklet (or ScriptProcessor) on the gauge's microphone source ---------- */
const WORKLET = `class P extends AudioWorkletProcessor{constructor(){super();this.b=[];this.n=0}process(i){const c=i[0]&&i[0][0];if(c){this.b.push(new Float32Array(c));this.n+=c.length;if(this.n>=2048){const o=new Float32Array(this.n);let k=0;for(const x of this.b){o.set(x,k);k+=x.length}this.port.postMessage(o,[o.buffer]);this.b=[];this.n=0}}return true}}registerProcessor('jay-cap',P);`;
export async function cloudAttach(ctx: AudioContext, src: AudioNode) {
  if (!(cloudOn() || cfg.recMeet && !!sttKey()) || cloud.node) return; // Gemini transcription and/or the meeting recording
  cloud.ctx = ctx; cloud.rate = ctx.sampleRate; cloud.state = "idle"; cloud.error = ""; cloud.failures = 0;
  try {
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })));
    const node = new AudioWorkletNode(ctx, "jay-cap"); node.port.onmessage = (e) => onChunk(e.data as Float32Array);
    const sink = ctx.createGain(); sink.gain.value = 0; src.connect(node); node.connect(sink); sink.connect(ctx.destination); cloud.node = node;
  } catch {
    const sp = ctx.createScriptProcessor(2048, 1, 1); sp.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
    const sink = ctx.createGain(); sink.gain.value = 0; src.connect(sp); sp.connect(sink); sink.connect(ctx.destination); cloud.node = sp;
  }
}
export function cloudDetach() {
  flushPart(); if (curLen) finish(); try { cloud.node && cloud.node.disconnect(); } catch { /* gone */ }
  cloud.node = null; cloud.ctx = null; pre = []; preLen = 0; cur = []; curLen = 0; if (cloud.state !== "error") cloud.state = "off";
}
function onChunk(c: Float32Array) {
  recFeed(c, cloud.rate);
  if (!cloudOn()) return;
  if (!S.running || S.standby) { pre = []; preLen = 0; return; }
  const now = Date.now(), ms = (c.length / cloud.rate) * 1000;
  // the gauge's last moment of actual speech (its "speaking" flag lingers 1.2 s, too long to find the end of a phrase)
  const voiceNow = vad.speaking && now - vad.voiceAt < 250; if (voiceNow) { lastVoice = now; if (curLen) voicedMs += ms; }
  if (!curLen) {
    pre.push(c); preLen += c.length; while (preLen - pre[0].length > (cloud.rate * CLOUD_TIMING.preRollMs) / 1000) preLen -= pre.shift()!.length;
    if (voiceNow) { cur = pre; curLen = preLen; pre = []; preLen = 0; recStart = now - (curLen / cloud.rate) * 1000; voicedMs = ms; cloud.state = "recording"; }
    return;
  }
  cur.push(c); curLen += c.length;
  if (now - lastVoice > CLOUD_TIMING.endSilenceMs || (curLen / cloud.rate) * 1000 > CLOUD_TIMING.maxMs) finish();
}
function finish() {
  const chunks = cur, len = curLen, t0 = recStart, t1 = Date.now(), voiced = voicedMs; cur = []; curLen = 0; voicedMs = 0;
  cloud.state = inflight ? "sending" : "idle";
  if (voiced < CLOUD_TIMING.minVoicedMs || !len) return; // a click or a cough: not worth a call
  queue.push({ n: order++, wav: toWav(chunks, len, cloud.rate), t0, t1, sec: len / cloud.rate }); pump();
}
/** 16 kHz mono 16-bit WAV */
export function toWav(chunks: Float32Array[], len: number, rate: number): Blob {
  const all = new Float32Array(len); let k = 0; for (const c of chunks) { all.set(c, k); k += c.length; }
  const out = 16000, step = rate / out, n = Math.floor(len / step), pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) { let s = 0, m = 0; for (let j = Math.floor(i * step); j < Math.min(len, Math.floor((i + 1) * step)); j++) { s += all[j]; m++; } const v = Math.max(-1, Math.min(1, m ? s / m : 0)); pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
  const buf = new ArrayBuffer(44 + pcm.byteLength), d = new DataView(buf); const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) d.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); d.setUint32(4, 36 + pcm.byteLength, true); w(8, "WAVE"); w(12, "fmt "); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
  d.setUint32(24, out, true); d.setUint32(28, out * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); w(36, "data"); d.setUint32(40, pcm.byteLength, true); new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}

/* ---------- sending ---------- */
/** names and terms Gemini should spell the way the user's glossary does */
export function sttHints() {
  const out = new Set<string>(); people().forEach((p) => { const n = p.split(/[\s(]/)[0]; if (n.length >= 2) out.add(n); });
  (glossary.text || "").split("\n").forEach((l) => { const w = l.split(/[=·:]/)[0].trim(); if (w.length >= 2 && w.length <= 30) out.add(w); });
  for (const arr of [BASE_TERMS, LIB_TERMS]) for (const x of arr) { if (out.size >= 80) break; const k = shortName(x); if (k.length >= 2 && !GENERIC.has(x.t)) out.add(k); }
  return [...out].slice(0, 80);
}
export const sttPrompt = (before: string) => `이 오디오에서 들리는 말을 그대로 받아쓰세요.
- 한국어와 영어가 섞여 있으면 들린 언어 그대로 적으세요. 영어 단어·약어는 영어 철자로(예: Formation, SEI, OCV).
- 아래 [용어]에 있는 이름·전문 용어는 그 표기를 따르세요. 숫자·단위는 아라비아 숫자로(예: 96.5%, 3호기).
- 요약·번역·설명·따옴표 없이 받아쓴 문장만 출력. 말이 없거나 알아들을 수 없으면 아무것도 출력하지 마세요.
[용어] ${sttHints().join(", ")}
[바로 앞 문맥 — 받아쓰지 말 것] ${before || "(없음)"}`;
const b64 = async (blob: Blob) => { const bytes = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
async function transcribe(wav: Blob): Promise<{ text: string; inTok: number; outTok: number }> {
  const model = cfg.sttModel || STT_DEFAULT_MODEL; const before = S.segs.slice(-3).map((s) => s.fix ?? s.raw).join(" ").slice(-200);
  const thinking = /2\.5/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : { thinkingConfig: { thinkingLevel: "low" } };
  const body = (extra: any) => JSON.stringify({ contents: [{ role: "user", parts: [{ text: sttPrompt(before) }, { inline_data: { mime_type: "audio/wav", data: "" } }] }], generationConfig: { maxOutputTokens: 1024, ...extra } });
  const data = await b64(wav);
  const send = async (extra: any) => fetch(`${GEM}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": sttKey() }, body: body(extra).replace('"data":""', `"data":"${data}"`) });
  let r: Response; try { r = await send(thinking); if (r.status === 400 && /thinking/i.test(await r.clone().text())) r = await send({}); } catch { throw { code: "network" }; }
  if (!r.ok) { let m = ""; try { m = (await r.json()).error?.message || ""; } catch { /* not json */ } throw { code: r.status === 401 || r.status === 403 || /api[_ ]?key/i.test(m) ? "bad_key" : r.status === 429 ? "rate_limited" : r.status === 404 || /model/i.test(m) ? "bad_model" : "http", message: m }; }
  const txt = await r.text(); let text = "", inTok = 0, outTok = 0;
  for (const line of txt.split("\n")) {
    if (!line.startsWith("data:")) continue; let ev: any; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
    const parts = ev.candidates?.[0]?.content?.parts || []; text += parts.filter((p: any) => !p.thought && p.text).map((p: any) => p.text).join("");
    if (ev.usageMetadata) { inTok = ev.usageMetadata.promptTokenCount || inTok; outTok = ev.usageMetadata.candidatesTokenCount || outTok; }
  }
  return { text: text.replace(/^["'“”]+|["'“”]+$/g, "").trim(), inTok, outTok };
}
function sttErr(e: any) {
  const c = e && e.code;
  if (c === "bad_key") return "Gemini 키가 맞지 않아요. 설정 → Audio의 'Gemini API 키'를 확인해 주세요.";
  if (c === "bad_model") return `받아쓰기 모델 '${cfg.sttModel || STT_DEFAULT_MODEL}'을 찾을 수 없어요.`;
  if (c === "rate_limited") return "Gemini 요청이 많아 잠시 쉬어요(무료 등급 한도일 수 있어요).";
  if (c === "network") return "Gemini에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.";
  return "Gemini 받아쓰기 오류" + (e && e.message ? ": " + e.message : "");
}
function pump() {
  while (inflight < 2 && queue.length) {
    const job = queue.shift()!; inflight++; cloud.state = "sending";
    transcribe(job.wav).then((res) => {
      cloud.failures = 0; cloud.error = ""; cloud.sent++;
      recordCall("stt", { inTok: res.inTok || Math.round(job.sec * 32) + 300, outTok: res.outTok || res.text.length, sec: job.sec, estimated: !res.inTok });
      done.set(job.n, () => apply(res.text, job.t0, job.t1));
    }).catch((e) => {
      cloud.failures++; cloud.error = sttErr(e); done.set(job.n, () => {}); $("aiNote").className = "hint warn"; $("aiNote").textContent = cloud.error;
      if (cfg.sttMode === "cloud" && cloud.failures >= 3 && !cloud.fellBack && S.running) { cloud.fellBack = true; $("aiNote").textContent = cloud.error + " Safari 음성 인식으로 바꿔 계속 들어요."; startRec(); }
    }).finally(() => {
      inflight--; while (done.has(nextEmit)) { const f = done.get(nextEmit)!; done.delete(nextEmit); nextEmit++; f(); } // results land in the order they were said
      cloud.state = inflight || queue.length ? "sending" : curLen ? "recording" : "idle"; pump();
    });
  }
}

/* ---------- putting Gemini's text into the transcript ---------- */
function apply(text: string, t0: number, t1: number) {
  if (cfg.sttMode === "cloud" && !cloud.fellBack) { if (text) acceptCloudText(text, t0, null); return; }
  // hybrid: Safari's sentences said in this stretch are replaced by Gemini's (more accurate) text
  const inside = S.segs.filter((s) => s.awaitCloud && s.at >= t0 - 500 && s.at <= t1 + 1800);
  if (!text) { inside.forEach((s) => { s.awaitCloud = false; if (s.fix == null) s.fix = s.raw; }); renderTranscript(); return; }
  if (!inside.length) { acceptCloudText(text, t0, null); return; } // Safari missed this stretch: Gemini restores it
  void recordSttDiff(inside.map((s) => s.raw).join(" "), text);
  inside.forEach((s, i) => { s.awaitCloud = false; s.cloud = true; s.fix = i === 0 ? text : ""; });
  acceptCloudText(text, t0, inside[0]);
}
/** a Safari sentence in hybrid mode that Gemini never covered (silence detection missed it) keeps its own text */
export function settleStale() { const now = Date.now(); let ch = false; S.segs.forEach((s: Seg) => { if (s.awaitCloud && now - s.at > 25000) { s.awaitCloud = false; if (s.fix == null) s.fix = s.raw; ch = true; } }); if (ch) renderTranscript(); }
export const cloudLabel = () => {
  if (!cloudOn()) return ""; if (cloud.error && cloud.failures) return "Gemini 오류";
  return { off: "Gemini 대기", idle: "Gemini 대기", recording: "Gemini 듣는 중", sending: "Gemini 받아쓰는 중", error: "Gemini 오류" }[cloud.state];
};
export async function testSttKey(): Promise<string> {
  if (!sttKey()) return "Gemini API 키를 넣어 주세요.";
  try { const r = await fetch(`${GEM}/models/${encodeURIComponent(cfg.sttModel || STT_DEFAULT_MODEL)}`, { headers: { "x-goog-api-key": sttKey() } }); if (r.ok) return `연결 성공 · ${cfg.sttModel || STT_DEFAULT_MODEL}`; return sttErr({ code: r.status === 404 ? "bad_model" : r.status === 400 || r.status === 401 || r.status === 403 ? "bad_key" : "http" }); }
  catch { return sttErr({ code: "network" }); }
}
export function initCloud() {
  setInterval(settleStale, 5000);
  $("sttKey").addEventListener("change", () => { if (ai.provider === "gemini") ai.apiKey = sttKey(); }); // one Gemini key for both uses
}
export function resetCloud() { cloud.fellBack = false; cloud.failures = 0; cloud.error = ""; cloud.sent = 0; order = 0; nextEmit = 0; done.clear(); queue.length = 0; }
export { hhmm, rs };
