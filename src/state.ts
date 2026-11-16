// Shared, mutable app state. One object so every module sees the same values (ESM bindings are read-only from outside).
import { ls } from "./storage/ls";

export interface Seg { raw: string; fix: string | null; at: number; manual?: boolean; busy?: boolean; awaitCloud?: boolean; cloud?: boolean }
export interface Note { at: number; text: string }
export interface Mark { at: number; timer?: any }
export interface CardImg { src?: string; full?: string; title?: string; credit?: string; page?: string; kind?: "photo" | "diagram"; pending?: boolean; error?: string; partial?: boolean; code?: string }
export interface CardData {
  id: number; type: string; title: string; body: string; source: string; links: { t: string; u: string }[]; kw: string;
  img: CardImg | null; example?: boolean; time: string; deep?: boolean; dismissed?: boolean; bx?: number; by?: number; bpin?: boolean;
  /** an action the AI found: shown as a card, added to 할 일 only when the user taps "할 일에 추가" */
  act?: { text: string; owner: string; due: string; added?: boolean };
  /** a weekly mind map card: the archive id it opens */
  mm?: string;
}
export interface Action { id: number; text: string; owner: string; due: string; src: string; at: number; taskId?: string }
export interface Doc {
  id: string; name: string; text: string; added: number; synced?: boolean; status?: "pending" | "review" | "final"; issues?: string[]; replaces?: string | null;
  /** server time of the copy this device last sent or received; dirty = changed here since */
  updatedAt?: number; dirty?: boolean;
}
/** day logs ("day-YYYY-MM-DD-<device>") and day summaries ("sum-YYYY-MM-DD") are recognised by their id */
export const docKind = (d: { id: string }) => (d.id.startsWith("day-") ? "daylog" : d.id.startsWith("sum-") ? "daysum" : d.id.startsWith("mm-") ? "mindmap" : "doc");
export interface QA { q: string; a: string; at: number; deep?: boolean }

export const S = {
  // session
  running: false, busy: false, pending: false, standby: false, startedAt: 0, meetingStart: 0,
  appMode: (ls.get("ms.appMode") === "conv" ? "conv" : "meet") as "meet" | "conv",
  convWork: false,
  // transcript
  segs: [] as Seg[], sentUpTo: 0, curInterim: "", notes: [] as Note[], marks: [] as Mark[], focusAt: 0, markFlash: 0,
  // cards
  history: [] as CardData[], shownTitles: [] as string[], seq: 0, level: 0,
  // library
  docs: [] as Doc[],
  // Q&A
  qaLog: [] as QA[], deepRuns: 0,
  // meeting
  actions: [] as Action[], agIdx: -1, agLog: [] as { idx: number; at: number; title: string }[], agAlerted: {} as Record<string, number>, totAlert: 0,
  // misc
  lastCallAt: 0, lastUserAct: 0, visLast: 0,
};

export const segText = (s: Seg) => (s.fix != null ? s.fix : s.raw);
export const joined = () => S.segs.map(segText).filter(Boolean).join(" ");
export const rawJoined = () => S.segs.map((s) => s.raw).join(" ");
/** everyday talk in conversation mode (not work) */
export const dailyTalk = () => S.appMode === "conv" && !S.convWork;
