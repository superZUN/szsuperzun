// Reading uploaded files: PDF (pdf.js), Word .docx, PowerPoint .pptx (+ speaker notes), Excel .xlsx, 한글 .hwpx,
// plain text / Markdown / CSV / TSV, subtitles (SRT/VTT, timestamps removed). Parsers load on first use from /vendor.

export function cleanSubs(t: string) {
  return t.replace(/^\d+\s*$/gm, "").replace(/^[\d:.,]+\s*-->\s*[\d:.,]+.*$/gm, "").replace(/^WEBVTT.*$/m, "").replace(/\n{3,}/g, "\n\n").trim();
}
const scriptLoads: Record<string, Promise<any>> = {};
export function loadScript(src: string, g: string): Promise<any> {
  const w = window as any; if (w[g]) return Promise.resolve(w[g]);
  return scriptLoads[src] || (scriptLoads[src] = new Promise((res, rej) => {
    const sc = document.createElement("script"); sc.src = src;
    const fail = () => { delete scriptLoads[src]; rej(new Error("파일 해석 도구를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.")); };
    sc.onload = () => (w[g] ? res(w[g]) : fail()); sc.onerror = fail; document.head.append(sc);
  }));
}
export const xmlDecode = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");
/** text of the runs <tag>…</tag>, one line per paragraph </para> */
function xmlRuns(xml: string, run: string, para: string) {
  const out: string[] = [];
  for (const p of xml.split(new RegExp("</" + para + ">"))) {
    const t = [...p.matchAll(new RegExp("<" + run + "(?:\\s[^>]*)?>([^<]*)</" + run + ">", "g"))].map((m) => m[1]).join("");
    if (t.trim()) out.push(xmlDecode(t));
  }
  return out.join("\n");
}
const numOf = (n: string) => +((n.match(/(\d+)\.xml$/) || [])[1] || 0);
const readZip = async (f: Blob) => (await loadScript("vendor/jszip.min.js", "JSZip")).loadAsync(f);

export async function readFile(f: File, progress?: (t: string) => void): Promise<string> {
  const n = f.name.toLowerCase();
  if (n.endsWith(".docx")) {
    const zip = await readZip(f); const x = zip.file("word/document.xml"); if (!x) throw new Error("Word 문서 형식이 아닙니다.");
    return xmlDecode((await x.async("string")).replace(/<\/w:p>/g, "\n").replace(/<w:tab\/>/g, " ").replace(/<w:br\/>/g, "\n").replace(/<[^>]+>/g, "")).replace(/\n{3,}/g, "\n\n").trim();
  }
  if (n.endsWith(".pptx")) {
    const zip = await readZip(f); const slides = Object.keys(zip.files).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => numOf(a) - numOf(b));
    if (!slides.length) throw new Error("PowerPoint 형식이 아닙니다."); const out: string[] = [];
    for (const k of slides) {
      const i = numOf(k); let t = xmlRuns(await zip.file(k).async("string"), "a:t", "a:p");
      const note = zip.file(`ppt/notesSlides/notesSlide${i}.xml`); if (note) { const nt = xmlRuns(await note.async("string"), "a:t", "a:p").replace(/^\d+$/gm, "").trim(); if (nt) t += "\n(노트) " + nt; }
      if (t.trim()) out.push(`## 슬라이드 ${i}\n${t.trim()}`);
    }
    return out.join("\n\n");
  }
  if (n.endsWith(".xlsx")) {
    const zip = await readZip(f); const ssF = zip.file("xl/sharedStrings.xml");
    const ss: string[] = ssF ? (await ssF.async("string")).split("</si>").slice(0, -1).map((si: string) => xmlDecode([...si.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => m[1]).join(""))) : [];
    const wb = zip.file("xl/workbook.xml") ? await zip.file("xl/workbook.xml").async("string") : ""; const names = [...wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => xmlDecode(m[1]));
    const sheets = Object.keys(zip.files).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => numOf(a) - numOf(b)); const out: string[] = [];
    for (const [si, k] of sheets.entries()) {
      const xml: string = await zip.file(k).async("string"); const rows: string[] = [];
      for (const r of xml.split("</row>").slice(0, 3000)) {
        const cells = [...r.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((m) => {
          const a = m[1], inner = m[2] || ""; const v = (inner.match(/<v>([^<]*)<\/v>/) || [])[1];
          if (/t="s"/.test(a)) return v != null ? ss[+v] || "" : "";
          if (/t="inlineStr"/.test(a)) return xmlDecode([...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((x) => x[1]).join(""));
          return v != null ? xmlDecode(v) : "";
        });
        if (cells.some((c) => String(c).trim())) rows.push(cells.join(" | "));
      }
      if (rows.length) out.push(`## 시트: ${names[si] || "시트 " + (si + 1)}\n${rows.join("\n")}`);
    }
    if (!out.length) throw new Error("Excel 파일에서 내용을 찾지 못했습니다."); return out.join("\n\n");
  }
  if (n.endsWith(".hwpx")) {
    const zip = await readZip(f); const secs = Object.keys(zip.files).filter((k) => /^Contents\/section\d+\.xml$/i.test(k)).sort((a, b) => numOf(a) - numOf(b));
    if (!secs.length) throw new Error("한글(HWPX) 형식이 아닙니다."); const out: string[] = [];
    for (const k of secs) out.push(xmlRuns(await zip.file(k).async("string"), "hp:t", "hp:p"));
    return out.join("\n").trim();
  }
  if (n.endsWith(".hwp")) throw new Error("HWP는 읽을 수 없습니다. 한글에서 '다른 이름으로 저장 → HWPX 또는 PDF'로 저장해 올려 주세요.");
  if (n.endsWith(".pdf")) {
    const lib = await loadScript("vendor/pdf.min.js", "pdfjsLib"); lib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
    const pdf = await lib.getDocument({ data: new Uint8Array(await f.arrayBuffer()), isEvalSupported: false }).promise; const out: string[] = []; let chars = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i); const tc = await page.getTextContent(); let line = "", lastY: number | null = null; const lines: string[] = [];
      for (const it of tc.items) {
        const y = it.transform ? Math.round(it.transform[5]) : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) { lines.push(line); line = ""; }
        line += it.str; if (it.hasEOL) { lines.push(line); line = ""; } lastY = y;
      }
      lines.push(line); const t = lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n"); chars += t.length;
      if (t) out.push(`## ${i}쪽\n${t}`); progress && progress(`${f.name} 읽는 중… ${i}/${pdf.numPages}쪽`); page.cleanup();
    }
    pdf.destroy(); if (chars < pdf.numPages * 15) throw new Error("글자가 없는 스캔 PDF 같습니다. 글자를 선택할 수 있는 PDF로 다시 저장해 주세요.");
    return out.join("\n\n");
  }
  if (/\.(png|jpe?g|heic|gif|webp)$/.test(n)) throw new Error("사진은 아직 읽을 수 없습니다. 문서 파일(PDF·Word 등)로 올려 주세요.");
  let t = await f.text(); if (n.endsWith(".srt") || n.endsWith(".vtt")) t = cleanSubs(t); return t.trim();
}
