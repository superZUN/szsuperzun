// Saved minutes and material: IndexedDB copy, server copy (/api/minutes), and the local search index.
import { $, hhmm } from "../util";
import { S, type Doc } from "../state";
import { ls } from "../storage/ls";
import { saveLocal, deleteLocal } from "../storage/idb";
import { server, serverApi, serverErrText } from "../storage/server";
import { renderDocs } from "./ui";

export const isFinal = (d: Doc) => !d.status || d.status === "final";
export interface Chunk { doc: string; text: string; set: Set<string> }
export const index = { chunks: [] as Chunk[], idf: new Map<string, number>() };

export function putDoc(d: Doc) { S.docs.push(d); saveLocal(d); void pushDoc(d); }
const tombs = (): string[] => ls.json<string[]>("ms.docTomb", []);
export function delDoc(id: string) {
  const d = S.docs.find((x) => x.id === id); S.docs = S.docs.filter((x) => x.id !== id); deleteLocal(id);
  if (d && d.synced && server.passcode) serverApi("/api/minutes?id=" + encodeURIComponent(id), "DELETE").catch(() => { const t = tombs(); t.push(id); ls.set("ms.docTomb", JSON.stringify(t)); });
}
function syncMsg(t: string, warn?: boolean) { const m = $("syncMsg"); m.className = "hint" + (warn ? " warn" : ""); m.textContent = t; }
/** only confirmed records go to the server */
export async function pushDoc(d: Doc) {
  if (!server.passcode || !isFinal(d)) return;
  try { await serverApi("/api/minutes", "PUT", { id: d.id, name: d.name, text: d.text, added: d.added }); d.synced = true; saveLocal(d); renderDocs(); } catch { /* next sync retries */ }
}
let syncing = false; export let lastSync = 0;
export async function syncDocsNow(manual: boolean) {
  if (!server.passcode) { if (manual) syncMsg("설정 탭의 '서버 동기화 비밀번호'를 먼저 넣어 주세요.", true); return; }
  if (syncing) return; syncing = true; if (manual) syncMsg("서버와 동기화하는 중…");
  try {
    let t = tombs();
    for (const id of t) { try { await serverApi("/api/minutes?id=" + encodeURIComponent(id), "DELETE"); t = t.filter((x) => x !== id); } catch (e: any) { if (e.code !== "server_err") throw e; } }
    ls.set("ms.docTomb", t.length ? JSON.stringify(t) : "");
    const { items } = await serverApi("/api/minutes", "GET"); const onServer = new Map<string, any>(items.map((x: any) => [x.id, x])); let got = 0, sent = 0, gone = 0;
    for (const d of S.docs.slice()) if (d.synced && !onServer.has(d.id)) { S.docs = S.docs.filter((x) => x !== d); deleteLocal(d.id); gone++; }
    for (const it of items) {
      if (S.docs.some((d) => d.id === it.id) || tombs().includes(it.id)) continue; let full;
      // an index entry whose document was just deleted or replaced elsewhere: skip it, the server prunes it
      try { full = await serverApi("/api/minutes?id=" + encodeURIComponent(it.id), "GET"); } catch (e: any) { if (e.code === "server_err" && e.status === 404) continue; throw e; }
      const d: Doc = { id: full.id, name: full.name, text: full.text, added: full.added, synced: true }; S.docs.push(d); saveLocal(d); got++;
    }
    for (const d of S.docs) if (!d.synced && isFinal(d)) { await serverApi("/api/minutes", "PUT", { id: d.id, name: d.name, text: d.text, added: d.added }); d.synced = true; saveLocal(d); sent++; }
    lastSync = Date.now(); rebuildIndex();
    syncMsg(`서버와 동기화됨 · 서버에 ${S.docs.filter((d) => d.synced).length}개${got ? ` · ${got}개 받아옴` : ""}${sent ? ` · ${sent}개 올림` : ""}${gone ? ` · 다른 기기에서 지운 ${gone}개 정리` : ""} · ${hhmm(lastSync)}`);
  } catch (e) { syncMsg(serverErrText(e) + " 이 기기의 회의록은 그대로 있습니다.", true); }
  syncing = false;
}

/* ---------- retrieval: hangul bigrams + latin words, idf weighted ---------- */
export function tokens(s: string): string[] {
  const out: string[] = []; s = s.toLowerCase();
  for (const m of s.matchAll(/[가-힣]+/g)) { const w = m[0]; if (w.length === 1) continue; for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2)); }
  for (const m of s.matchAll(/[a-z0-9][a-z0-9.\-]{2,}/g)) out.push(m[0]);
  return out;
}
/** unconfirmed records (준비중 / 검토 필요) are left out of the index */
export function rebuildIndex() {
  const chunks: Chunk[] = [], df = new Map<string, number>();
  for (const d of S.docs) {
    if (!isFinal(d)) continue; const t = d.text, size = 700, step = 550;
    for (let i = 0; i < t.length; i += step) {
      const text = t.slice(i, i + size); const set = new Set(tokens(text));
      chunks.push({ doc: d.name, text, set }); set.forEach((k) => df.set(k, (df.get(k) || 0) + 1)); if (i + size >= t.length) break;
    }
  }
  const idf = new Map<string, number>(); const N = chunks.length || 1; df.forEach((v, k) => idf.set(k, Math.log(1 + N / v)));
  index.chunks = chunks; index.idf = idf;
  $("kbCount").textContent = S.docs.length; renderDocs();
}
export interface Scored { c: Chunk; s: number; n: number }
export function retrieveScored(query: string, k: number): Scored[] {
  if (!index.chunks.length) return []; const q = new Set(tokens(query));
  const scored = index.chunks.map((c) => { let s = 0, n = 0; q.forEach((t) => { if (c.set.has(t)) { s += index.idf.get(t) || 0; n++; } }); return { c, s, n }; }).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s); return scored.slice(0, k);
}
export function contextBlock(query: string, k: number) {
  const hs = retrieveScored(query, k).map((x) => x.c); if (!hs.length) return "(관련 회의록 없음)";
  return hs.map((h) => "<<" + h.doc + ">>\n" + h.text).join("\n---\n");
}
