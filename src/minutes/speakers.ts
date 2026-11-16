// 화자 구분: the meeting recording goes to Gemini once (inline when small, through the Files API when long) and comes back
// as "[MM:SS] 화자N: …" lines plus a guess of who each speaker is (from the attendee list and how people address each other).
// The names can be changed in the minutes sheet; the minutes then say who said and who took on what.
import { $, completeObjects, esc } from "../util";
import { S } from "../state";
import { cfg } from "../settings/settings";
import { recordCall } from "../ai/usage";
import { speakersPrompt, SPK_MARK } from "../ai/prompts";
import { people } from "../meeting/prep";
import { sttKey, sttHints, STT_DEFAULT_MODEL } from "../speech/cloud";
import { loadRecording, recKey } from "../speech/recorder";

const GEM = "https://generativelanguage.googleapis.com";
export const SPEAKERS = { inlineMax: 14 * 1024 * 1024 }; // larger recordings use the Files API (tests lower this)
export interface Speakers { key: string; size: number; text: string; list: { id: string; name: string; why: string }[] }
export const spk = { cur: null as Speakers | null };

const b64 = async (blob: Blob) => { const bytes = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const err = (status: number, m: string) => ({ code: status === 401 || status === 403 || /api[_ ]?key/i.test(m) ? "bad_key" : status === 429 ? "rate_limited" : "http", message: m });
/** upload through the Files API (resumable), wait until it is ready, return its uri */
async function uploadFile(blob: Blob, onStage: (t: string) => void): Promise<string> {
  const h = { "x-goog-api-key": sttKey() };
  const start = await fetch(`${GEM}/upload/v1beta/files`, { method: "POST", headers: { ...h, "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start", "X-Goog-Upload-Header-Content-Length": String(blob.size), "X-Goog-Upload-Header-Content-Type": "audio/mp3", "content-type": "application/json" }, body: JSON.stringify({ file: { display_name: "meeting" } }) });
  const url = start.headers.get("x-goog-upload-url"); if (!start.ok || !url) throw err(start.status, "녹음 업로드를 시작하지 못했습니다");
  onStage(`회의 녹음(${(blob.size / 1048576).toFixed(1)}MB)을 올리는 중`);
  const up = await fetch(url, { method: "POST", headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: blob });
  if (!up.ok) throw err(up.status, "녹음을 올리지 못했습니다"); let f = (await up.json()).file;
  for (let i = 0; i < 60 && f.state === "PROCESSING"; i++) { await new Promise((r) => setTimeout(r, 2000)); f = await (await fetch(`${GEM}/v1beta/${f.name}`, { headers: h })).json(); }
  if (f.state && f.state !== "ACTIVE") throw err(500, "녹음 처리에 실패했습니다");
  return f.uri;
}
/** Gemini's speaker-labelled transcript of this meeting's recording (cached while the recording is unchanged) */
export async function diarize(onStage: (t: string) => void): Promise<Speakers | null> {
  if (!cfg.recMeet || !sttKey()) return null;
  const key = recKey(), rec = await loadRecording(key);
  if (spk.cur && spk.cur.key === key && (!rec || spk.cur.size === rec.blob.size)) return spk.cur; // same recording (or already deleted): reuse, names as edited
  if (!rec || rec.sec < 5) return null;
  onStage(`회의 녹음 ${Math.round(rec.sec / 60)}분으로 누가 말했는지 나누는 중`);
  const audio = rec.blob.size <= SPEAKERS.inlineMax ? { inline_data: { mime_type: "audio/mp3", data: await b64(rec.blob) } } : { file_data: { mime_type: "audio/mp3", file_uri: await uploadFile(rec.blob, onStage) } };
  const model = cfg.sttModel || STT_DEFAULT_MODEL;
  const gen = { maxOutputTokens: 60000, ...(/2\.5/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : { thinkingConfig: { thinkingLevel: "low" } }) };
  const r = await fetch(`${GEM}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": sttKey() },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: speakersPrompt(people(), sttHints()) }, audio] }], generationConfig: gen }) });
  if (!r.ok) { let m = ""; try { m = (await r.json()).error?.message || ""; } catch { /* not json */ } throw err(r.status, m); }
  const raw = await r.text(); let text = "", inTok = 0, outTok = 0;
  for (const line of raw.split("\n")) { if (!line.startsWith("data:")) continue; let ev: any; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
    text += (ev.candidates?.[0]?.content?.parts || []).filter((p: any) => !p.thought && p.text).map((p: any) => p.text).join(""); if (ev.usageMetadata) { inTok = ev.usageMetadata.promptTokenCount || inTok; outTok = ev.usageMetadata.candidatesTokenCount || outTok; } }
  recordCall("stt", { inTok: inTok || Math.round(rec.sec * 32), outTok: outTok || text.length, sec: rec.sec, estimated: !inTok });
  const cut = text.indexOf(SPK_MARK); const body = (cut >= 0 ? text.slice(0, cut) : text).trim();
  const found = [...new Set((body.match(/화자\s*\d+/g) || []).map((x) => x.replace(/\s+/g, "")))];
  const guess: any[] = cut >= 0 ? (completeObjects(text.slice(cut)).find((o) => Array.isArray(o.speakers)) || { speakers: [] }).speakers : [];
  const list = found.map((id) => { const g = guess.find((x) => String(x.id).replace(/\s+/g, "") === id) || {}; return { id, name: String(g.name || "").trim(), why: String(g.why || "").trim() }; });
  if (!body) return null;
  spk.cur = { key, size: rec.blob.size, text: body, list }; return spk.cur;
}
/** the transcript with names put in for "화자N" (unnamed speakers keep their number) */
export function namedText(s: Speakers) {
  let t = s.text; for (const p of s.list) if (p.name) t = t.replace(new RegExp(p.id.replace(/(\d+)/, "\\s*$1") + "(?=\\s*:)", "g"), `${p.name}(${p.id})`);
  return t;
}
/** the editable list in the minutes sheet */
export function renderSpeakers(onRedo: () => void) {
  const box = $("minSpk"); const s = spk.cur; box.hidden = !s || !s.list.length; if (!s) return;
  box.innerHTML = `<b>화자 구분 · 녹음 기준</b><div class="hint">이름이 틀리면 고친 뒤 '이름 바꿔 다시 작성'을 누르세요. 비우면 화자 번호로 남습니다.</div>`;
  const dl = document.createElement("datalist"); dl.id = "spkNames"; people().forEach((p) => { const o = document.createElement("option"); o.value = p.replace(/\s*\(.*?\)\s*/g, " ").trim(); dl.append(o); }); box.append(dl);
  s.list.forEach((p) => {
    const row = document.createElement("label"); row.className = "spkrow"; row.innerHTML = `<span class="mono">${esc(p.id)}</span>`;
    const inp = document.createElement("input"); inp.value = p.name; inp.placeholder = "이름"; inp.setAttribute("list", "spkNames"); inp.dataset.spk = p.id;
    inp.addEventListener("change", () => { p.name = inp.value.trim(); });
    const why = document.createElement("span"); why.className = "hint"; why.textContent = p.why; row.append(inp, why); box.append(row);
  });
  const b = document.createElement("button"); b.textContent = "이름 바꿔 다시 작성"; b.addEventListener("click", onRedo); box.append(b);
}
export function clearSpeakers() { spk.cur = null; const b = $("minSpk"); if (b) b.hidden = true; }
