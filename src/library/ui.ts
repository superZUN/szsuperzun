// 회의록 tab: upload / paste, the list (with 준비중 · 검토 필요 badges, search, two-step delete), and the reader.
import { $, armButton, download, fileSafe } from "../util";
import { S, type Doc } from "../state";
import { readFile } from "./import";
import { putDoc, delDoc, rebuildIndex, syncDocsNow, isFinal } from "./docs";
import { mdToHtml } from "../minutes/md";

export function renderDocs() {
  const box = $("docList"); if (!box) return; box.textContent = "";
  if (!S.docs.length) { const p = document.createElement("div"); p.className = "note"; p.textContent = "아직 없습니다. 회의록을 작성하거나 Plaud 회의록을 올리면 여기에 쌓이고, 회의 중에 관련 내용을 찾아 보여줍니다."; box.append(p); return; }
  const f = ($("docSearch").value || "").trim().toLowerCase();
  const list = [...S.docs].sort((a, b) => b.added - a.added).filter((d) => !f || (d.name + "\n" + d.text).toLowerCase().includes(f));
  if (!list.length) { const p = document.createElement("div"); p.className = "note"; p.textContent = "검색 결과가 없습니다."; box.append(p); return; }
  list.forEach((d) => {
    const row = document.createElement("div"); row.className = "doc"; row.dataset.id = d.id;
    const n = document.createElement("button"); n.className = "name"; n.textContent = (d.synced ? "☁ " : "") + d.name;
    if (!isFinal(d)) { const bd = document.createElement("span"); bd.className = "dbadge" + (d.status === "review" ? " review" : ""); bd.textContent = d.status === "review" ? "검토 필요" : "준비중"; n.prepend(bd); }
    n.title = "열어 보기"; n.addEventListener("click", () => openDoc(d));
    const s = document.createElement("div"); s.className = "size"; s.textContent = new Date(d.added).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }) + " · " + d.text.length.toLocaleString() + "자";
    const v = document.createElement("button"); v.textContent = "보기"; v.addEventListener("click", () => openDoc(d));
    const b = document.createElement("button"); b.textContent = "삭제"; b.className = "del"; armButton(b, "삭제", () => { delDoc(d.id); rebuildIndex(); });
    row.append(n, s, v, b);
    if (f) { const i = d.text.toLowerCase().indexOf(f); if (i >= 0) { const sn = document.createElement("div"); sn.className = "snip"; sn.textContent = "…" + d.text.slice(Math.max(0, i - 40), i + 80).replace(/\s+/g, " ") + "…"; row.append(sn); } }
    box.append(row);
  });
}
let openedDoc: Doc | null = null;
/** reader; the search word, if any, is highlighted */
export function openDoc(d: Doc) {
  openedDoc = d; $("docTitle").textContent = (d.synced ? "☁ " : "") + (isFinal(d) ? "" : d.status === "review" ? "[검토 필요] " : "[준비중] ") + d.name;
  $("docMeta").textContent = `${new Date(d.added).toLocaleString("ko-KR")} · ${d.text.length.toLocaleString()}자 · ${d.synced ? "서버에 저장됨" : "이 기기에만 저장됨"}`;
  const out = $("docOut"); out.innerHTML = mdToHtml(d.text); out.scrollTop = 0;
  const q = ($("docSearch").value || "").trim(); if (q) highlight(out, q);
  $("docSheet").hidden = false; $("docClose").focus();
}
function highlight(root: HTMLElement, q: string) {
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"); const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const nodes: Text[] = [];
  while (walk.nextNode()) nodes.push(walk.currentNode as Text);
  let first: HTMLElement | null = null;
  for (const t of nodes) {
    const s = t.nodeValue || ""; if (!re.test(s)) continue; re.lastIndex = 0; const frag = document.createDocumentFragment(); let last = 0;
    s.replace(re, (m, i) => { frag.append(s.slice(last, i)); const mk = document.createElement("mark"); mk.textContent = m; frag.append(mk); if (!first) first = mk; last = i + m.length; return m; });
    frag.append(s.slice(last)); t.replaceWith(frag);
  }
  if (first) (first as HTMLElement).scrollIntoView({ block: "center" });
}

export async function importFiles(list: File[]) {
  const msg: string[] = []; const say = (t: string) => { $("uploadMsg").textContent = [...msg, t].filter(Boolean).join(" · "); };
  for (const f of list) {
    try {
      say(f.name + " 읽는 중…"); const text = (await readFile(f, say)).slice(0, 1900000);
      if (!text) { msg.push(f.name + ": 내용이 없습니다"); continue; }
      putDoc({ id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), name: f.name.replace(/\.[^.]+$/, ""), text, added: Date.now() }); msg.push(f.name + " 저장됨");
    } catch (e: any) { msg.push(f.name + ": " + e.message); }
  }
  $("uploadMsg").textContent = msg.join(" · "); rebuildIndex();
}

export function initLibraryUI() {
  $("fileInput").addEventListener("change", (e: any) => { void importFiles([...e.target.files]); e.target.value = ""; });
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e: Event) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e: Event) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e: DragEvent) => importFiles([...(e.dataTransfer?.files || [])]));
  $("pasteSave").addEventListener("click", () => {
    const text = $("pasteText").value.trim(); if (!text) return;
    putDoc({ id: Date.now() + "-p", name: $("pasteName").value.trim() || "붙여넣은 회의록 " + new Date().toLocaleDateString("ko-KR"), text, added: Date.now() });
    $("pasteText").value = ""; $("pasteName").value = ""; rebuildIndex();
  });
  $("syncDocs").addEventListener("click", () => syncDocsNow(true));
  $("docClose").addEventListener("click", () => { $("docSheet").hidden = true; });
  $("docSearch").addEventListener("input", renderDocs);
  $("docCopy").addEventListener("click", async () => { if (!openedDoc) return; try { await navigator.clipboard.writeText(openedDoc.text); $("docMeta").textContent = "복사했습니다."; } catch { $("docMeta").textContent = "복사하지 못했습니다."; } });
  $("docSave").addEventListener("click", () => { if (openedDoc) download(fileSafe(openedDoc.name) + (/^#|\n#/.test(openedDoc.text) ? ".md" : ".txt"), openedDoc.text, "text/plain"); });
  $("docShare").addEventListener("click", async () => {
    if (!openedDoc) return;
    if ((navigator as any).share) { try { await (navigator as any).share({ title: openedDoc.name, text: openedDoc.text }); return; } catch (e: any) { if (e && e.name === "AbortError") return; } }
    try { await navigator.clipboard.writeText(openedDoc.text); $("docMeta").textContent = "공유 기능이 없어 복사했습니다."; } catch { /* nothing */ }
  });
}
