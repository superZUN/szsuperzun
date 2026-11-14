// 기록 보드 (ARCHIVE): every card shown so far on one board. Drag the board to look around, drag a card to move it,
// pinch / ctrl+wheel to zoom (0.35–1.8), type to search (matches gathered at the top), filter by kind, "목록" for a list.
// Light: each card's DOM is built once and reused; only cards near the screen are attached; heights measured once;
// the HUD is paused while the board is open.
import { $ } from "../util";
import { S, type CardData } from "../state";
import { TYPE, fill, openFocus, openHist } from "../hud/cards";
import { wake } from "../hud/field";

const BW = 250, BG = 14;
let bScale = 1, bPanX = 0, bPanY = 0, bType = "", bQ: string[] = [], bList: CardData[] = [], bRaf = 0;
interface Entry { el: HTMLElement; h: number; text: string; attached: boolean; q: string | null; sig: string }
const bCache = new Map<CardData, Entry>();
export const boardOpen = () => !$("board").hidden;
/** for tests: how many cards are in the page right now */
export const boardStats = () => ({ attached: [...bCache.values()].filter((e) => e.attached).length, total: bList.length, scale: bScale });

const boardText = (d: CardData) => [d.title, d.body, d.source, d.kw, TYPE[d.type], d.img && d.img.title, (d.links || []).map((l) => l.t).join(" ")].filter(Boolean).join(" ").toLowerCase();
function markText(e: Entry) {
  const q = bQ.join(" "); if (e.q === q) return; e.q = q;
  e.el.querySelectorAll<HTMLElement>(".title,.body").forEach((n: any) => {
    if (n._orig == null) n._orig = n.textContent; const t: string = n._orig; n.textContent = t; if (!bQ.length) return;
    const re = new RegExp("(" + bQ.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "gi"); if (!re.test(t)) return; re.lastIndex = 0; n.textContent = ""; let last = 0;
    t.replace(re, (m: string, _g: string, i: number) => { n.append(t.slice(last, i)); const mk = document.createElement("mark"); mk.textContent = m; n.append(mk); last = i + m.length; return m; }); n.append(t.slice(last));
  });
  e.el.classList.toggle("hit", bQ.length > 0);
}
function boardCard(d: CardData) {
  const el = document.createElement("div"); el.className = "bcard t-" + d.type; el.tabIndex = 0; fill(el, d, true);
  el.querySelectorAll("img").forEach((i) => { i.loading = "lazy"; i.decoding = "async"; });
  let sx = 0, sy = 0, ox = 0, oy = 0, id: number | null = null, moved = false;
  el.addEventListener("pointerdown", (e) => { if (e.button > 0) return; e.stopPropagation(); id = e.pointerId; sx = e.clientX; sy = e.clientY; ox = d.bx || 0; oy = d.by || 0; moved = false; try { el.setPointerCapture(id); } catch { /* gone */ } });
  el.addEventListener("pointermove", (e) => {
    if (e.pointerId !== id) return; const dx = (e.clientX - sx) / bScale, dy = (e.clientY - sy) / bScale; if (!moved && Math.hypot(dx, dy) * bScale < 7) return;
    if (!moved) { moved = true; el.classList.add("drag"); } d.bx = ox + dx; d.by = oy + dy; d.bpin = true; el.style.transform = `translate3d(${d.bx}px,${d.by}px,0)`;
  });
  el.addEventListener("pointerup", (e) => { if (e.pointerId !== id) return; id = null; el.classList.remove("drag"); if (!moved) openFocus(d); });
  el.addEventListener("pointercancel", () => { id = null; el.classList.remove("drag"); });
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") openFocus(d); });
  return el;
}
const bSig = (d: CardData) => (d.title || "").length + ":" + (d.body || "").length + ":" + (d.img ? (d.img.src || d.img.error || "p").length : 0) + ":" + (d.links || []).length;
function bEntry(d: CardData): Entry {
  let e = bCache.get(d); const sig = bSig(d); if (e && e.sig !== sig) { if (e.attached) e.el.remove(); e = undefined; }
  if (!e) { e = { el: boardCard(d), h: 0, text: boardText(d), attached: false, q: null, sig }; bCache.set(d, e); } return e;
}
function applyPlane() { $("boardPlane").style.transform = `translate3d(${bPanX}px,${bPanY}px,0) scale(${bScale})`; }
/** attach only the cards on (or near) the screen */
function cull() {
  const v = $("boardView"), plane = $("boardPlane"), m = 400 / bScale;
  const x0 = -bPanX / bScale - m, y0 = -bPanY / bScale - m, x1 = x0 + v.clientWidth / bScale + 2 * m, y1 = y0 + v.clientHeight / bScale + 2 * m; const want = new Set<Entry>();
  for (const d of bList) { const e = bCache.get(d)!; if ((d.bx || 0) + BW >= x0 && (d.bx || 0) <= x1 && (d.by || 0) + e.h >= y0 && (d.by || 0) <= y1) want.add(e); }
  for (const e of bCache.values()) { if (want.has(e)) { if (!e.attached) { plane.append(e.el); e.attached = true; } markText(e); } else if (e.attached) { e.el.remove(); e.attached = false; } }
}
function schedule() { if (!bRaf) bRaf = requestAnimationFrame(() => { bRaf = 0; applyPlane(); cull(); }); }
function layoutBoard(tidy: boolean) {
  const plane = $("boardPlane"), v = $("boardView"); plane.querySelectorAll(".bempty").forEach((x: Element) => x.remove());
  $("boardCount").textContent = bList.length + " / " + S.history.length;
  if (!bList.length) {
    for (const e of bCache.values()) if (e.attached) { e.el.remove(); e.attached = false; }
    const p = document.createElement("div"); p.className = "bempty"; p.textContent = S.history.length ? "맞는 카드가 없습니다." : "아직 띄운 카드가 없습니다."; plane.append(p); return;
  }
  const fresh = bList.map(bEntry).filter((e) => !e.h); // measure new cards once, in one pass
  if (fresh.length) { fresh.forEach((e) => { e.el.style.transform = "translate3d(-99999px,0,0)"; if (!e.attached) { plane.append(e.el); e.attached = true; } }); fresh.forEach((e) => { e.h = e.el.offsetHeight || 120; }); }
  const cols = Math.max(1, Math.floor((v.clientWidth / bScale - BG) / (BW + BG))), hs = new Array(cols).fill(BG);
  for (const d of bList) {
    const e = bCache.get(d)!; if (tidy) d.bpin = false;
    if (!d.bpin) { let k = 0; for (let i = 1; i < cols; i++) if (hs[i] < hs[k]) k = i; d.bx = BG + k * (BW + BG); d.by = hs[k]; hs[k] += e.h + BG; }
    e.el.style.transform = `translate3d(${d.bx}px,${d.by}px,0)`;
  }
  if (tidy) { bPanX = 0; bPanY = 0; } applyPlane(); cull();
}
function filterBoard() {
  bQ = ($("boardSearch").value || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  bList = S.history.filter((d) => (!bType || d.type === bType) && (!bQ.length || bQ.every((w) => bEntry(d).text.includes(w))));
}
function renderBoard(tidy?: boolean) { filterBoard(); layoutBoard(!!tidy || bQ.length > 0 || !!bType); }
function renderBoardTypes() {
  const box = $("boardTypes"); box.textContent = ""; const n: Record<string, number> = {}; S.history.forEach((d) => { n[d.type] = (n[d.type] || 0) + 1; });
  [["", "전체"], ...Object.keys(n).map((t) => [t, TYPE[t]])].forEach(([t, l]) => {
    const b = document.createElement("button"); b.textContent = l + (t ? " " + n[t] : ""); b.setAttribute("aria-pressed", String(bType === t)); b.dataset.type = t;
    b.addEventListener("click", () => { bType = t; renderBoardTypes(); renderBoard(true); }); box.append(b);
  });
}
export function openBoard() {
  for (const d of [...bCache.keys()]) if (!S.history.includes(d)) { const e = bCache.get(d)!; if (e.attached) e.el.remove(); bCache.delete(d); } // forget cards that left the history
  $("board").hidden = false; renderBoardTypes(); renderBoard(false); $("boardSearch").focus();
}
export function closeBoard() { if ($("board").hidden) return; $("board").hidden = true; wake(); }

export function initBoard() {
  let t: any = 0; $("boardSearch").addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => renderBoard(false), 150); });
  $("boardTidy").addEventListener("click", () => { bScale = 1; renderBoard(true); }); $("boardClose").addEventListener("click", closeBoard); $("boardList").addEventListener("click", openHist);
  $("histBtn").addEventListener("click", openBoard);
  const v = $("boardView"), plane = $("boardPlane"), pts = new Map<number, { x: number; y: number }>(); let pan: any = null, pinch: any = null, idleT: any = 0;
  const moving = () => { plane.classList.add("moving"); clearTimeout(idleT); idleT = setTimeout(() => plane.classList.remove("moving"), 200); };
  v.addEventListener("pointerdown", (e: PointerEvent) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); try { v.setPointerCapture(e.pointerId); } catch { /* gone */ }
    if (pts.size === 1) pan = { x: e.clientX, y: e.clientY, px: bPanX, py: bPanY };
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: bScale, px: bPanX, py: bPanY, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; pan = null; }
    v.classList.add("panning");
  });
  v.addEventListener("pointermove", (e: PointerEvent) => {
    if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()], r = v.getBoundingClientRect(); const s = Math.max(0.35, Math.min(1.8, (pinch.s * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d));
      const mx = pinch.mx - r.left, my = pinch.my - r.top; bPanX = mx - ((mx - pinch.px) * s) / pinch.s; bPanY = my - ((my - pinch.py) * s) / pinch.s; bScale = s; moving(); schedule();
    } else if (pan) { bPanX = pan.px + e.clientX - pan.x; bPanY = pan.py + e.clientY - pan.y; moving(); schedule(); }
  });
  const up = (e: PointerEvent) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (!pts.size) { pan = null; v.classList.remove("panning"); } };
  v.addEventListener("pointerup", up); v.addEventListener("pointercancel", up);
  v.addEventListener("wheel", (e: WheelEvent) => {
    e.preventDefault(); const r = v.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) { const s = Math.max(0.35, Math.min(1.8, bScale * Math.exp(-e.deltaY * 0.01))), mx = e.clientX - r.left, my = e.clientY - r.top; bPanX = mx - ((mx - bPanX) * s) / bScale; bPanY = my - ((my - bPanY) * s) / bScale; bScale = s; }
    else { bPanX -= e.deltaX; bPanY -= e.deltaY; }
    moving(); schedule();
  }, { passive: false });
}
