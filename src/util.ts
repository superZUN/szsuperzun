// Small helpers shared by every module.
export const $ = (id: string): any => document.getElementById(id);
export const safeUrl = (u: string) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch { return ""; } };
export const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
export const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const hhmm = (ms: number) => { const d = new Date(ms), p = (n: number) => String(n).padStart(2, "0"); return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()); };
export const mmss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return (s >= 3600 ? Math.floor(s / 3600) + ":" : "") + String(Math.floor(s / 60) % 60).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); };
export function stamp(d: Date) { const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").trim() || "회의록";
export function download(name: string, text: string, type: string) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: type + ";charset=utf-8" }));
  a.download = name; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
/** a button that needs a second press within 3 s ("한 번 더") */
export function armButton(b: HTMLButtonElement, label: string, run: () => void, armedLabel = "한 번 더", ms = 3000) {
  let armed = false;
  b.addEventListener("click", () => {
    if (!armed) { armed = true; b.textContent = armedLabel; b.classList.add("arm"); setTimeout(() => { armed = false; b.textContent = label; b.classList.remove("arm"); }, ms); return; }
    armed = false; b.textContent = label; b.classList.remove("arm"); run();
  });
}
/** bigram overlap of two strings, 0..1 (relative to the shorter) */
export function simText(a: string, b: string) {
  const A = new Set<string>(), B = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) A.add(a.slice(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) B.add(b.slice(i, i + 2));
  let n = 0; A.forEach((g) => { if (B.has(g)) n++; });
  return n / Math.max(1, Math.min(A.size, B.size));
}
/** parse every complete top-level {...} object in a (possibly unfinished) JSON stream */
export function completeObjects(t: string): any[] {
  const out: any[] = []; let depth = 0, start = -1, inStr = false, escp = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (escp) escp = false; else if (ch === "\\") escp = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}" && depth > 0) { depth--; if (depth === 0 && start >= 0) { try { out.push(JSON.parse(t.slice(start, i + 1))); } catch { /* skip */ } start = -1; } }
  }
  return out;
}
export const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const SAFARI = IOS || (/Safari/.test(navigator.userAgent) && !/Chrome|CriOS|Chromium|Edg|FxiOS/.test(navigator.userAgent));
export const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
