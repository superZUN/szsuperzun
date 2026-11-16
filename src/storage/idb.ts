// Documents (minutes and uploaded material) in IndexedDB — same database and store as the legacy app ("meeting-copilot" / "docs").
import type { Doc } from "../state";

let db: IDBDatabase | null = null;
export function openDB(): Promise<void> {
  return new Promise((res) => {
    try {
      const r = indexedDB.open("meeting-copilot", 2); // v2 adds "audio" (meeting recordings); "docs" is the legacy store
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains("docs")) r.result.createObjectStore("docs", { keyPath: "id" });
        if (!r.result.objectStoreNames.contains("audio")) r.result.createObjectStore("audio", { keyPath: "id" });
      };
      r.onsuccess = () => { db = r.result; res(); };
      r.onerror = () => res();
    } catch { res(); }
  });
}
const store = (mode: IDBTransactionMode) => db!.transaction("docs", mode).objectStore("docs");
export function loadDocs(): Promise<Doc[]> {
  return new Promise((res) => {
    if (!db) return res([]);
    try { const q = store("readonly").getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); } catch { res([]); }
  });
}
export function saveLocal(d: Doc) { if (db) { try { store("readwrite").put(d); } catch { /* quota */ } } }
export function deleteLocal(id: string) { if (db) { try { store("readwrite").delete(id); } catch { /* ignore */ } } }

/* ---------- meeting recordings: MP3 parts per meeting ("<meeting>-<n>") ---------- */
export interface AudioPart { id: string; key: string; idx: number; data: Blob; sec: number }
const audio = (mode: IDBTransactionMode) => db!.transaction("audio", mode).objectStore("audio");
export function saveAudioPart(p: AudioPart) { if (db) { try { audio("readwrite").put(p); } catch { /* quota */ } } }
export function loadAudioParts(key: string): Promise<AudioPart[]> {
  return new Promise((res) => {
    if (!db) return res([]);
    try { const q = audio("readonly").getAll(); q.onsuccess = () => res(((q.result || []) as AudioPart[]).filter((p) => p.key === key).sort((a, b) => a.idx - b.idx)); q.onerror = () => res([]); } catch { res([]); }
  });
}
export function deleteAudio(key: string): Promise<void> {
  return new Promise((res) => {
    if (!db) return res();
    try { const st = audio("readwrite"); const q = st.getAll(); q.onsuccess = () => { ((q.result || []) as AudioPart[]).filter((p) => p.key === key).forEach((p) => st.delete(p.id)); res(); }; q.onerror = () => res(); } catch { res(); }
  });
}
