// Today's AI usage (calls, tokens, web searches) and the daily limit that switches the app to the saving pace.
import { ls } from "../storage/ls";
import { cfg, PACES, type Pace } from "../settings/settings";

export interface Usage { date: string; calls: number; inTok: number; outTok: number; cacheRead: number; cacheWrite: number; web: number; est: number; byKind: Record<string, number>; limitHit?: boolean; stt?: { calls: number; sec: number; inTok: number; outTok: number } }
const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const fresh = (): Usage => ({ date: today(), calls: 0, inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, web: 0, est: 0, byKind: {} });
let u: Usage = ls.json<Usage>("ms.usage", fresh());
const roll = () => { if (u.date !== today()) u = fresh(); };
let saveT: any = 0;
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => ls.set("ms.usage", JSON.stringify(u)), 400); };

const listeners: (() => void)[] = [];
const limitListeners: (() => void)[] = [];
export const onUsage = (f: () => void) => listeners.push(f);
/** called once when today's calls first reach the daily limit */
export const onLimit = (f: () => void) => limitListeners.push(f);

export interface CallUsage { inTok?: number; outTok?: number; cacheRead?: number; cacheWrite?: number; web?: boolean; estimated?: boolean; sec?: number }
export function recordCall(kind: string, c: CallUsage) {
  roll();
  if (kind === "stt") { // Gemini transcription: counted on its own, not against the daily AI-call limit
    const s = (u.stt ||= { calls: 0, sec: 0, inTok: 0, outTok: 0 }); s.calls++; s.sec += c.sec || 0; s.inTok += c.inTok || 0; s.outTok += c.outTok || 0;
    save(); listeners.forEach((f) => f()); return;
  }
  u.calls++; u.byKind[kind] = (u.byKind[kind] || 0) + 1;
  u.inTok += c.inTok || 0; u.outTok += c.outTok || 0; u.cacheRead += c.cacheRead || 0; u.cacheWrite += c.cacheWrite || 0;
  if (c.web) u.web++;
  if (c.estimated) u.est++;
  if (cfg.dailyLimit && u.calls >= cfg.dailyLimit && !u.limitHit) { u.limitHit = true; limitListeners.forEach((f) => f()); }
  save(); listeners.forEach((f) => f());
}
export function usage(): Usage { roll(); return u; }
export const overLimit = () => { roll(); return !!cfg.dailyLimit && u.calls >= cfg.dailyLimit; };
/** the pace actually in force: the user's choice, or "save" once the daily limit is reached */
export function effectivePace(): Pace { return overLimit() ? "save" : cfg.pace; }
export const paceParams = () => PACES[effectivePace()];
export function resetUsageForTest() { u = fresh(); save(); }
