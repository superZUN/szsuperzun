// Pictures: photos (Wikipedia ko/en + Wikimedia Commons, all at once, first useful one in order of preference),
// diagrams and charts (AI writes Mermaid, drawn locally, growing line by line while it streams; one retry on a syntax error),
// and drawings (AI writes SVG; cleaned with the HTML parser and shown as <img>, where nothing in it can run).
import { S, joined } from "../state";
import { cfg } from "../settings/settings";
import { ai, aiCall, errText } from "../ai/client";
import { diagramPrompt, diagramRetry, drawingPrompt } from "../ai/prompts";
import { addNode, type NodeHandle } from "../hud/cards";
import { kwMap } from "../analysis/keywords";

export async function photoFor(q: string) {
  q = String(q || "").trim(); if (!q) return null;
  const tries = (/[가-힣]/.test(q) ? ["ko", "en"] : ["en", "ko"]).map((lang) => wikiPhoto(q, lang)); tries.push(commonsPhoto(q));
  for (const p of tries) { const r = await p; if (r) return r; } return null;
}
async function wikiPhoto(q: string, lang: string) {
  try {
    const r = await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=3&prop=pageimages&piprop=thumbnail|original&pithumbsize=640&format=json&origin=*`);
    if (!r.ok) return null; const j = await r.json(); const pages: any[] = Object.values((j.query && j.query.pages) || {}).sort((a: any, b: any) => (a.index || 0) - (b.index || 0));
    const p = pages.find((x) => x.thumbnail && !/\.svg/i.test(x.thumbnail.source) && !/logo|flag|icon/i.test(x.thumbnail.source)) || pages.find((x) => x.thumbnail && !/logo|flag|icon/i.test(x.thumbnail.source));
    if (p) return { src: p.thumbnail.source, full: p.original ? p.original.source : p.thumbnail.source, title: p.title, credit: "위키백과 · " + p.title, page: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`, kind: "photo" as const };
  } catch { /* none */ }
  return null;
}
async function commonsPhoto(q: string) {
  try {
    const r = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrlimit=4&gsrsearch=${encodeURIComponent(q + " filetype:bitmap")}&prop=imageinfo&iiprop=url&iiurlwidth=640&format=json&origin=*`);
    if (r.ok) {
      const j = await r.json(); const p: any = Object.values((j.query && j.query.pages) || {}).sort((a: any, b: any) => (a.index || 0) - (b.index || 0)).find((x: any) => x.imageinfo && x.imageinfo[0] && x.imageinfo[0].thumburl && !/logo|flag|icon/i.test(x.title));
      if (p) { const ii = p.imageinfo[0]; return { src: ii.thumburl, full: ii.url, title: p.title.replace(/^File:/, ""), credit: "Wikimedia Commons", page: ii.descriptionurl, kind: "photo" as const }; }
    }
  } catch { /* none */ }
  return null;
}
export async function showPhoto(q: string, kw: string) {
  const node = addNode({ type: "visual", title: q + " · 사진", body: "", kw, img: { pending: true, kind: "photo" } });
  const im = await photoFor(q); node.setImg(im || { error: "공개 사진을 찾지 못했습니다.", kind: "photo" }); if (im) node.setLinks([{ t: im.credit, u: im.page }]); return im;
}

/* ---------- Mermaid ---------- */
let mmdLoad: Promise<any> | null = null, mmdSeq = 0;
export function loadMermaid(): Promise<any> {
  const w = window as any; if (w.mermaid) return Promise.resolve(w.mermaid); if (mmdLoad) return mmdLoad;
  mmdLoad = new Promise((res, rej) => {
    const sc = document.createElement("script"); sc.src = "vendor/mermaid.min.js";
    sc.onload = () => {
      if (!w.mermaid) { mmdLoad = null; rej({ code: "http", message: "다이어그램 도구를 불러오지 못했습니다" }); return; }
      w.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", htmlLabels: false, theme: "base", fontFamily: "Pretendard,'Apple SD Gothic Neo','Noto Sans KR',sans-serif",
        flowchart: { htmlLabels: false, curve: "basis", padding: 10 },
        themeVariables: { darkMode: true, background: "transparent", fontSize: "15px", primaryColor: "#0b2a33", primaryTextColor: "#E6F6FA", primaryBorderColor: "#6FE7FF",
          secondaryColor: "#122a22", secondaryTextColor: "#E6F6FA", secondaryBorderColor: "#7CFFB2", tertiaryColor: "#1d1830", tertiaryTextColor: "#E6F6FA", tertiaryBorderColor: "#D7B8FF",
          lineColor: "#6FE7FF", textColor: "#E6F6FA", mainBkg: "#0b2a33", nodeBorder: "#6FE7FF", clusterBkg: "rgba(111,231,255,.06)", clusterBorder: "#2b5a66", edgeLabelBackground: "#04161b",
          actorBkg: "#0b2a33", actorBorder: "#6FE7FF", actorTextColor: "#E6F6FA", signalColor: "#6FE7FF", signalTextColor: "#E6F6FA", noteBkgColor: "#1d1830", noteTextColor: "#E6F6FA",
          pie1: "#6FE7FF", pie2: "#7CFFB2", pie3: "#D7B8FF", pie4: "#FFB547", pie5: "#FF7A9A", pie6: "#B7C7FF", pieTitleTextColor: "#E6F6FA", pieSectionTextColor: "#021014", pieLegendTextColor: "#E6F6FA" } });
      res(w.mermaid);
    };
    sc.onerror = () => { mmdLoad = null; rej({ code: "http", message: "다이어그램 도구를 불러오지 못했습니다" }); }; document.head.append(sc);
  });
  return mmdLoad;
}
export function cleanMmd(t: string) { t = String(t || ""); const m = t.match(/```(?:mermaid)?[^\n]*\n([\s\S]*?)(```|$)/); return (m ? m[1] : t).trim(); }
/** render to an SVG with a real size, returned as a data URI for <img> (no scripts run there; can be saved as PNG) */
export async function mermaidSvg(code: string) {
  const m = await loadMermaid(); await m.parse(code);
  const { svg } = await m.render("mmd" + ++mmdSeq, code);
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml"), el = doc.documentElement; const vb = (el.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0) { el.setAttribute("width", String(Math.ceil(vb[2]))); el.setAttribute("height", String(Math.ceil(vb[3]))); } el.removeAttribute("style");
  const out = new XMLSerializer().serializeToString(el); document.querySelectorAll("[id^='dmmd'],#mmd" + mmdSeq).forEach((x) => x.remove());
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(out);
}

/** what the user wants to see, decided locally in microseconds so the picture starts before any AI call */
const VIS_WORDS: Record<string, RegExp> = {
  photo: /사진|이미지|실물|생긴|생겼|외관|겉모습|photo|picture|image/i, drawing: /도면|단면도|단면|설계도|배치도|회로도|분해도|치수/,
  chart: /차트|그래프|추이도|막대\s*그래프|원\s*그래프/, diagram: /그림|다이어그램|도식|도표|구조도|흐름도|순서도|플로우|플로차트|마인드\s*맵|타임라인|시각화|한눈에|그려/,
};
const VIS_ASK = /보여|띄워|그려|찾아|보자|볼까|볼래|봐\s*줘|줘|주세요|있어\s*\??$|있나/;
export function routeVisual(q: string) { for (const k of ["photo", "drawing", "chart", "diagram"]) if (VIS_WORDS[k].test(q)) return k as "photo" | "drawing" | "chart" | "diagram"; return null; }
const VIS_STRIP = /(사진|이미지|실물|그림|다이어그램|도식|도표|도면|단면도|단면|설계도|배치도|회로도|분해도|구조도|흐름도|순서도|차트|그래프|플로우\s*차트|마인드\s*맵|타임라인)(으로|로|을|를|이|가|도|좀|이랑|하고)?|보여\s*(줘|주세요|줄래|줄\s*수\s*있어)?|띄워\s*(줘|주세요)?|그려\s*(줘|주세요|봐)?|찾아\s*(줘|봐|주세요)?|어떻게\s*생겼(어|나|는지|지)?|생긴\s*거|외관|겉모습|한눈에|시각화(해\s*줘)?|좀|한번|한\s*번|해\s*줘|주세요|볼까|보자|볼래|있어|있나|[?？!.~,]/g;
const PRON = /^(그거|이거|저거|그것|이것|저것|방금|아까|그|이|저|그런|저런)(\s*(거|것|꺼|거요))?$/;
/** the thing to show: request words, particles and fillers removed; "그거" → the latest keyword */
export function visSubject(q: string) {
  let s = q.replace(VIS_STRIP, " ").replace(/\s+/g, " ").trim().replace(/\s*(의|에\s*대한|에\s*대해|관련|에\s*관한)$/, "").trim();
  s = s.replace(/^((그럼|그러면|그리고|그래서|그런데|근데|자|음|어|아|이제|혹시|저기|일단|한번|우리)\s+)+/, "").trim();
  const w = s.split(" "); if (w.length > 5) s = w.slice(-5).join(" ");
  if (!s || s.length < 2 || PRON.test(s)) { const k = [...kwMap.values()].sort((a, b) => (b.last || b.at) - (a.last || a.at))[0]; s = k ? k.k : ""; }
  return s;
}
const visRecent = new Map<string, number>();
/** one entry point for every picture */
export function showVisual(kind: string, subject: string, ctx: string, { kw = "", title }: { kw?: string; title?: string } = {}) {
  subject = String(subject || "").trim(); if (!subject) return false;
  const key = kind + "|" + subject.toLowerCase(); if (Date.now() - (visRecent.get(key) || 0) < 30000) return false; visRecent.set(key, Date.now());
  if (kind === "photo") { void showPhoto(subject, kw); return true; }
  if (!ai.apiKey) return false;
  if (kind === "drawing") { void makeDrawing(subject, ctx, { kw, title }); return true; }
  void makeDiagram(subject, ctx, { kw, kind: kind as any, title }); return true;
}
/** spoken requests ("파우치 셀 사진 보여줘") — checked on the sentence being spoken, so it fires before the sentence ends */
const voiceVisAt: Record<string, number> = {};
export function voiceVisual(t: string) {
  if (!t || t.length > 140) return; const clauses = t.split(/(?<=[.?!])\s+|(?<=(?:줘|요|봐|까|래))\s+/);
  for (let i = clauses.length - 1; i >= 0; i--) {
    const c = clauses[i]; const kind = routeVisual(c); if (!kind || !VIS_ASK.test(c)) continue;
    if (Date.now() - (voiceVisAt[kind] || 0) < 6000) return; // the interim and the final of one sentence ask once
    const subj = visSubject(c); if (!subj) return;
    if (showVisual(kind, subj, joined().slice(-900), { title: subj })) voiceVisAt[kind] = Date.now(); return;
  }
}
export async function makeDiagram(subject: string, ctx: string, { kw = "", node, answer = "", kind = "diagram", title }: { kw?: string; node?: NodeHandle; answer?: string; kind?: "diagram" | "chart"; title?: string } = {}) {
  const n = node || addNode({ type: "visual", title: (title || subject).slice(0, 40) + (kind === "chart" ? " · 차트" : " · 다이어그램"), body: "", kw, img: { pending: true, kind: "diagram" } });
  loadMermaid().catch(() => {});
  const base = diagramPrompt({ subject, ctx, answer, kind });
  let code = "", err = "", drawing = false, lastTry = 0;
  // draw what has arrived so far, complete lines only, so the picture grows while the AI is still writing
  const partial = async (t: string) => {
    const now = performance.now(); if (drawing || now - lastTry < 280) return; const c = cleanMmd(t), cut = c.slice(0, c.lastIndexOf("\n")); if (cut.split("\n").length < 3) return;
    drawing = true; lastTry = now; try { const src = await mermaidSvg(cut); n.setImg({ src, title: subject.slice(0, 60), kind: "diagram", partial: true }); } catch { /* incomplete */ } drawing = false;
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const t = await aiCall(attempt ? base + diagramRetry(code, err) : base, { maxTokens: 700, onText: attempt ? undefined : (x) => void partial(x), kind: "visual" });
      code = cleanMmd(t); if (!code) throw new Error("빈 응답");
      while (drawing) await new Promise((r) => setTimeout(r, 30));
      const src = await mermaidSvg(code); n.setImg({ src, title: subject.slice(0, 60), kind: "diagram", code }); if (!n.data.body) n.setBody("AI가 그린 개념도입니다. 눌러서 크게 보기"); return true;
    } catch (e: any) { if (e && e.code) { n.setImg({ error: errText(e), kind: "diagram" }); return false; } err = String((e && (e.message || e.str)) || e); }
  }
  n.setImg({ error: "다이어그램을 그리지 못했습니다.", kind: "diagram" }); return false;
}
/** cleaned SVG as a data URI, or null; `final` = the whole answer has arrived */
export function svgFromText(t: string, final: boolean) {
  const i = t.indexOf("<svg"); if (i < 0) return null; let src = t.slice(i); const e = src.lastIndexOf("</svg>");
  if (e >= 0) src = src.slice(0, e + 6); else if (final) return null; else { const lt = src.lastIndexOf("<"), gt = src.lastIndexOf(">"); if (lt > gt) src = src.slice(0, lt); }
  const doc = new DOMParser().parseFromString("<body>" + src + "</body>", "text/html"), svg = doc.querySelector("svg"); if (!svg) return null;
  svg.querySelectorAll("script,foreignObject,iframe,image,use,a").forEach((x) => x.remove());
  svg.querySelectorAll("*").forEach((el) => [...el.attributes].forEach((a) => { if (/^on/i.test(a.name) || /href$/i.test(a.name)) el.removeAttribute(a.name); }));
  [...svg.attributes].forEach((a) => { if (/^on/i.test(a.name) || /href$/i.test(a.name)) svg.removeAttribute(a.name); });
  if (svg.querySelectorAll("*").length < (final ? 2 : 6)) return null;
  if (!svg.getAttribute("viewBox")) svg.setAttribute("viewBox", "0 0 800 500"); const vb = svg.getAttribute("viewBox")!.split(/[\s,]+/).map(Number);
  svg.setAttribute("width", String(vb[2] || 800)); svg.setAttribute("height", String(vb[3] || 500)); svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  if (!svg.getAttribute("font-family")) svg.setAttribute("font-family", "Pretendard,'Apple SD Gothic Neo','Noto Sans KR',sans-serif");
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
}
export async function makeDrawing(subject: string, ctx: string, { kw = "", node, title }: { kw?: string; node?: NodeHandle; title?: string } = {}) {
  const n = node || addNode({ type: "visual", title: (title || subject).slice(0, 40) + " · 도면", body: "", kw, img: { pending: true, kind: "diagram" } });
  let last = 0; const partial = (t: string) => { const now = performance.now(); if (now - last < 300) return; last = now; const src = svgFromText(t, false); if (src) n.setImg({ src, title: subject.slice(0, 60), kind: "diagram", partial: true }); };
  try {
    const t = await aiCall(drawingPrompt(subject, ctx), { maxTokens: 3000, onText: partial, kind: "visual" }); const src = svgFromText(t, true) || svgFromText(t + "</svg>", true);
    if (!src) throw new Error("bad svg"); n.setImg({ src, title: subject.slice(0, 60), kind: "diagram" }); if (!n.data.body) n.setBody("AI가 그린 개념 도면입니다. 실제 치수·구조는 확인하세요."); return true;
  } catch (e: any) { n.setImg({ error: e && e.code ? errText(e) : "도면을 그리지 못했습니다.", kind: "diagram" }); return false; }
}
/** load mermaid while the app is idle, so the first diagram is quick */
export function preloadMermaid() { setTimeout(() => { if (ai.apiKey && cfg.visOn) ((window as any).requestIdleCallback || setTimeout)(() => loadMermaid().catch(() => {})); }, 4000); void S; }
