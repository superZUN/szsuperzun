// 하루 대화 기록: everything said (and memos, ★ marks, questions and answers) goes into one log per day and device —
// "day-YYYY-MM-DD-<device>" in the document library — whatever mode, and even after "새 회의" clears the transcript.
// The logs are searchable (questions, DEEP SCAN, recall of earlier days) and go to the server with the other documents.
import { hhmm } from "../util";
import { S, segText, type Seg, type Doc } from "../state";
import { ls } from "../storage/ls";
import { cfg } from "../settings/settings";
import { saveLocal } from "../storage/idb";
import { server } from "../storage/server";
import { indexDoc, pushDoc } from "../library/docs";
import { renderDocs } from "../library/ui";

export const deviceId = (() => { let d = ls.get("ms.deviceId"); if (!d) { d = Math.random().toString(36).slice(2, 8); ls.set("ms.deviceId", d); } return d; })();
export const dayKey = (t = Date.now()) => { const d = new Date(t), p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const tagNow = () => (S.appMode === "meet" ? "회의" : S.convWork ? "업무" : "일상");
interface Pending { seg?: Seg; text?: string; tag: string; at: number }
const pending: Pending[] = [];
let lastPush = Date.now();
export const LOG_TIMING = { flushMs: 20000, pushMs: 10 * 60000, fixWaitMs: 30000 }; // tests shorten these

/** a recognised sentence: written once its correction has arrived (or after 30 s) */
export function logSeg(seg: Seg) { if (cfg.dayLogOn) pending.push({ seg, tag: tagNow(), at: seg.at }); }
/** a memo, a ★ mark, a question and its answer … */
export function logLine(text: string, tag: string, at = Date.now()) { if (cfg.dayLogOn && text.trim()) pending.push({ text: text.trim(), tag, at }); }

export function dayDoc(day: string, create: boolean): Doc | null {
  const id = `day-${day}-${deviceId}`; let d = S.docs.find((x) => x.id === id) || null;
  if (!d && create) { d = { id, name: `${day} 대화 기록`, text: `# ${day} 대화 기록\n`, added: new Date(day + "T00:00:00").getTime() || Date.now(), dirty: true }; S.docs.push(d); }
  return d;
}
/** write what is ready into the day logs; force = everything now (page hiding, tests) */
export function flushLog(force = false) {
  const now = Date.now(); const touched = new Set<Doc>(); let i = 0;
  while (i < pending.length) {
    const p = pending[i];
    const ready = force || !p.seg || p.seg.fix != null || now - p.at > LOG_TIMING.fixWaitMs;
    if (!ready) { i++; continue; }
    pending.splice(i, 1);
    const text = p.seg ? segText(p.seg) : p.text!; if (!text.trim()) continue;
    const d = dayDoc(dayKey(p.at), true)!;
    d.text += `[${hhmm(p.at)}] (${p.tag}) ${text.replace(/\s*\n\s*/g, " / ")}\n`; d.dirty = true; touched.add(d);
  }
  touched.forEach((d) => { saveLocal(d); indexDoc(d); });
  if (touched.size) renderDocs();
  if (server.passcode && (force || now - lastPush > LOG_TIMING.pushMs)) pushLogs();
}
export function pushLogs() { lastPush = Date.now(); S.docs.filter((d) => d.dirty && d.id.startsWith("day-")).forEach((d) => void pushDoc(d)); }
export function initDayLog() {
  setInterval(() => flushLog(false), LOG_TIMING.flushMs);
  const final = () => flushLog(true);
  addEventListener("pagehide", final); document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") final(); });
}
