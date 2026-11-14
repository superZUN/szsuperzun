// Minimal Markdown → HTML for minutes and documents (headings, lists, tables, bold, code). Text is escaped first.
import { esc } from "../util";

const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
export function mdToHtml(src: string) {
  const L = src.replace(/\r/g, "").split("\n"), out: string[] = []; let list: string | null = null;
  const close = () => { if (list) { out.push("</" + list + ">"); list = null; } };
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    if (/^\s*\|/.test(l)) {
      close(); const rows: string[] = []; while (i < L.length && /^\s*\|/.test(L[i])) rows.push(L[i++]); i--;
      const cells = (r: string) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const body = rows.filter((r) => !/^[\s|:\-]+$/.test(r)); if (!body.length) continue;
      let h = "<div class=tbl><table><thead><tr>" + cells(body[0]).map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr></thead><tbody>";
      body.slice(1).forEach((r) => { h += "<tr>" + cells(r).map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>"; }); out.push(h + "</tbody></table></div>"); continue;
    }
    let m;
    if ((m = l.match(/^(#{1,3})\s+(.*)/))) { close(); const n = m[1].length; out.push(`<h${n}>${inline(m[2])}</h${n}>`); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { close(); out.push("<hr>"); continue; }
    if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push("<li>" + inline(m[1]) + "</li>"); continue; }
    if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push("<li>" + inline(m[1]) + "</li>"); continue; }
    if (!l.trim()) { close(); continue; }
    close(); out.push("<p>" + inline(l) + "</p>");
  }
  close(); return out.join("");
}
