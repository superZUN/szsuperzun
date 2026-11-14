// Cards on the HUD: creation, two-column layout, touch gestures (tap = open, double-tap = pin, drag = look, throw = dismiss),
// the detail view, the analysis log and the picture lightbox.
import { $, hostOf, safeUrl, REDUCED } from "../util";
import { S, type CardData, type CardImg } from "../state";
import { F, neurons, nearestNeuron, pathTo, wake, fieldEl } from "./field";
import { closeBoard, boardOpen } from "../board/board";

export const TYPE: Record<string, string> = { term: "용어", fact: "사실 확인", past: "지난 회의", ask: "물어볼 것", risk: "주의", answer: "답변", note: "내 메모", mark: "중요 표시", action: "할 일", info: "맥락", web: "검색", visual: "그림" };
export const CODE: Record<string, string> = { term: "DEF", fact: "VERIFY", past: "RECALL", ask: "PROBE", risk: "ALERT", answer: "RESPONSE", note: "MEMO", mark: "★ MARK", action: "ACTION", info: "CONTEXT", web: "WEB", visual: "VISUAL" };

export interface Card {
  data: CardData; el: HTMLElement; titleEl: HTMLElement; bodyEl: HTMLElement; x: number; y: number; w: number; h: number; tx: number; ty: number;
  born: number; cascade: { ei: number; at: number; done?: boolean }[] | null; revealAt: number; shown: boolean; edgePt: any; stub: any; anchor: number | null;
  col: number | null; side?: string; pin: { x: number; y: number } | null; dragging?: boolean;
}
export const cards: Card[] = [];
export let focusItem: CardData | null = null;

const GLYPHS = "▖▗▘▙▚▛▜▝▞▟░▒<>/\\=+*#01";
/** title "decodes" from glyphs in at most 260 ms; the card itself is visible at once */
function decode(el: HTMLElement, text: string) {
  if (REDUCED) { el.textContent = text; return; } const t0 = performance.now(), dur = Math.min(260, 90 + text.length * 6);
  (function step(now: number) {
    const p = Math.min(1, (now - t0) / dur), k = Math.floor(text.length * p); let s = text.slice(0, k);
    for (let i = k; i < text.length; i++) s += text[i] === " " ? " " : GLYPHS[(Math.random() * GLYPHS.length) | 0];
    el.textContent = s; if (p < 1) requestAnimationFrame(step);
  })(t0);
}
function cardDOM(data: CardData) {
  const el = document.createElement("button"); el.type = "button"; el.className = "callout t-" + data.type + (data.example ? " example" : ""); el.dataset.id = String(data.id);
  const hd = document.createElement("div"); hd.className = "hd";
  const code = document.createElement("span"); code.className = "code"; code.textContent = CODE[data.type];
  const ko = document.createElement("span"); ko.className = "ko"; ko.textContent = TYPE[data.type];
  const tm = document.createElement("span"); tm.className = "tm"; tm.textContent = data.example ? "SAMPLE" : data.time; hd.append(code, ko, tm);
  const title = document.createElement("div"); title.className = "title";
  const body = document.createElement("div"); body.className = "body"; body.textContent = data.body;
  el.append(hd); if (data.title) el.append(title); el.append(body);
  const vis = document.createElement("span"); el.append(vis); const setImg = () => visFill(vis, data, false); setImg();
  const src = document.createElement("div"); src.className = "src"; el.append(src);
  const setSrc = () => {
    const parts: string[] = []; if (data.source) parts.push(data.source);
    (data.links || []).slice(0, 3).forEach((l) => { const h = hostOf(l.u); if (h && !parts.includes(h)) parts.push(h); });
    src.textContent = parts.length ? "SRC // " + parts.join(" · ") : ""; src.hidden = !parts.length;
  };
  setSrc();
  // keyboard / example cards open on click; touch and mouse go through the gesture handler
  el.addEventListener("click", (e) => { if ((el as any)._ptr && e.detail !== 0) return; openFocus(data); });
  if (data.deep) el.classList.add("deepdone");
  return { el, title, body, setSrc, setImg, code };
}

export interface NodeHandle { data: CardData; setBody(t: string): void; setLinks(l: { t: string; u: string }[]): void; setImg(img: CardImg | null): void; setDeep(on: boolean): void }
export function addNode(raw: Partial<CardData> & { type: string }, opts: { restore?: boolean; example?: boolean; back?: boolean } = {}): NodeHandle {
  const type = TYPE[raw.type] ? raw.type : "fact";
  const data: CardData = opts.restore ? (raw as CardData) : {
    id: ++S.seq, type, title: raw.title || "", body: raw.body || "", source: raw.source || "", links: raw.links || [], kw: raw.kw || "", img: raw.img || null, example: !!opts.example,
    time: new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  };
  if (opts.restore) S.seq = Math.max(S.seq, data.id || 0);
  if (!opts.example) {
    cards.filter((c) => c.data.example).forEach(retire);
    if (!opts.restore) { S.history.unshift(data); $("announce").textContent = TYPE[type] + ": " + (data.title || data.body); }
    $("histCount").textContent = S.history.length;
  }
  const d = cardDOM(data); fieldEl().append(d.el);
  const c: Card = { data, el: d.el, titleEl: d.title, bodyEl: d.body, x: NaN, y: NaN, w: 0, h: 0, tx: 0, ty: 0, born: performance.now(), cascade: null, revealAt: 0, shown: false, edgePt: null, stub: null, anchor: null, col: null, pin: null };
  if (opts.back) cards.push(c); else cards.unshift(c);
  S.level = Math.max(S.level, 0.6); if (!opts.example) makeDraggable(c); wake(2500);
  return {
    data,
    setBody(t) { data.body = t; c.bodyEl.textContent = t; if (focusItem === data) renderFocus(); },
    setLinks(l) { data.links = l; d.setSrc(); if (focusItem === data) renderFocus(); },
    setImg(img) { data.img = img; d.setImg(); if (focusItem === data) renderFocus(); },
    setDeep(on) { data.deep = true; c.el.classList.toggle("deep", on); c.el.classList.toggle("deepdone", !on); d.code.textContent = on ? "DEEP SCAN" : "RESPONSE · WIDE"; wake(1500); },
  };
}
export function retire(c: Card) { const i = cards.indexOf(c); if (i >= 0) cards.splice(i, 1); c.el.classList.add("gone"); c.el.style.pointerEvents = "none"; setTimeout(() => c.el.remove(), 350); }
export function clearCards() { cards.slice().forEach(retire); }

/** live cards: drag to look (springs back), throw to dismiss (another card takes its place), double-tap to pin where it is */
function makeDraggable(c: Card) {
  const el = c.el as any; el._ptr = true; let sx = 0, sy = 0, ox = 0, oy = 0, id: number | null = null, moved = false, trail: { x: number; y: number; t: number }[] = [], tapT: any = 0, lastTap = 0;
  el.addEventListener("pointerdown", (e: PointerEvent) => { if (e.button > 0) return; id = e.pointerId; sx = e.clientX; sy = e.clientY; ox = c.x; oy = c.y; moved = false; trail = [{ x: e.clientX, y: e.clientY, t: performance.now() }]; });
  el.addEventListener("pointermove", (e: PointerEvent) => {
    if (e.pointerId !== id) return; const now = performance.now(); trail.push({ x: e.clientX, y: e.clientY, t: now }); while (trail.length > 2 && now - trail[0].t > 90) trail.shift();
    const dx = e.clientX - sx, dy = e.clientY - sy; if (!moved && Math.hypot(dx, dy) < 8) return;
    if (!moved) { moved = true; clearTimeout(tapT); try { el.setPointerCapture(id); } catch { /* gone */ } el.classList.add("dragging"); c.dragging = true; }
    c.x = ox + dx; c.y = oy + dy; if (c.pin) c.pin = { x: c.x, y: c.y }; c.anchor = null; wake();
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return; id = null;
    if (moved) {
      el._drag = Date.now(); el.classList.remove("dragging"); c.dragging = false;
      const a = trail[0], z = trail[trail.length - 1], dt = Math.max(1, z.t - a.t), vx = (z.x - a.x) / dt, vy = (z.y - a.y) / dt;
      const sp = performance.now() - z.t > 90 ? 0 : Math.hypot(vx, vy); // a finger that stopped before lifting is not a throw
      if (e.type !== "pointercancel" && sp > 0.7 && Math.hypot(c.x - ox, c.y - oy) > 30) { flingCard(c, vx, vy); return; }
      wake(); return; // not thrown: glides back to its place (or stays, if pinned)
    }
    const now = Date.now(); if (now - lastTap < 320) { clearTimeout(tapT); lastTap = 0; togglePin(c); return; }
    lastTap = now; tapT = setTimeout(() => { lastTap = 0; openFocus(c.data); }, 300);
  };
  el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
}
export function togglePin(c: Card) {
  if (c.pin) { unpin(c); return; }
  const pins = cards.filter((x) => x.pin && x !== c); if (pins.length >= 4) unpin(pins[pins.length - 1]); // at most 4 pinned
  c.pin = { x: c.x, y: c.y }; c.el.classList.add("pinned"); wake();
}
/** thrown away: flies off in the direction of the throw; the most recent card not on screen comes back (it stays in the history) */
function flingCard(c: Card, vx: number, vy: number) {
  const i = cards.indexOf(c); if (i >= 0) cards.splice(i, 1); c.data.dismissed = true;
  const sp = Math.hypot(vx, vy) || 1, dist = Math.max(F.W, F.H) * 1.2, tx = c.x + (vx / sp) * dist, ty = c.y + (vy / sp) * dist, rot = Math.max(-25, Math.min(25, vx * 12));
  const el = c.el; el.style.pointerEvents = "none"; el.style.transition = "transform .38s cubic-bezier(.2,.7,.3,1),opacity .38s"; el.classList.add("flung");
  requestAnimationFrame(() => { el.style.transform = `translate3d(${tx.toFixed(0)}px,${ty.toFixed(0)}px,0) rotate(${rot.toFixed(0)}deg)`; el.style.opacity = "0"; });
  setTimeout(() => el.remove(), 420);
  const onScreen = new Set(cards.map((x) => x.data)), max = F.wide ? 6 : 4;
  if (cards.filter((x) => !x.pin).length < max) { const next = S.history.find((d) => !d.dismissed && !d.example && !onScreen.has(d)); if (next) addNode(next, { restore: true, back: true }); }
  wake(1500);
}
export function unpin(c: Card) { c.pin = null; c.col = null; c.anchor = null; c.el.classList.remove("pinned"); wake(); }

export function layoutCards(dt: number) {
  const { W, cx, cy, R, wide } = F; const max = wide ? 6 : 4; const free = cards.filter((c) => !c.pin);
  while (free.length > max) retire(free.pop()!);
  const k = Math.min(1, dt * 0.012), colW = wide ? Math.min(340, W * 0.29) : Math.min(W - 8, 460);
  cards.forEach((c, i) => { c.el.classList.toggle("compact", i >= 2); c.el.classList.toggle("lead", i === 0); if (c.el.style.width !== colW + "px") c.el.style.width = colW + "px"; c.w = colW; c.h = c.el.offsetHeight; });
  for (const c of cards) if (c.pin) { c.tx = c.pin.x; c.ty = c.pin.y; c.side = wide ? (c.pin.x + c.w / 2 < cx ? "L" : "R") : c.pin.y + c.h / 2 < cy ? "T" : "B"; }
  // each card keeps its column for life; a new one joins the emptier column
  for (let i = cards.length - 1; i >= 0; i--) { const c = cards[i]; if (c.pin) continue; if (c.col == null) { const n0 = cards.filter((x) => x.col === 0).length, n1 = cards.filter((x) => x.col === 1).length; c.col = n0 <= n1 ? 0 : 1; } }
  const A = cards.filter((c) => c.col === 0 && !c.pin), B = cards.filter((c) => c.col === 1 && !c.pin);
  if (wide) {
    const place = (list: Card[], x: number) => { const tot = list.reduce((s, c) => s + c.h, 0) + 12 * (list.length - 1); let y = Math.max(6, cy - tot / 2); list.forEach((c) => { c.tx = x; c.ty = y; c.side = x < cx ? "L" : "R"; y += c.h + 12; }); };
    place(A, 10); place(B, W - 10 - colW);
  } else {
    const x = (W - colW) / 2; let y = cy - R * 1.3 - 10; A.forEach((c) => { y -= c.h; c.tx = x; c.ty = y; c.side = "T"; y -= 10; });
    y = cy + R * 1.3 + 10; B.forEach((c) => { c.tx = x; c.ty = y; c.side = "B"; y += c.h + 10; });
  }
  for (const c of cards) {
    if (Number.isNaN(c.x)) { c.x = c.tx; c.y = c.ty + (c.side === "T" ? -8 : 8); }
    if (!c.dragging) { c.x += (c.tx - c.x) * k; c.y += (c.ty - c.y) * k; }
    c.el.style.transform = `translate3d(${c.x.toFixed(1)}px,${c.y.toFixed(1)}px,0)`;
    if (c.side === "L") c.edgePt = { x: c.x + c.w, y: c.y + 15 }; else if (c.side === "R") c.edgePt = { x: c.x, y: c.y + 15 };
    else { const ax = Math.min(c.x + c.w - 24, Math.max(c.x + 24, cx + (c.side === "T" ? -1 : 1) * c.w * 0.22)); c.edgePt = { x: ax, y: c.side === "T" ? c.y + c.h : c.y }; }
    c.stub = c.side === "L" ? { x: c.edgePt.x + 14, y: c.edgePt.y } : c.side === "R" ? { x: c.edgePt.x - 14, y: c.edgePt.y } : c.side === "T" ? { x: c.edgePt.x, y: c.edgePt.y + 10 } : { x: c.edgePt.x, y: c.edgePt.y - 10 };
    if (c.anchor == null || !neurons[c.anchor]) { // fire a cascade from the core to the neuron nearest this panel
      const tx = c.stub.x + (cx - c.stub.x) * 0.15, ty = c.stub.y + (cy - c.stub.y) * 0.15; c.anchor = nearestNeuron(tx, ty);
      const path = pathTo(c.anchor).slice(-6); const now = performance.now(); c.cascade = path.map((ei, j) => ({ ei, at: now + j * 18 }));
      c.revealAt = now + (REDUCED ? 0 : 30); if (c.shown) c.revealAt = now;
    } else {
      const n = neurons[c.anchor]; const wrongSide = wide ? (n.x - cx) * (c.stub.x - cx) < 0 : (n.y - cy) * (c.stub.y - cy) < 0;
      if (wrongSide || Math.hypot(n.x - c.stub.x, n.y - c.stub.y) > Math.max(F.W, F.H) * 0.35) c.anchor = nearestNeuron(c.stub.x + (cx - c.stub.x) * 0.15, c.stub.y + (cy - c.stub.y) * 0.15);
    }
    if (!c.shown && performance.now() >= c.revealAt) { c.shown = true; c.el.classList.add("in"); if (c.data.title) decode(c.titleEl, c.data.title); }
  }
}

/* ---------------- detail view, log, pictures ---------------- */
export function fill(el: HTMLElement, d: CardData, withTime: boolean) {
  el.textContent = ""; const hd = document.createElement("div"); hd.className = "hd";
  const code = document.createElement("span"); code.className = "code"; code.textContent = CODE[d.type]; const ko = document.createElement("span"); ko.textContent = TYPE[d.type]; hd.append(code, ko);
  if (withTime) { const tm = document.createElement("span"); tm.textContent = d.example ? "SAMPLE" : d.time; hd.append(tm); }
  el.append(hd); if (d.title) { const h = document.createElement("div"); h.className = "title"; h.textContent = d.title; el.append(h); }
  const b = document.createElement("div"); b.className = "body"; b.textContent = d.body; el.append(b);
  if (d.img) { const v = document.createElement("div"); visFill(v, d, true); el.append(v); }
  if (d.source) { const s = document.createElement("div"); s.className = "src"; s.textContent = "SRC // " + d.source; el.append(s); }
  if (d.links && d.links.length) el.append(linkList(d.links));
}
export function linkList(links: { t: string; u: string }[]) {
  const box = document.createElement("div"); box.className = "links";
  links.slice(0, 5).forEach((l) => { const u = safeUrl(l.u); if (!u) return; const a = document.createElement("a"); a.href = u; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = "↗ " + (l.t || hostOf(u)); box.append(a); });
  return box;
}
export function renderFocus() {
  const c = $("focusCard"), d = focusItem!; c.className = "focus t-" + d.type; fill(c, d, true);
  const row = document.createElement("div"); row.className = "row"; row.style.justifyContent = "flex-end";
  const live = cards.find((x) => x.data === d);
  if (live && live.pin) { const b = document.createElement("button"); b.textContent = "고정 해제"; b.addEventListener("click", () => { unpin(live); closeFocus(); }); row.append(b); }
  if (!live && boardOpen()) { const b = document.createElement("button"); b.textContent = "화면에 다시 띄우기"; b.addEventListener("click", () => { closeFocus(); closeBoard(); addNode({ ...d, id: undefined, time: undefined } as any, {}); }); row.append(b); }
  const close = document.createElement("button"); close.textContent = "닫기"; close.addEventListener("click", closeFocus); row.append(close); c.append(row); close.focus();
}
export function openFocus(d: CardData) { focusItem = d; $("focusVeil").hidden = false; renderFocus(); }
export function closeFocus() { focusItem = null; $("focusVeil").hidden = true; }
export function setFocusItem(d: CardData | null) { focusItem = d; }
export function openHist() {
  const list = $("histList"); list.textContent = "";
  if (!S.history.length) { const p = document.createElement("div"); p.className = "note"; p.textContent = "아직 분석 결과가 없습니다."; list.append(p); }
  S.history.forEach((d) => { const it = document.createElement("div"); it.className = "hitem t-" + d.type; fill(it, d, true); list.append(it); });
  $("histSheet").hidden = false; $("histClose").focus();
}
export function visFill(box: HTMLElement, d: { img: CardImg | null; title?: string }, big: boolean) {
  box.textContent = ""; const im = d.img; box.className = "vis"; box.hidden = !im; if (!im) return;
  if (im.pending || im.error) { box.classList.add("wait"); box.textContent = im.error || "VISUAL // 그리는 중…"; return; }
  const img = document.createElement("img"); img.alt = im.title || d.title || "그림"; img.loading = "lazy"; img.decoding = "async"; img.referrerPolicy = "no-referrer"; img.src = im.src || "";
  img.addEventListener("error", () => { box.classList.add("wait"); box.textContent = "그림을 불러오지 못했습니다."; }); box.append(img);
  if (im.credit || im.kind === "diagram") { const c = document.createElement("span"); c.className = "cap"; c.textContent = im.kind === "diagram" ? "AI 다이어그램 · 확인 필요" : im.credit || ""; box.append(c); }
  if (big) img.addEventListener("click", (e) => { e.stopPropagation(); openLightbox(im); });
}
let lbCur: CardImg | null = null;
export function openLightbox(im: CardImg) {
  lbCur = im; $("lbTitle").textContent = im.title || ""; const box = $("lbImg"); box.textContent = ""; box.classList.remove("zoom");
  const img = document.createElement("img"); img.alt = im.title || "그림"; img.referrerPolicy = "no-referrer"; img.src = im.full || im.src || ""; box.append(img);
  const o = $("lbOpen"); o.hidden = !im.page; if (im.page) o.href = im.page; $("lbSave").hidden = im.kind !== "diagram";
  $("lightbox").hidden = false; $("lbClose").focus();
}
/** a picture at twice its size as PNG */
export function savePng(im: CardImg) {
  const img = new Image();
  img.onload = () => {
    const k = 2, cv = document.createElement("canvas"); cv.width = Math.max(1, img.naturalWidth * k); cv.height = Math.max(1, img.naturalHeight * k);
    const g = cv.getContext("2d")!; g.fillStyle = "#04161b"; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(img, 0, 0, cv.width, cv.height);
    cv.toBlob((b) => { if (!b) return; const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = (im.title || "diagram").replace(/[\\/:*?"<>|]+/g, " ").slice(0, 60) + ".png"; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); }, "image/png");
  };
  img.src = im.src || "";
}
export function initCardsUI() {
  $("focusVeil").addEventListener("click", (e: Event) => { if (e.target === $("focusVeil")) closeFocus(); });
  $("histClose").addEventListener("click", () => { $("histSheet").hidden = true; });
  $("lbClose").addEventListener("click", () => { $("lightbox").hidden = true; });
  $("lbZoom").addEventListener("click", () => { const b = $("lbImg"); b.classList.toggle("zoom"); $("lbZoom").textContent = b.classList.contains("zoom") ? "맞춤" : "확대"; });
  $("lbImg").addEventListener("dblclick", () => $("lbZoom").click());
  $("lbSave").addEventListener("click", () => { if (lbCur) savePng(lbCur); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("lightbox").hidden) { $("lightbox").hidden = true; return; }
    if ($("focusVeil").hidden && $("histSheet").hidden) closeBoard();
    closeFocus(); ["histSheet", "minSheet", "docSheet", "actSheet", "chkSheet"].forEach((id) => { $(id).hidden = true; });
  });
}
