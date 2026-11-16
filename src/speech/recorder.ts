// 회의 녹음 (for telling speakers apart): in meeting mode, with a Gemini key and the setting on, the microphone audio is
// kept as small MP3 parts (16 kHz mono, 24 kbps ≈ 11 MB per hour) in this device's IndexedDB, one recording per meeting.
// "회의록 작성" sends it to Gemini once to get a transcript by speaker; after the minutes are confirmed it is deleted
// (setting). Nothing is uploaded except for that one call. A red "● 녹음" shows while recording.
import { S } from "../state";
import { cfg } from "../settings/settings";
import { saveAudioPart, loadAudioParts, deleteAudio } from "../storage/idb";
import { sttKey } from "./cloud";

export const recWanted = () => cfg.recMeet && !!sttKey() && S.appMode === "meet" && S.running && !S.standby;
export const recKey = () => String(S.meetingStart || 0);
const R = { enc: null as any, loading: null as Promise<void> | null, key: "", parts: [] as Uint8Array[], partSec: 0, idx: 0, totalSec: 0, pcm: [] as Int16Array[], pcmLen: 0, savedAt: 0 };
export const recInfo = () => ({ key: R.key, sec: Math.round(R.totalSec), bytes: R.parts.reduce((s, p) => s + p.length, 0) });
export const RECORD = { partMs: 60000 };

async function encoder() {
  if (R.enc) return; if (!R.loading) R.loading = import("@breezystack/lamejs").then((m) => { R.enc = new m.Mp3Encoder(1, 16000, 24); });
  await R.loading;
}
/** 48 kHz (or whatever the device runs) float → 16 kHz 16-bit */
export function to16k(c: Float32Array, rate: number): Int16Array {
  const step = rate / 16000, n = Math.floor(c.length / step), out = new Int16Array(n);
  for (let i = 0; i < n; i++) { let s = 0, m = 0; for (let j = Math.floor(i * step); j < Math.min(c.length, Math.floor((i + 1) * step)); j++) { s += c[j]; m++; } const v = Math.max(-1, Math.min(1, m ? s / m : 0)); out[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
  return out;
}
/** called with every microphone chunk while capture is attached */
export function recFeed(c: Float32Array, rate: number) {
  if (!recWanted()) return;
  const key = recKey(); if (key !== R.key) { flushPart(); Object.assign(R, { key, parts: [], partSec: 0, idx: 0, totalSec: 0 }); void resumeIdx(key); }
  const pcm = to16k(c, rate); R.pcm.push(pcm); R.pcmLen += pcm.length; R.totalSec += pcm.length / 16000;
  if (!R.enc) { void encoder(); if (R.pcmLen > 16000 * 30) { R.pcm.shift(); } return; } // (encoder loads in a moment; up to 30 s is held)
  if (R.pcmLen >= 1152 * 8) encodePending();
  if (Date.now() - R.savedAt > RECORD.partMs) flushPart();
}
function encodePending() {
  if (!R.enc || !R.pcmLen) return; const all = new Int16Array(R.pcmLen); let k = 0; for (const p of R.pcm) { all.set(p, k); k += p.length; }
  const sec = R.pcmLen / 16000; R.pcm = []; R.pcmLen = 0;
  const mp3 = R.enc.encodeBuffer(all); if (mp3.length) R.parts.push(new Uint8Array(mp3.buffer, mp3.byteOffset, mp3.length).slice()); R.partSec += sec;
}
/** write what has been recorded since the last part to IndexedDB (every minute, on stop, on page hide) */
export function flushPart() {
  encodePending(); R.savedAt = Date.now(); if (!R.key || !R.parts.length) return;
  const unsaved = R.parts.splice(0); const sec = R.partSec; R.partSec = 0;
  saveAudioPart({ id: `${R.key}-${R.idx}`, key: R.key, idx: R.idx++, data: new Blob(unsaved as BlobPart[], { type: "audio/mpeg" }), sec });
}
async function resumeIdx(key: string) { const parts = await loadAudioParts(key); if (R.key === key && parts.length) { R.idx = Math.max(R.idx, parts[parts.length - 1].idx + 1); R.totalSec += parts.reduce((s, p) => s + p.sec, 0); } }
/** the whole recording of a meeting, or null */
export async function loadRecording(key = recKey()): Promise<{ blob: Blob; sec: number } | null> {
  if (key === R.key) flushPart();
  const parts = await loadAudioParts(key); if (!parts.length) return null;
  return { blob: new Blob(parts.map((p) => p.data), { type: "audio/mpeg" }), sec: parts.reduce((s, p) => s + p.sec, 0) };
}
export async function dropRecording(key = recKey()) { if (key === R.key) Object.assign(R, { parts: [], pcm: [], pcmLen: 0, partSec: 0, idx: 0, totalSec: 0 }); await deleteAudio(key); }
export function initRecorder() {
  addEventListener("pagehide", flushPart); document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushPart(); });
}
