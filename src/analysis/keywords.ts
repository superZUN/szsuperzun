// Instant keyword layer (no AI, ~0.1 s): every sentence — and the one being spoken, every 0.7 s — is matched against
// the dictionaries (DEF card for a new keyword) and past minutes (RECALL card, each sentence once per 15 min).
// Keywords from the AI analysis also get a Wikipedia summary (free) and, by setting, an AI web search (one per 15 s,
// newest first). Everything is collected per keyword in the KEYWORDS bar.
import { $, hhmm } from "../util";
import { S, dailyTalk } from "../state";
import { cfg } from "../settings/settings";
import { ai, canWebSearch, searchCall, errText } from "../ai/client";
import { keywordSearchPrompt } from "../ai/prompts";
import { overLimit } from "../ai/usage";
import { dictHits, shortName, type Term } from "../library/dict";
import { index, retrieveScored, recallSource, type Chunk } from "../library/docs";
import { addNode, linkList, visFill, closeFocus, setFocusItem } from "../hud/cards";
import { makeDiagram, showPhoto } from "../qa/visual";
import { qTokens } from "../qa/ask";

export interface KW {
  k: string; at: number; last?: number; count: number; origin: string; def: Term | null; recall: { doc: string; text: string } | null;
  wiki: { title: string; text: string; url: string; img: any } | null; web: { text: string; links: { t: string; u: string }[]; pending?: boolean } | null;
  ctx: string; photo?: any; diagram?: any; isNew?: boolean; defT?: string;
}
export const kwMap = new Map<string, KW>();
export const recallSeen = new Map<string, number>();

/** the sentence of a chunk that best matches the query (Latin tokens weigh 3) */
export function bestSentence(chunkText: string, query: string) {
  const q = qTokens(query); let best = "", bs = 0;
  chunkText.split(/(?<=[.!?。다요함음됨])\s+|\n+/).map((s) => s.replace(/^[#\-*|\s]+/, "").trim()).filter((s) => s.length >= 8).forEach((s) => {
    const st = qTokens(s); let sc = 0; q.forEach((t) => { if (st.has(t)) sc += /^[a-z0-9]/.test(t) ? 3 : 1; }); if (sc > bs) { bs = sc; best = s; }
  });
  return best.length > 170 ? best.slice(0, 168) + "…" : best;
}
export function showDef(x: Term, kw: string) { addNode({ type: "term", title: x.t + (x.e && x.e !== x.t && x.e.length < 40 ? " · " + x.e : ""), body: x.d + (x.n ? " — " + x.n : ""), source: "용어 사전", kw }); }
export function showRecall(c: Chunk, text: string, kw: string) {
  const sent = bestSentence(c.text, text); if (!sent) return null; const key = c.doc + "|" + sent.slice(0, 40);
  if (recallSeen.has(key) && Date.now() - recallSeen.get(key)! < 15 * 60000) return null; recallSeen.set(key, Date.now());
  addNode({ type: "past", title: c.doc, body: sent, source: recallSource(c), kw }); return { doc: c.doc, text: sent };
}
export function instantScan(text: string) {
  if (!cfg.instantOn || !text) return; const c = text.toLowerCase(); let defShown = false;
  const all = dictHits(c);
  // everyday talk: only clear technical talk (two terms, or an English term said as such) counts
  if (dailyTalk() && all.length < 2 && !(all[0] && /^[\x00-\x7f]+$/.test(all[0].e || "") && c.includes(String(all[0].e || "").toLowerCase().split(/[\s(/,]/)[0]))) all.length = 0;
  for (const x of all.slice(0, 3)) { const e = addKeyword(shortName(x), "dict", text, x); if (e && e.isNew && !defShown) { showDef(x, e.k); defShown = true; } }
  if (index.chunks.length) { const r = retrieveScored(text, 1, { skipToday: true })[0]; const d = dailyTalk(); if (r && r.n >= (d ? 6 : 4) && r.s >= (d ? 8 : 4)) showRecall(r.c, text, ""); }
}
let lastInterimScan = 0;
export function instantScanSoon(t: string) { const now = Date.now(); if (now - lastInterimScan < 700) return; lastInterimScan = now; instantScan(t); }

export function addKeyword(k: string, origin: string, ctx: string, dict?: Term): KW | null {
  k = String(k || "").trim(); if (k.length < 2) return null; const key = k.toLowerCase(); let e = kwMap.get(key); const isNew = !e;
  if (!e) { e = { k, at: Date.now(), count: 0, origin, def: dict || null, recall: null, wiki: null, web: null, ctx: (ctx || "").slice(-240) }; kwMap.set(key, e); }
  e.count++; e.last = Date.now(); if (dict && !e.def) e.def = dict; renderKwBar();
  if (isNew && origin === "ai") void lookupKeyword(e);
  return Object.assign(e, { isNew });
}
async function lookupKeyword(e: KW) {
  const d = dictHits(e.k.toLowerCase())[0];
  if (d && !e.def) { e.def = d; if (![...kwMap.values()].some((o) => o !== e && o.def === d)) showDef(d, e.k); }
  if (!e.def && index.chunks.length) { const r = retrieveScored(e.k + " " + e.ctx.slice(-80), 1, { skipToday: true })[0]; if (r && r.n >= (dailyTalk() ? 5 : 3)) { const rc = showRecall(r.c, e.k + " " + e.ctx.slice(-80), e.k); if (rc) e.recall = rc; } }
  if (e.def) return; // dictionary terms are already explained
  if (cfg.wikiOn) void wikiLookup(e);
  if (webAllowed()) queueWeb(e);
}
/** first paragraph of the Wikipedia article about exactly this word (title must match) */
export async function wikiLookup(e: KW) {
  for (const lang of /[가-힣]/.test(e.k) ? ["ko"] : ["ko", "en"]) {
    try {
      const r = await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(e.k)}&gsrlimit=1&prop=extracts|pageimages&exintro=1&explaintext=1&exsentences=2&piprop=thumbnail|original&pithumbsize=640&format=json&origin=*`);
      if (!r.ok) continue; const j = await r.json(); const p: any = j && j.query && j.query.pages && Object.values(j.query.pages)[0]; if (!p || !p.extract) continue;
      const t = p.title.toLowerCase().replace(/\s/g, ""), k = e.k.toLowerCase().replace(/\s/g, ""); if (!(t.includes(k) || k.includes(t))) continue;
      const url = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`;
      const img = p.thumbnail && !/logo|flag|icon/i.test(p.thumbnail.source) ? { src: p.thumbnail.source, full: p.original ? p.original.source : p.thumbnail.source, title: p.title, credit: "위키백과 · " + p.title, page: url, kind: "photo" as const } : null;
      e.wiki = { title: p.title, text: p.extract.replace(/\s+/g, " ").slice(0, 260), url, img }; if (img && !e.photo) e.photo = img;
      addNode({ type: "web", title: e.k + " · 위키백과", body: e.wiki.text, links: [{ t: "위키백과 — " + p.title, u: url }], kw: e.k, img }); renderKwBar(); refreshKwFocus(e); return;
    } catch { /* next language */ }
  }
}
/* AI web search: one at a time, newest keyword first, at most every 15 s */
let webBusy = false, webLast = 0; const webQ: KW[] = [];
export function webAllowed(force?: boolean) { return canWebSearch() && (force || (!overLimit() && (cfg.webMode === "always" || (cfg.webMode === "conv" && S.appMode === "conv")))); }
export function queueWeb(e: KW, now?: boolean) { if (e.web || webQ.includes(e)) return; webQ.unshift(e); if (webQ.length > 3) webQ.length = 3; if (now) webLast = 0; void pumpWeb(); }
async function pumpWeb() {
  if (webBusy || !webQ.length || S.standby) return; const wait = webLast + 15000 - Date.now(); if (wait > 0) { setTimeout(pumpWeb, wait + 50); return; }
  const e = webQ.shift()!; webBusy = true; webLast = Date.now(); e.web = { text: "", links: [], pending: true }; refreshKwFocus(e);
  const node = addNode({ type: "web", title: e.k + " · 웹 검색", body: "검색 중…", kw: e.k });
  try { const res = await searchCall(keywordSearchPrompt(e.k, e.ctx), { maxTokens: 600, onText: (t) => node.setBody(t), kind: "kwweb" }); e.web = { text: res.text, links: res.links }; node.setBody(res.text || "관련 정보를 찾지 못했습니다."); node.setLinks(res.links); }
  catch (err) { e.web = null; node.setBody(errText(err)); }
  refreshKwFocus(e); webBusy = false; void pumpWeb();
}
export function clearKeywords() { kwMap.clear(); recallSeen.clear(); webQ.length = 0; renderKwBar(); }

/* ---------- KEYWORDS bar + keyword detail ---------- */
export function renderKwBar() {
  const box = $("kwList"); box.textContent = "";
  [...kwMap.values()].sort((a, b) => (b.last || b.at) - (a.last || a.at)).slice(0, 30).forEach((e) => {
    const b = document.createElement("button"); b.className = "kw" + (Date.now() - (e.last || e.at) < 5000 ? " fresh" : ""); b.textContent = e.k;
    const t = document.createElement("span"); t.className = "kt"; t.textContent = (e.def ? "DEF" : e.web && !e.web.pending ? "WEB" : e.wiki ? "WIKI" : e.recall ? "PAST" : "") + (e.count > 1 ? " ×" + e.count : ""); b.append(t);
    b.addEventListener("click", () => openKw(e)); box.append(b);
  });
  $("kwEmpty").hidden = kwMap.size > 0;
}
let kwOpen: KW | null = null;
export function openKw(e: KW) {
  kwOpen = e; setFocusItem(null); const c = $("focusCard"); c.className = "focus t-web"; c.textContent = "";
  const hd = document.createElement("div"); hd.className = "hd"; const code = document.createElement("span"); code.className = "code"; code.textContent = "KEYWORD"; const tm = document.createElement("span");
  tm.textContent = `처음 ${hhmm(e.at)} · ${e.count}회`; hd.append(code, tm); const h = document.createElement("div"); h.className = "title"; h.textContent = e.k; c.append(hd, h);
  const sec = (label: string, body: string, links?: { t: string; u: string }[]) => { const s = document.createElement("div"); s.className = "ksec"; const b = document.createElement("b"); b.textContent = label; const p = document.createElement("div"); p.className = "body"; p.textContent = body; s.append(b, p); if (links && links.length) s.append(linkList(links)); c.append(s); };
  if (e.def) sec("DEF · 용어 사전", `${e.def.t} (${e.def.e}) — ${e.def.d}${e.def.n ? " · " + e.def.n : ""}`);
  if (e.recall) sec("PAST · 지난 회의록", `${e.recall.doc}: ${e.recall.text}`);
  else if (index.chunks.length) { const r = retrieveScored(e.k, 1)[0]; if (r && r.n >= 2) sec("PAST · 지난 회의록", `${r.c.doc}: ${bestSentence(r.c.text, e.k)}`); }
  if (e.wiki) sec("WIKI · 위키백과", e.wiki.text, [{ t: "위키백과 — " + e.wiki.title, u: e.wiki.url }]);
  if (e.web) sec("WEB · 웹 검색", e.web.pending ? "검색 중…" : e.web.text || "찾은 내용이 없습니다.", e.web.links);
  if (e.photo || e.diagram) { const s = document.createElement("div"); s.className = "ksec"; const b = document.createElement("b"); b.textContent = "VISUAL · 그림"; s.append(b); [e.diagram, e.photo].filter(Boolean).forEach((im) => { const v = document.createElement("div"); visFill(v, { img: im, title: e.k }, true); s.append(v); }); c.append(s); }
  if (e.ctx) sec("CONTEXT · 나온 대목", e.ctx);
  const row = document.createElement("div"); row.className = "row"; row.style.justifyContent = "flex-end";
  if (!e.web && webAllowed(true)) { const w = document.createElement("button"); w.textContent = "웹 검색"; w.addEventListener("click", () => { queueWeb(e, true); openKw(e); }); row.append(w); }
  if (!e.wiki) { const w = document.createElement("button"); w.textContent = "위키백과"; w.addEventListener("click", async () => { w.disabled = true; await wikiLookup(e); if (!e.wiki) w.textContent = "위키백과에 없음"; else openKw(e); }); row.append(w); }
  if (!e.diagram && ai.apiKey) {
    const w = document.createElement("button"); w.textContent = "그림으로 보기";
    w.addEventListener("click", async () => {
      w.disabled = true; w.textContent = "그리는 중…";
      const node = addNode({ type: "visual", title: e.k + " · 다이어그램", body: "", kw: e.k, img: { pending: true, kind: "diagram" } });
      if (await makeDiagram(e.k + (e.def ? ` (${e.def.e}: ${e.def.d})` : "") + "의 개념·구조·과정", e.ctx, { kw: e.k, node })) e.diagram = node.data.img; else w.textContent = "그리지 못함"; refreshKwFocus(e);
    }); row.append(w);
  }
  if (!e.photo) {
    const w = document.createElement("button"); w.textContent = "사진 찾기";
    w.addEventListener("click", async () => { w.disabled = true; w.textContent = "찾는 중…"; const im = await showPhoto(e.def && e.def.e && /^[\x00-\x7f]+$/.test(e.def.e) ? e.def.e.split(/[,(]/)[0].trim() : e.k, e.k); if (im) { e.photo = im; refreshKwFocus(e); } else w.textContent = "사진 없음"; });
    row.append(w);
  }
  const close = document.createElement("button"); close.textContent = "닫기"; close.addEventListener("click", closeFocus); row.append(close); c.append(row);
  $("focusVeil").hidden = false; close.focus();
}
export function refreshKwFocus(e: KW) { if (kwOpen === e && !$("focusVeil").hidden) openKw(e); }
export function initKeywords() { setInterval(() => { if (document.querySelector("#kwList .fresh")) renderKwBar(); }, 2500); }
