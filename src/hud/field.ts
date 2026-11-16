// The neural HUD canvas: neuron mesh, travelling signals, the reactor core, wires to the cards,
// and the frame loop that only runs fast while something moves (battery).
import { $, REDUCED } from "../util";
import { S } from "../state";
import { cfg } from "../settings/settings";
import { cards, layoutCards } from "./cards";

export const RGB: Record<string, string> = { info: "230,246,250", web: "215,184,255", term: "111,231,255", fact: "159,243,208", past: "142,197,255", ask: "230,246,250", risk: "255,181,71", answer: "111,231,255", note: "183,199,255", mark: "255,255,255", action: "124,255,178", visual: "215,184,255" };
export const F = { W: 0, H: 0, D: 1, cx: 0, cy: 0, R: 60, wide: false };
export interface Neuron { x: number; y: number; act: number; r: number }
export interface Edge { a: number; b: number; act: number; warm: number }
export let neurons: Neuron[] = [], edges: Edge[] = [];
let adj: number[][] = [], coreEdges: number[] = [], signals: { ei: number; t: number; fromA: boolean; sp: number }[] = [];
let field: HTMLElement, cv: HTMLCanvasElement, ctx: CanvasRenderingContext2D;
/** frames drawn (tests read this to check the frame rate) */
export const stats = { frames: 0 };

function drawGrid() {
  const c = $("grid"), D = Math.min(2, devicePixelRatio || 1), W = innerWidth, H = innerHeight; if (!c) return; c.width = W * D; c.height = H * D;
  const g = c.getContext("2d"); g.scale(D, D); g.fillStyle = "#020507"; g.fillRect(0, 0, W, H);
  g.fillStyle = "rgba(111,231,255,.07)"; for (let y = 12; y < H; y += 24) for (let x = 12; x < W; x += 24) g.fillRect(x, y, 1, 1);
  const v = g.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, Math.max(W, H) * 0.75); v.addColorStop(0, "rgba(20,70,85,.16)"); v.addColorStop(0.55, "rgba(2,5,7,0)"); v.addColorStop(1, "rgba(0,0,0,.55)");
  g.fillStyle = v; g.fillRect(0, 0, W, H);
}
/** canvas resolution cap: 1.5× (auto), 1× (save), 2× (full) */
export const dprCap = () => (cfg.power === "save" ? 1 : cfg.power === "full" ? 2 : 1.5);
export function layoutField(force?: boolean) {
  const r = field.getBoundingClientRect(); if (!r.width || !r.height) return;
  if (!force && Math.abs(r.width - F.W) < 1 && Math.abs(r.height - F.H) < 1) return;
  F.W = r.width; F.H = r.height; F.D = Math.min(dprCap(), devicePixelRatio || 1); cv.width = Math.round(F.W * F.D); cv.height = Math.round(F.H * F.D); cv.style.width = F.W + "px"; cv.style.height = F.H + "px";
  F.wide = F.W >= 640; F.cx = F.W / 2; F.cy = F.H / 2;
  F.R = F.wide ? Math.max(64, Math.min(F.W * 0.11, F.H * 0.2, 120)) : Math.max(46, Math.min(F.W * 0.19, F.H * 0.11, 74));
  buildMesh();
}
function buildMesh() {
  neurons = []; edges = []; coreEdges = []; signals = [];
  const { W, H, cx, cy, R, wide } = F; const rx = wide ? Math.min(W * 0.26, H * 0.95) : W * 0.48, ry = H * 0.46, want = wide ? Math.round(Math.min(140, 95 * Math.max(1, W / 1180))) : 70, minD = wide ? 30 : 26, inner = R * 1.42;
  for (let i = 0; i < want * 40 && neurons.length < want; i++) {
    const a = Math.random() * 6.283, u = Math.sqrt(Math.random()); const x = cx + Math.cos(a) * rx * u, y = cy + Math.sin(a) * ry * u;
    if (Math.hypot(x - cx, y - cy) < inner) continue; if (neurons.some((n) => Math.hypot(n.x - x, n.y - y) < minD)) continue;
    neurons.push({ x, y, act: 0, r: 0.8 + Math.random() * 0.9 });
  }
  adj = neurons.map(() => []); const seen = new Set<string>();
  neurons.forEach((n, i) => {
    const near = neurons.map((m, j) => [j, Math.hypot(m.x - n.x, m.y - n.y)] as [number, number]).filter((p) => p[0] !== i).sort((a, b) => a[1] - b[1]).slice(0, 3);
    near.forEach(([j, d]) => { if (d > minD * 3.2) return; const k = i < j ? i + "-" + j : j + "-" + i; if (seen.has(k)) return; seen.add(k); adj[i].push(edges.length); adj[j].push(edges.length); edges.push({ a: i, b: j, act: 0, warm: 0 }); });
  });
  neurons.forEach((n, i) => { if (Math.hypot(n.x - cx, n.y - cy) < inner + minD * 1.4) { adj[i].push(edges.length); coreEdges.push(edges.length); edges.push({ a: -1, b: i, act: 0, warm: 0 }); } });
}
function P(e: Edge, end: "a" | "b") {
  const i = end === "a" ? e.a : e.b; if (i >= 0) return neurons[i];
  const o = neurons[e.b], d = Math.hypot(o.x - F.cx, o.y - F.cy) || 1; return { x: F.cx + ((o.x - F.cx) / d) * F.R * 1.06, y: F.cy + ((o.y - F.cy) / d) * F.R * 1.06 };
}
export function nearestNeuron(x: number, y: number) { let bi = -1, bd = 1e9; neurons.forEach((n, i) => { const d = Math.hypot(n.x - x, n.y - y); if (d < bd) { bd = d; bi = i; } }); return bi; }
/** BFS from the core to a neuron; returns edge indices */
export function pathTo(target: number): number[] {
  if (target < 0) return []; const prev = new Map<number, number>(), q: number[] = [];
  coreEdges.forEach((ei) => { const b = edges[ei].b; if (!prev.has(b)) { prev.set(b, ei); q.push(b); } });
  while (q.length) { const n = q.shift()!; if (n === target) break; for (const ei of adj[n]) { const e = edges[ei]; const m = e.a === n ? e.b : e.a; if (m < 0 || prev.has(m)) continue; prev.set(m, ei); q.push(m); } }
  const out: number[] = []; let n = target, guard = 0;
  while (prev.has(n) && guard++ < 60) { const ei = prev.get(n)!; out.unshift(ei); const e = edges[ei]; n = e.a === n ? e.b : e.a; if (n < 0) break; }
  return out;
}
function spawnSignal(ei: number, fromA: boolean) { if (signals.length > 140 || ei == null) return; signals.push({ ei, t: 0, fromA, sp: 0.0016 + Math.random() * 0.0014 }); }
function stepSignals(dt: number) {
  if (REDUCED) return;
  const rate = S.running ? 0.6 + S.level * 9 : 0.12;
  if (Math.random() < (rate * dt) / 1000 && coreEdges.length) spawnSignal(coreEdges[Math.floor(Math.random() * coreEdges.length)], true);
  if (S.running && Math.random() < (rate * 0.4 * dt) / 1000 && edges.length) spawnSignal(Math.floor(Math.random() * edges.length), Math.random() < 0.5);
  for (const s of signals) {
    s.t += s.sp * dt; const e = edges[s.ei]; if (!e) { s.t = 2; continue; } e.act = Math.max(e.act, 0.35);
    if (s.t >= 1) { const n = s.fromA ? e.b : e.a; if (n >= 0) { neurons[n].act = 1; if (Math.random() < (S.running ? 0.5 : 0.25)) { const nx = adj[n].filter((x) => x !== s.ei); if (nx.length) { const ni = nx[Math.floor(Math.random() * nx.length)]; spawnSignal(ni, edges[ni].a === n); } } } }
  }
  signals = signals.filter((s) => s.t < 1);
}
function drawCore(t: number) {
  const { R } = F; const busyF = S.busy ? 1 : 0, on = S.running ? 1 : 0; ctx.save(); ctx.translate(F.cx, F.cy);
  const cyan = (a: number | string) => `rgba(111,231,255,${a})`;
  if (S.deepRuns > 0) { // deep search: amber radar sweep and rings reaching past the mesh
    const a0 = (t * 0.004) % 6.283, reach = Math.max(F.W, F.H) * 0.7;
    const g = ctx.createRadialGradient(0, 0, R * 0.4, 0, 0, reach); g.addColorStop(0, "rgba(255,181,71,.22)"); g.addColorStop(1, "rgba(255,181,71,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, reach, a0, a0 + 0.55); ctx.closePath(); ctx.fill();
    for (let k = 0; k < 3; k++) { const p = (t * 0.0006 + k / 3) % 1; ctx.strokeStyle = `rgba(255,181,71,${(0.45 * (1 - p)).toFixed(3)})`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(0, 0, R * 1.3 + p * reach, 0, 6.283); ctx.stroke(); }
  }
  const mf = (performance.now() - S.markFlash) / 900; // highlight: a white shockwave from the core
  if (mf >= 0 && mf < 1) { ctx.strokeStyle = `rgba(255,255,255,${(0.8 * (1 - mf)).toFixed(3)})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, R * (1 + mf * 1.2), 0, 6.283); ctx.stroke(); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(0, 0, R * (0.9 + mf * 0.7), 0, 6.283); ctx.stroke(); }
  ctx.strokeStyle = cyan(0.35); ctx.lineWidth = 1; const r0 = R * 1.3, rot0 = REDUCED ? 0 : t * 0.00006;
  for (let q = 0; q < 4; q++) { const a = rot0 + (q * Math.PI) / 2; ctx.beginPath(); ctx.arc(0, 0, r0, a - 0.28, a + 0.28); ctx.stroke(); }
  const rot1 = REDUCED ? 0 : -t * 0.00004; ctx.strokeStyle = cyan(0.45);
  for (let i = 0; i < 120; i++) { const a = rot1 + (i / 120) * 6.283, long = i % 10 === 0, len = long ? R * 0.09 : R * 0.04; ctx.lineWidth = long ? 1.2 : 0.8; ctx.beginPath(); ctx.moveTo(Math.cos(a) * R, Math.sin(a) * R); ctx.lineTo(Math.cos(a) * (R - len), Math.sin(a) * (R - len)); ctx.stroke(); }
  ctx.strokeStyle = cyan(0.18); ctx.beginPath(); ctx.arc(0, 0, R * 1.12, 0, 6.283); ctx.stroke();
  const sp = REDUCED ? 0 : t * (0.00035 + busyF * 0.0012); ctx.lineWidth = 2; ctx.strokeStyle = cyan(0.35 + on * 0.45);
  [[0, 1.4], [1.9, 0.6], [2.9, 1.1], [4.4, 0.35], [5.1, 0.7]].forEach(([s, l]) => { ctx.beginPath(); ctx.arc(0, 0, R * 0.84, s + sp, s + sp + l); ctx.stroke(); });
  ctx.lineWidth = 1; ctx.strokeStyle = cyan(0.25);
  [[0.6, 2.2], [3.5, 1.6]].forEach(([s, l]) => { ctx.beginPath(); ctx.arc(0, 0, R * 0.74, s - sp * 0.6, s - sp * 0.6 + l); ctx.stroke(); });
  if (S.busy && !REDUCED) { const a = t * 0.004; for (let i = 0; i < 14; i++) { ctx.strokeStyle = cyan((0.22 * (1 - i / 14)).toFixed(3)); ctx.lineWidth = R * 0.16; ctx.beginPath(); ctx.arc(0, 0, R * 0.58, a - i * 0.06 - 0.06, a - i * 0.06); ctx.stroke(); } }
  const bars = 96, base = R * 0.5; ctx.lineWidth = 1.2; // voice ring
  for (let i = 0; i < bars; i++) {
    const a = (i / bars) * 6.283 - Math.PI / 2; const n = on ? 0.25 + 0.75 * Math.abs(Math.sin(i * 0.9 + t * 0.006) * Math.sin(i * 0.37 - t * 0.004)) : 0; const len = 1.5 + n * S.level * R * 0.24 + on * 1.2;
    ctx.strokeStyle = cyan((0.25 + on * 0.35 + n * S.level * 0.4).toFixed(3)); ctx.beginPath(); ctx.moveTo(Math.cos(a) * base, Math.sin(a) * base); ctx.lineTo(Math.cos(a) * (base + len), Math.sin(a) * (base + len)); ctx.stroke();
  }
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, base * 0.95); g.addColorStop(0, cyan((0.1 + on * 0.12 + S.level * 0.12).toFixed(3))); g.addColorStop(1, cyan(0));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, base * 0.95, 0, 6.283); ctx.fill();
  ctx.strokeStyle = cyan(0.3); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(0, 0, base * 0.42, 0, 6.283); ctx.stroke();
  ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = S.busy ? "rgba(230,246,250,.95)" : on ? cyan(0.95) : cyan(0.45);
  ctx.font = `500 ${Math.max(9, Math.round(R * 0.12))}px "IBM Plex Mono",monospace`;
  ctx.fillText(S.deepRuns > 0 ? "DEEP SCAN" : S.busy ? "ANALYZING" : on ? "LISTENING" : "STANDBY", 0, -R * 0.06);
  ctx.fillStyle = cyan(0.5); ctx.font = `400 ${Math.max(8, Math.round(R * 0.1))}px "IBM Plex Mono",monospace`;
  const el = on ? Math.floor((Date.now() - S.startedAt) / 1000) : 0;
  ctx.fillText(on ? [(el / 3600) | 0, ((el / 60) | 0) % 60, el % 60].map((v) => String(v).padStart(2, "0")).join(":") : "--:--:--", 0, R * 0.14);
  ctx.restore();
}
function drawHUD(t: number, dt: number) {
  ctx.setTransform(F.D, 0, 0, F.D, 0, 0); ctx.clearRect(0, 0, F.W, F.H);
  const now = performance.now(), fade = Math.pow(0.985, dt / 16.7);
  for (const c of cards) if (c.cascade) {
    for (const s of c.cascade) if (!s.done && now >= s.at) { s.done = true; const e = edges[s.ei]; if (e) { e.act = 1; e.warm = c.data.type === "risk" ? 1 : 0; if (e.b >= 0) neurons[e.b].act = 1; if (e.a >= 0) neurons[e.a].act = 1; } }
    if (c.cascade.every((s) => s.done)) c.cascade = null;
  }
  ctx.lineWidth = 1;
  for (const e of edges) { const a = P(e, "a"), b = P(e, "b"); const al = 0.055 + e.act * 0.6; ctx.strokeStyle = e.warm > 0.05 && e.act > 0.1 ? `rgba(255,181,71,${al.toFixed(3)})` : `rgba(111,231,255,${al.toFixed(3)})`; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); e.act *= fade; e.warm *= fade; }
  for (const n of neurons) { const al = 0.22 + n.act * 0.78; ctx.fillStyle = `rgba(111,231,255,${al.toFixed(3)})`; const r = n.r * (1 + n.act * 0.9); ctx.fillRect(n.x - r, n.y - r, r * 2, r * 2); if (n.act > 0.25) { ctx.strokeStyle = `rgba(111,231,255,${(n.act * 0.35).toFixed(3)})`; ctx.strokeRect(n.x - r - 3, n.y - r - 3, r * 2 + 6, r * 2 + 6); } n.act *= fade; }
  for (const s of signals) {
    const e = edges[s.ei]; if (!e) continue; const a = P(e, s.fromA ? "a" : "b"), b = P(e, s.fromA ? "b" : "a");
    const x = a.x + (b.x - a.x) * s.t, y = a.y + (b.y - a.y) * s.t, tt = Math.max(0, s.t - 0.25), x0 = a.x + (b.x - a.x) * tt, y0 = a.y + (b.y - a.y) * tt;
    const g = ctx.createLinearGradient(x0, y0, x, y); g.addColorStop(0, "rgba(111,231,255,0)"); g.addColorStop(1, "rgba(200,250,255,.9)"); ctx.strokeStyle = g; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x, y); ctx.stroke();
  }
  drawCore(t);
  cards.forEach((c, i) => { // wires: neuron -> elbow -> panel
    if (!c.edgePt || c.anchor == null || !neurons[c.anchor]) return; const n = neurons[c.anchor];
    const prog = c.shown ? Math.min(1, (now - c.revealAt) / 260) : 0; if (prog <= 0) return; const rgb = RGB[c.data.type] || RGB.info, al = (i === 0 ? 0.75 : 0.35) * (c.el.classList.contains("gone") ? 0 : 1);
    ctx.strokeStyle = `rgba(${rgb},${al})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(n.x, n.y);
    const mx = n.x + (c.stub.x - n.x) * prog, my = n.y + (c.stub.y - n.y) * prog; ctx.lineTo(mx, my); if (prog >= 1) ctx.lineTo(c.edgePt.x, c.edgePt.y); ctx.stroke();
    ctx.fillStyle = `rgba(${rgb},${al})`; ctx.fillRect(n.x - 2.5, n.y - 2.5, 5, 5); ctx.strokeRect(n.x - 5.5, n.y - 5.5, 11, 11); if (prog >= 1) ctx.fillRect(c.edgePt.x - 1.5, c.edgePt.y - 1.5, 3, 3);
    if (i === 0) n.act = Math.max(n.act, 0.6);
  });
}

/* ---- frame loop: full speed only while something moves; 30 fps for speech alone; a few fps when quiet; 0 when hidden ---- */
let hotUntil = 0, frameTimer: any = 0, framePending = false, lastT = performance.now();
export function wake(ms?: number) {
  hotUntil = Math.max(hotUntil, performance.now() + (ms || 1500));
  if (frameTimer) { clearTimeout(frameTimer); frameTimer = 0; }
  if (!framePending) { framePending = true; requestAnimationFrame(frame); }
}
/** 2 = animate at full rate, 1 = speech only (30 fps), 0 = idle */
function isHot(now: number) {
  if (cfg.power === "full") return 2; if (now < hotUntil || S.busy || S.deepRuns > 0) return 2;
  for (const c of cards) if (c.cascade || !c.shown || c.dragging || Math.abs(c.tx - c.x) > 0.4 || Math.abs(c.ty - c.y) > 0.4) return 2;
  return S.level > 0.08 ? 1 : 0;
}
export const hudPaused = () => document.visibilityState !== "visible" || $("liveView").hidden || !$("board").hidden || S.standby;
function frame(t: number) {
  framePending = false; const dt = Math.min(64, t - lastT); lastT = t;
  if (hudPaused()) return; // the visibility / tab / board / wake handlers start us again
  layoutField(); if (F.W) { S.level *= Math.pow(0.96, dt / 16.7); stepSignals(dt); layoutCards(dt); drawHUD(t, dt); stats.frames++; }
  const hot = isHot(t);
  if (hot === 2 && cfg.power !== "save") { framePending = true; requestAnimationFrame(frame); }
  else if (hot === 1 && cfg.power !== "save") frameTimer = setTimeout(() => { frameTimer = 0; framePending = true; requestAnimationFrame(frame); }, 30);
  else { const idleMs = cfg.power === "save" ? (hot ? 33 : 250) : S.running ? 66 : 200; frameTimer = setTimeout(() => { frameTimer = 0; framePending = true; requestAnimationFrame(frame); }, idleMs); }
}
export function initField() {
  field = $("field"); cv = $("hud"); ctx = cv.getContext("2d")!;
  drawGrid(); addEventListener("resize", drawGrid);
  new ResizeObserver(() => layoutField()).observe(field);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") wake(); });
  new MutationObserver(() => { if (!$("liveView").hidden) wake(); }).observe($("liveView"), { attributes: true, attributeFilter: ["hidden"] });
  requestAnimationFrame(frame);
}
export const fieldEl = () => field;
