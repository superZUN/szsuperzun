// 마인드맵: everything said in a period — confirmed minutes, day summaries, conversation logs (days without a summary),
// and today's talk — gathered into one AI call that returns a topic tree, drawn here in the HUD style.
// The knob at a node's right end opens / closes its branch; tapping the node shows related passages and "이것에 대해 질문".
// Drag to look around, pinch or ctrl+wheel to zoom. The last map per period/scope is kept on this device.
import { $, completeObjects, esc } from "../util";
import { S, joined, docKind, type Doc } from "../state";
import { ls } from "../storage/ls";
import { cfg } from "../settings/settings";
import { ai, aiCall, errText } from "../ai/client";
import { mindmapPrompt } from "../ai/prompts";
import { isFinal, retrieveScored } from "../library/docs";
import { savePng, setFocusItem, closeFocus } from "../hud/cards";
import { bestSentence } from "../analysis/keywords";
import { flushLog, dayKey } from "../memory/daylog";
import { ask } from "../qa/ask";
import { showTab } from "../controls";

export interface MNode { t: string; n?: string; s?: string[]; c?: MNode[]; open?: boolean; id?: number; x?: number; y?: number; w?: number; h?: number; depth?: number; color?: string; parent?: MNode | null }
interface Stored { at: number; tree: MNode; sources: number }
type Range = "today" | "7" | "30" | "all";
const RANGE_LABEL: Record<Range, string> = { today: "오늘", "7": "최근 7일", "30": "최근 30일", all: "지금까지 전체" };
const PALETTE = ["#6FE7FF", "#7CFFB2", "#D7B8FF", "#FFB547", "#8EC5FF", "#FF7A9A", "#B7C7FF", "#9FF3D0", "#E6F6FA"];
const FONT = "IBM Plex Sans KR, Pretendard, 'Apple SD Gothic Neo', sans-serif";
const M = { range: "7" as Range, scope: "all", tree: null as MNode | null, scale: 1, panX: 40, panY: 0, busy: false, fitted: false };
export const mindState = M; // tests
const key = () => `ms.mm.${M.range}.${M.scope}`;

/* ---------- material ---------- */
const startOf = (r: Range) => { if (r === "all") return 0; if (r === "today") { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); } return Date.now() - Number(r) * 864e5; };
const dayOfId = (id: string) => new Date(id.slice(4, 14) + "T12:00:00").getTime();
const inRange = (t: number) => t >= startOf(M.range);
/** the material for the AI, newest first, at most ~150k characters */
export function collectMaterial(): { text: string; n: number } {
  if (cfg.dayLogOn) flushLog(true);
  const parts: { at: number; text: string }[] = [];
  const sums = new Set<string>();
  for (const d of S.docs) {
    const k = docKind(d);
    if (k === "daysum" && inRange(dayOfId(d.id))) { sums.add(d.id.slice(4, 14)); parts.push({ at: dayOfId(d.id) + 1, text: `<<${d.name}>>\n${d.text.slice(0, 5000)}` }); }
  }
  for (const d of S.docs) {
    const k = docKind(d);
    if (k === "doc" && isFinal(d) && d.text && inRange(d.added) && M.scope !== "daily") parts.push({ at: d.added, text: `<<${d.name}>>\n${d.text.split("## 부록")[0].slice(0, 6000)}` });
    if (k === "daylog") {
      const day = d.id.slice(4, 14); if (!inRange(dayOfId(d.id)) || (sums.has(day) && day !== dayKey())) continue;
      const lines = d.text.split("\n").filter((l) => l.startsWith("[") && (M.scope === "all" || (M.scope === "work" ? /\((회의|업무)\)/.test(l) : /\(일상\)/.test(l))));
      if (lines.length) parts.push({ at: dayOfId(d.id), text: `<<${d.name}>>\n${lines.join("\n").slice(-15000)}` });
    }
  }
  if (!cfg.dayLogOn && S.segs.length && M.range !== "all") parts.push({ at: Date.now(), text: `<<지금 받아쓰기>>\n${joined().slice(-15000)}` });
  parts.sort((a, b) => b.at - a.at);
  let total = 0; const used: string[] = [];
  for (const p of parts) { if (total + p.text.length > 150000) break; used.push(p.text); total += p.text.length; }
  return { text: used.join("\n---\n"), n: used.length };
}

/* ---------- generate ---------- */
function normalize(n: any, depth: number): MNode | null {
  if (!n || typeof n !== "object") return null; const t = String(n.t || n.title || "").trim().slice(0, 40); if (!t) return null;
  const c = depth < 4 && Array.isArray(n.c || n.children) ? (n.c || n.children).map((x: any) => normalize(x, depth + 1)).filter(Boolean).slice(0, 12) : [];
  return { t, n: n.n ? String(n.n).slice(0, 300) : "", s: Array.isArray(n.s) ? n.s.map(String).slice(0, 3) : [], c };
}
export function parseTree(text: string): MNode | null {
  let o: any = null; const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) { try { o = JSON.parse(text.slice(a, b + 1)); } catch { o = completeObjects(text)[0]; } }
  if (!o) return null; const root = normalize({ t: o.title || "마인드맵", c: o.children || o.c }, 0); return root && root.c && root.c.length ? root : null;
}
async function make() {
  if (M.busy) return;
  if (!ai.apiKey) { meta(errText({ code: "no_key" }), true); return; }
  const mat = collectMaterial();
  if (mat.text.length < 60) { meta(`${RANGE_LABEL[M.range]}에 정리할 회의·대화 내용이 거의 없습니다.`, true); return; }
  M.busy = true; $("mmMake").disabled = true; $("mmView").classList.add("busy"); meta(`자료 ${mat.n}개를 모아 마인드맵을 만드는 중…`);
  try {
    const t = await aiCall(mindmapPrompt(RANGE_LABEL[M.range], M.scope, mat.text), { maxTokens: 4000, kind: "mindmap" });
    const tree = parseTree(t); if (!tree) throw { code: "http", message: "마인드맵 형식을 읽지 못했습니다" };
    const st: Stored = { at: Date.now(), tree, sources: mat.n }; ls.set(key(), JSON.stringify(st));
    show(st, true);
  } catch (e) { meta(errText(e), true); }
  M.busy = false; $("mmMake").disabled = false; $("mmView").classList.remove("busy");
}
function meta(t: string, warn?: boolean) { const m = $("mmMeta"); m.textContent = t; m.className = "hint" + (warn ? " warn" : ""); }
const count = (n: MNode): number => 1 + (n.c || []).reduce((s, c) => s + count(c), 0);
function show(st: Stored | null, fresh = false) {
  M.tree = st ? st.tree : null; $("mmEmpty").hidden = !!M.tree;
  if (!M.tree) { $("mmSvg").innerHTML = ""; meta(""); return; }
  prepare(M.tree, 0, null, ""); M.fitted = false;
  const d = new Date(st!.at);
  meta(`${RANGE_LABEL[M.range]} · ${d.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" })} ${d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}${fresh ? "에 만듦" : " 저장본"} · 자료 ${st!.sources}개 · 주제 ${count(M.tree) - 1}개`);
  draw(); fit();
}
let seq = 0;
function prepare(n: MNode, depth: number, parent: MNode | null, color: string) {
  n.depth = depth; n.parent = parent; n.id = ++seq; n.color = depth === 0 ? PALETTE[0] : color;
  if (n.open === undefined) n.open = depth < 2;
  (n.c || []).forEach((c, i) => prepare(c, depth + 1, n, depth === 0 ? PALETTE[i % PALETTE.length] : n.color!));
}

/* ---------- layout + drawing (horizontal tree) ---------- */
let mctx: CanvasRenderingContext2D | null = null;
const textW = (t: string, px: number) => { mctx = mctx || document.createElement("canvas").getContext("2d"); mctx!.font = `${px}px ${FONT}`; return mctx!.measureText(t).width; };
const label = (n: MNode) => { const max = n.depth === 0 ? 34 : 22; return n.t.length > max ? n.t.slice(0, max - 1) + "…" : n.t; };
function layout(root: MNode) {
  const colW: number[] = []; const vis: MNode[] = [];
  (function walk(n: MNode) { const fs = n.depth === 0 ? 15 : 13; n.w = Math.min(n.depth === 0 ? 420 : 260, Math.ceil(textW(label(n), fs)) + (n.c && n.c.length ? 48 : 26)); n.h = n.depth === 0 ? 42 : 30; vis.push(n); colW[n.depth!] = Math.max(colW[n.depth!] || 0, n.w); if (n.open) (n.c || []).forEach(walk); })(root);
  const colX: number[] = []; let x = 0; colW.forEach((w, i) => { colX[i] = x; x += w + 56; });
  let slot = 0; const GAP = 12;
  (function place(n: MNode): [number, number] {
    n.x = colX[n.depth!];
    const kids = n.open ? n.c || [] : [];
    if (!kids.length) { n.y = slot; slot += n.h! + GAP; return [n.y, n.y + n.h!]; }
    const spans = kids.map(place); const top = spans[0][0], bot = spans[spans.length - 1][1];
    n.y = (top + bot) / 2 - n.h! / 2; return [Math.min(top, n.y), Math.max(bot, n.y + n.h!)];
  })(root);
  return vis;
}
const cut = (x: number, y: number, w: number, h: number, c = 8) => `M${x + c},${y}H${x + w}V${y + h - c}L${x + w - c},${y + h}H${x}V${y + c}Z`;
function draw() {
  const svg = $("mmSvg"); if (!M.tree) { svg.innerHTML = ""; return; }
  const vis = layout(M.tree); let out = "";
  for (const n of vis) for (const c of n.open ? n.c || [] : []) { // elbow wires parent → child
    const x1 = n.x! + n.w!, y1 = n.y! + n.h! / 2, x2 = c.x!, y2 = c.y! + c.h! / 2, xm = x1 + 22;
    out += `<path d="M${x1},${y1}H${xm}V${y2}H${x2}" fill="none" stroke="${c.color}" stroke-opacity=".55" stroke-width="1.2"/><rect x="${x2 - 2}" y="${y2 - 2}" width="4" height="4" fill="${c.color}"/>`;
  }
  for (const n of vis) {
    const root = n.depth === 0, kids = (n.c || []).length, fs = root ? 15 : 13;
    out += `<g class="mmnode" data-id="${n.id}" tabindex="0" role="button" aria-label="${esc(n.t)}">`;
    out += `<path d="${cut(n.x!, n.y!, n.w!, n.h!)}" fill="${root ? "rgba(111,231,255,.14)" : "#071b21"}" stroke="${n.color}" stroke-opacity="${root ? 1 : 0.7}" stroke-width="${root ? 1.6 : 1}"/>`;
    if (root) out += `<path d="${cut(n.x! - 4, n.y! - 4, n.w! + 8, n.h! + 8, 10)}" fill="none" stroke="${n.color}" stroke-opacity=".3"/>`;
    out += `<rect x="${n.x}" y="${n.y! + 6}" width="2" height="${n.h! - 12}" fill="${n.color}"/>`;
    out += `<text x="${n.x! + 12}" y="${n.y! + n.h! / 2 + fs * 0.36}" font-family="${FONT}" font-size="${fs}" font-weight="${root ? 500 : 400}" fill="#E6F6FA">${esc(label(n))}</text>`;
    out += `</g>`;
    if (kids) { // the open / close knob
      const kx = n.x! + n.w! - 13, ky = n.y! + n.h! / 2;
      out += `<g class="mmnode mmknob" data-knob="${n.id}" role="button" aria-label="${n.open ? "접기" : "펼치기"}: ${esc(n.t)}"><circle cx="${kx}" cy="${ky}" r="14" fill="transparent"/><circle cx="${kx}" cy="${ky}" r="8" fill="#02080a" stroke="${n.color}"/><text x="${kx}" y="${ky + 4}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="${n.open ? 12 : 10}" fill="${n.color}">${n.open ? "−" : kids}</text></g>`;
    }
  }
  svg.innerHTML = `<g id="mmPlane" transform="translate(${M.panX},${M.panY}) scale(${M.scale})">${out}</g>`;
}
const applyPlane = () => { const p = $("mmPlane"); if (p) p.setAttribute("transform", `translate(${M.panX},${M.panY}) scale(${M.scale})`); };
function bbox() { if (!M.tree) return null; const vis = layout(M.tree); return { x0: Math.min(...vis.map((n) => n.x!)), y0: Math.min(...vis.map((n) => n.y!)) - 6, x1: Math.max(...vis.map((n) => n.x! + n.w!)), y1: Math.max(...vis.map((n) => n.y! + n.h!)) + 6 }; }
export function fit() {
  const b = bbox(), v = $("mmView"); if (!b || !v.clientWidth) return;
  const s = Math.max(0.3, Math.min(1.2, (v.clientWidth - 40) / (b.x1 - b.x0), (v.clientHeight - 40) / (b.y1 - b.y0)));
  M.scale = s; M.panX = (v.clientWidth - (b.x1 - b.x0) * s) / 2 - b.x0 * s; M.panY = (v.clientHeight - (b.y1 - b.y0) * s) / 2 - b.y0 * s; M.fitted = true; applyPlane();
}
const find = (n: MNode, id: number): MNode | null => (n.id === id ? n : (n.c || []).reduce<MNode | null>((f, c) => f || find(c, id), null));
/** open / close a branch, keeping that node where it is on screen */
function toggle(n: MNode) {
  const sx = n.x! * M.scale + M.panX, sy = n.y! * M.scale + M.panY; n.open = !n.open; draw();
  M.panX = sx - n.x! * M.scale; M.panY = sy - n.y! * M.scale; applyPlane(); saveOpen();
}
function setAll(open: boolean) { if (!M.tree) return; (function w(n: MNode) { if ((n.c || []).length) n.open = open || n.depth === 0; (n.c || []).forEach(w); })(M.tree); draw(); fit(); saveOpen(); }
function saveOpen() { const st = ls.json<Stored | null>(key(), null); if (st && M.tree) { st.tree = strip(M.tree); ls.set(key(), JSON.stringify(st)); } }
const strip = (n: MNode): MNode => ({ t: n.t, n: n.n, s: n.s, open: n.open, c: (n.c || []).map(strip) });
const pathOf = (n: MNode) => { const p: string[] = []; for (let x: MNode | null | undefined = n; x; x = x.parent) p.unshift(x.t); return p; };

/** detail: the node's note and sources, the best matching passages, "이것에 대해 질문" */
function openNode(n: MNode) {
  setFocusItem(null); const c = $("focusCard"); c.className = "focus t-info"; c.textContent = "";
  const hd = document.createElement("div"); hd.className = "hd"; const code = document.createElement("span"); code.className = "code"; code.textContent = "MIND MAP"; const p = document.createElement("span"); p.textContent = pathOf(n).slice(0, -1).join(" › "); hd.append(code, p);
  const h = document.createElement("div"); h.className = "title"; h.textContent = n.t; c.append(hd, h);
  if (n.n) { const b = document.createElement("div"); b.className = "body"; b.textContent = n.n; c.append(b); }
  if (n.s && n.s.length) { const s = document.createElement("div"); s.className = "src"; s.textContent = "SRC // " + n.s.join(" · "); c.append(s); }
  if ((n.c || []).length) { const sec = document.createElement("div"); sec.className = "msec"; const b = document.createElement("b"); b.textContent = "하위 주제"; const d = document.createElement("div"); d.className = "body"; d.textContent = (n.c || []).map((x) => x.t).join(" · "); sec.append(b, d); c.append(sec); }
  const q = pathOf(n).slice(1).join(" ") + " " + (n.n || "");
  const hits = retrieveScored(q, 6).filter((x) => x.n >= 2); const seen = new Set<string>(); const lines: string[] = [];
  for (const x of hits) { if (seen.has(x.c.doc) || lines.length >= 4) continue; const sent = bestSentence(x.c.text, q); if (sent) { seen.add(x.c.doc); lines.push(`${x.c.doc}: ${sent}`); } }
  if (lines.length) { const sec = document.createElement("div"); sec.className = "msec"; const b = document.createElement("b"); b.textContent = "관련 대목"; sec.append(b); lines.forEach((l) => { const d = document.createElement("div"); d.className = "body"; d.textContent = l; sec.append(d); }); c.append(sec); }
  const row = document.createElement("div"); row.className = "row"; row.style.justifyContent = "flex-end";
  const askB = document.createElement("button"); askB.className = "primary"; askB.textContent = "이것에 대해 질문";
  askB.addEventListener("click", () => { closeFocus(); showTab("tabLive"); void ask(`${pathOf(n).slice(1).join(" › ")}에 대해 지금까지 나온 내용을 정리해줘`); });
  const close = document.createElement("button"); close.textContent = "닫기"; close.addEventListener("click", closeFocus);
  row.append(askB, close); c.append(row); $("focusVeil").hidden = false; close.focus();
}
function outline(n: MNode, d = 0): string { return (d === 0 ? `# ${n.t}\n` : `${"  ".repeat(d - 1)}- ${n.t}${n.n ? " — " + n.n : ""}\n`) + (n.c || []).map((c) => outline(c, d + 1)).join(""); }
function savePicture() {
  if (!M.tree) return; const open = JSON.stringify(strip(M.tree)); setAll(true); const b = bbox()!; const pad = 30;
  const plane = $("mmPlane").innerHTML;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(b.x1 - b.x0 + pad * 2)}" height="${Math.ceil(b.y1 - b.y0 + pad * 2)}" viewBox="${b.x0 - pad} ${b.y0 - pad} ${b.x1 - b.x0 + pad * 2} ${b.y1 - b.y0 + pad * 2}"><rect x="${b.x0 - pad}" y="${b.y0 - pad}" width="100%" height="100%" fill="#020507"/>${plane}</svg>`;
  savePng({ src: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg), title: "마인드맵 " + RANGE_LABEL[M.range], kind: "diagram" });
  const restore = JSON.parse(open); (function w(a: MNode, s: MNode) { a.open = s.open; (a.c || []).forEach((c, i) => w(c, (s.c || [])[i] || c)); })(M.tree, restore); draw(); fit();
}

export function renderMind() { const st = ls.json<Stored | null>(key(), null); show(st); requestAnimationFrame(() => { if (M.tree) fit(); }); }
export function initMindmap() {
  document.querySelectorAll<HTMLButtonElement>("#mindView [data-range]").forEach((b) => b.addEventListener("click", () => {
    M.range = b.dataset.range as Range; document.querySelectorAll("#mindView [data-range]").forEach((x) => x.setAttribute("aria-selected", String(x === b))); renderMind();
  }));
  $("mmScope").addEventListener("change", () => { M.scope = $("mmScope").value; renderMind(); });
  $("mmMake").addEventListener("click", make);
  $("mmExpand").addEventListener("click", () => setAll(true)); $("mmCollapse").addEventListener("click", () => setAll(false)); $("mmFit").addEventListener("click", fit);
  $("mmPng").addEventListener("click", savePicture);
  $("mmCopy").addEventListener("click", async () => { if (!M.tree) return; try { await navigator.clipboard.writeText(outline(M.tree)); meta("개요를 복사했습니다."); } catch { meta("복사하지 못했습니다.", true); } });
  // pan / zoom / tap
  const v = $("mmView"), pts = new Map<number, { x: number; y: number }>(); let pan: any = null, pinch: any = null, down: any = null;
  v.addEventListener("pointerdown", (e: PointerEvent) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); try { v.setPointerCapture(e.pointerId); } catch { /* gone */ }
    if (pts.size === 1) { pan = { x: e.clientX, y: e.clientY, px: M.panX, py: M.panY }; down = { x: e.clientX, y: e.clientY, target: (e.target as Element).closest(".mmnode") }; }
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: M.scale, px: M.panX, py: M.panY, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; pan = null; down = null; }
    v.classList.add("panning");
  });
  v.addEventListener("pointermove", (e: PointerEvent) => {
    if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) { const [a, b] = [...pts.values()], r = v.getBoundingClientRect(); const s = Math.max(0.25, Math.min(2.2, (pinch.s * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d)); const mx = pinch.mx - r.left, my = pinch.my - r.top; M.panX = mx - ((mx - pinch.px) * s) / pinch.s; M.panY = my - ((my - pinch.py) * s) / pinch.s; M.scale = s; applyPlane(); }
    else if (pan) { if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) down = null; M.panX = pan.px + e.clientX - pan.x; M.panY = pan.py + e.clientY - pan.y; applyPlane(); }
  });
  const up = (e: PointerEvent) => {
    pts.delete(e.pointerId); if (pts.size < 2) pinch = null;
    if (!pts.size) {
      pan = null; v.classList.remove("panning");
      if (down && down.target && e.type === "pointerup" && M.tree) { // a tap, not a drag
        const k = down.target.getAttribute("data-knob"), id = down.target.getAttribute("data-id");
        const n = find(M.tree, Number(k || id)); if (n) { if (k) toggle(n); else openNode(n); }
      }
      down = null;
    }
  };
  v.addEventListener("pointerup", up); v.addEventListener("pointercancel", up);
  v.addEventListener("wheel", (e: WheelEvent) => {
    e.preventDefault(); const r = v.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) { const s = Math.max(0.25, Math.min(2.2, M.scale * Math.exp(-e.deltaY * 0.01))), mx = e.clientX - r.left, my = e.clientY - r.top; M.panX = mx - ((mx - M.panX) * s) / M.scale; M.panY = my - ((my - M.panY) * s) / M.scale; M.scale = s; }
    else { M.panX -= e.deltaX; M.panY -= e.deltaY; }
    applyPlane();
  }, { passive: false });
  v.addEventListener("keydown", (e: KeyboardEvent) => {
    const g = (e.target as Element).closest?.(".mmnode"); if (!g || !M.tree || (e.key !== "Enter" && e.key !== " ")) return; e.preventDefault();
    const n = find(M.tree, Number(g.getAttribute("data-id"))); if (n) openNode(n);
  });
  new ResizeObserver(() => { if (!$("mindView").hidden && M.tree && !M.fitted) fit(); }).observe(v);
}
export type { Doc };
