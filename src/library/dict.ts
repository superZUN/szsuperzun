// Built-in dictionaries (Formation·EOL 76 terms, lithium-ion 235 terms) and the user glossary text,
// matched locally against what is said, and summarised for prompts.
import BASE_RAW from "./terms-base.json";
import LIB_RAW from "./terms-lib.json";
import { escRe } from "../util";
import { cfg } from "../settings/settings";
import { glossary } from "./glossary";
import { people } from "../meeting/prep";

export interface Term { c: string; t: string; e: string; d: string; n?: string; s?: string; keys: string[]; re: { test(c: string): boolean }[] }

/** match keys: every name, English name/abbreviation and spoken form; Latin keys match on word boundaries */
function prepTerms(arr: any[]): Term[] {
  return arr.map((x) => {
    const keys = [...x.t.split(/\s*\/\s*|,\s*/), ...x.e.split(/\s*\/\s*|,\s*/), ...(x.s ? x.s.split(/,\s*/) : [])]
      .map((k: string) => k.replace(/^AG\)/, "").replace(/\s*NG$/i, "").replace(/\(.*?\)/g, "").trim().toLowerCase()).filter((k: string) => k.length >= 2);
    const uniq = [...new Set<string>(keys)];
    return { ...x, keys: uniq, re: uniq.map((k) => (/^[\x00-\x7f]+$/.test(k) ? new RegExp("(^|[^a-z0-9])" + escRe(k) + "($|[^a-z0-9])") : { test: (c: string) => c.includes(k) })) };
  });
}
export const BASE_TERMS = prepTerms(BASE_RAW);
export const LIB_TERMS = prepTerms(LIB_RAW);

/** terms whose keys occur in c, most specific (longest matching key) first */
export function hits(arr: Term[], c: string): Term[] {
  const out: [number, Term][] = [];
  for (const x of arr) { let best = 0; x.re.forEach((r, i) => { if (best < x.keys[i].length && r.test(c)) best = x.keys[i].length; }); if (best) out.push([best, x]); }
  return out.sort((a, b) => b[0] - a[0]).map((p) => p[1]);
}
export const compact = (x: Term) => x.t + (x.e && x.e !== x.t ? ` (${x.e})` : "") + (x.s ? ` [발음: ${x.s}]` : "");
export const BASE_COMPACT = BASE_TERMS.map(compact).join("\n");
export const shortName = (x: Term) => x.t.split(/\s*\/\s*/)[0];

/** too common to be worth a card on their own */
export const GENERIC = new Set(["셀 / Cell", "모듈 / Module", "팩 / Pack", "활물질", "전압", "용량", "확산", "임피던스", "완화", "코팅", "믹싱", "슬러리", "고형분", "로딩", "실링", "에이징", "이물", "얼라인먼트", "리드 탭", "탭 / Tab", "전해액", "첨가제", "리튬염", "전극조립체", "Record / 행 단위", "Trend", "Gap", "Input / 투입수량", "Good / 양품", "Lot", "Screening", "Pouch", "Loader", "CSV"]);

/** dictionary terms heard in c (lower-cased), best first; a Korean key must be 3+ letters, Latin keys always count */
export function dictHits(c: string): Term[] {
  const out: [number, Term][] = [];
  for (const arr of [cfg.baseOn ? BASE_TERMS : [], cfg.libOn ? LIB_TERMS : []]) for (const x of arr) {
    if (GENERIC.has(x.t)) continue; let best = 0, lat = false;
    x.re.forEach((r, i) => { const k = x.keys[i]; if (k.length > best && r.test(c)) { best = k.length; lat = /^[\x00-\x7f]+$/.test(k); } });
    if (best && (lat || best >= 3)) out.push([best + (lat ? 2 : 0), x]);
  }
  return out.sort((a, b) => b[0] - a[0]).map((p) => p[1]);
}

const attendeeNames = () => people().map((x) => x.replace(/\s*\(.*?\)\s*/g, " ").trim()).filter(Boolean);
const userBlock = () => (glossary.text.slice(0, 2000).trim() + (attendeeNames().length ? "\n참석자 이름: " + attendeeNames().join(", ") : "")).trim();
const HEAD = "[용어 사전] 이 회의(리튬이온 배터리 Formation·EOL 공정)에서 쓰이는 용어. 받아쓰기에 발음이 비슷한 엉뚱한 단어나 한글 발음 표기([발음])가 보이면 이 목록의 용어로 해석하고, 카드·답변·교정에는 사전의 올바른 표기를 쓴다.";

/**
 * The glossary part of a prompt (legacy wording).
 * fullBase:false sends only the Formation·EOL terms heard in ctx (smaller prompt = faster first token).
 */
export function glossBlock(ctx = "", { defs = true, maxDefs = 8, fullBase = true } = {}): string {
  const c = (ctx || "").toLowerCase();
  const user = userBlock(), base = !cfg.baseOn ? "" : fullBase ? BASE_COMPACT : c ? hits(BASE_TERMS, c).slice(0, 12).map(compact).join("\n") : "";
  const lib = cfg.libOn && c ? hits(LIB_TERMS, c).slice(0, defs ? Math.max(16, maxDefs + 8) : 20) : [];
  if (!user && !base && !lib.length) return "";
  return `\n${HEAD}\n${base}${base && user ? "\n" : ""}${user}\n${glossDefs(c, { defs, maxDefs, lib })}`;
}
function glossDefs(c: string, { defs, maxDefs, lib }: { defs: boolean; maxDefs: number; lib: Term[] }) {
  const hit = defs && cfg.baseOn && c ? hits(BASE_TERMS, c).slice(0, maxDefs) : [];
  const libLines = lib.map((x, i) => (defs && i < maxDefs ? `- ${compact(x)}: ${x.d}${x.n ? " — " + x.n : ""}` : `- ${compact(x)}`));
  return `${hit.length ? "\n[관련 용어 정의]\n" + hit.map((x) => `- ${x.t} (${x.e}): ${x.d}${x.n ? " — " + x.n : ""}`).join("\n") + "\n" : ""}${libLines.length ? "\n[리튬이온전지 용어 — 이번 대화에 나온 것]\n" + libLines.join("\n") + "\n" : ""}`;
}
/** cache-friendly split: the part that stays the same call after call (full Formation list + user glossary + attendees) */
export function glossStable(): string {
  const user = userBlock(), base = cfg.baseOn ? BASE_COMPACT : "";
  if (!user && !base) return "";
  return `\n${HEAD}\n${base}${base && user ? "\n" : ""}${user}\n`;
}
/** ...and the part that depends on what was just said (definitions of the terms heard) */
export function glossVarying(ctx: string, { defs = true, maxDefs = 4 } = {}): string {
  const c = (ctx || "").toLowerCase(); if (!c) return "";
  const lib = cfg.libOn ? hits(LIB_TERMS, c).slice(0, defs ? Math.max(16, maxDefs + 8) : 20) : [];
  return glossDefs(c, { defs, maxDefs, lib });
}
