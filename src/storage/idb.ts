// Documents (minutes and uploaded material) in IndexedDB — same database and store as the legacy app ("meeting-copilot" / "docs").
import type { Doc } from "../state";

let db: IDBDatabase | null = null;
export function openDB(): Promise<void> {
  return new Promise((res) => {
    try {
      const r = indexedDB.open("meeting-copilot", 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("docs")) r.result.createObjectStore("docs", { keyPath: "id" }); };
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
