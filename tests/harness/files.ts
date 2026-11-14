// Real test documents built in Node: .docx, .pptx (with speaker notes), .xlsx (two sheets), .hwpx, and text PDFs.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const JSZip = require("../../public/vendor/jszip.min.js");

const zip = async (files: Record<string, string>) => { const z = new JSZip(); for (const [k, v] of Object.entries(files)) z.file(k, v); return Buffer.from(await z.generateAsync({ type: "uint8array" })); };

export const docx = (paras: string[]) => zip({
  "[Content_Types].xml": "<Types/>",
  "word/document.xml": `<w:document><w:body>${paras.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`,
});
export const pptx = (slides: { text: string[]; note?: string }[]) => {
  const f: Record<string, string> = { "[Content_Types].xml": "<Types/>" };
  slides.forEach((s, i) => {
    f[`ppt/slides/slide${i + 1}.xml`] = `<p:sld>${s.text.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join("")}</p:sld>`;
    if (s.note) f[`ppt/notesSlides/notesSlide${i + 1}.xml`] = `<p:notes><a:p><a:r><a:t>${s.note}</a:t></a:r></a:p><a:p><a:r><a:t>${i + 1}</a:t></a:r></a:p></p:notes>`;
  });
  return zip(f);
};
/** sheets: name -> rows of cells (strings go to sharedStrings, numbers stay numbers) */
export const xlsx = (sheets: Record<string, (string | number)[][]>) => {
  const ss: string[] = []; const si = (s: string) => { let i = ss.indexOf(s); if (i < 0) { ss.push(s); i = ss.length - 1; } return i; };
  const f: Record<string, string> = { "[Content_Types].xml": "<Types/>" };
  const names = Object.keys(sheets);
  names.forEach((n, k) => {
    f[`xl/worksheets/sheet${k + 1}.xml`] = `<worksheet><sheetData>${sheets[n].map((r, ri) => `<row r="${ri + 1}">${r.map((c) => (typeof c === "number" ? `<c><v>${c}</v></c>` : `<c t="s"><v>${si(c)}</v></c>`)).join("")}</row>`).join("")}</sheetData></worksheet>`;
  });
  f["xl/workbook.xml"] = `<workbook><sheets>${names.map((n, k) => `<sheet name="${n}" sheetId="${k + 1}"/>`).join("")}</sheets></workbook>`;
  f["xl/sharedStrings.xml"] = `<sst>${ss.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`;
  return zip(f);
};
export const hwpx = (paras: string[]) => zip({
  mimetype: "application/hwp+zip",
  "Contents/section0.xml": `<hs:sec>${paras.map((p) => `<hp:p><hp:run><hp:t>${p}</hp:t></hp:run></hp:p>`).join("")}</hs:sec>`,
});
/** a small valid PDF; each page shows its lines (ASCII, Helvetica). Empty pages = a "scanned" PDF with no text. */
export function pdf(pages: string[][]) {
  const objs: string[] = [];
  const n = pages.length, fontId = 3 + n * 2;
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${n} >>`;
  pages.forEach((lines, i) => {
    const content = lines.map((l, k) => `BT /F1 14 Tf 72 ${720 - k * 24} Td (${l.replace(/[()\\]/g, "")}) Tj ET`).join("\n");
    objs[3 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`;
    objs[4 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  objs[fontId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let out = "%PDF-1.4\n"; const offs: number[] = [];
  for (let i = 1; i < objs.length; i++) { offs[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const x = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offs.slice(1).map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return Buffer.from(out, "latin1");
}
