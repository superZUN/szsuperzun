// The user's own glossary (one term per line, "용어 = 설명 · 오인식: a, b"), kept locally and on the server (/api/glossary).
import { $ } from "../util";
import { ls } from "../storage/ls";
import { server, serverApi, serverErrText, setPasscode } from "../storage/server";

export const glossary = { text: ls.get("ms.glossary"), at: Number(ls.get("ms.glossaryAt")) || 0 };
export const glossCount = () => glossary.text.split("\n").filter((l) => l.trim()).length;
function gMsg(t: string, warn?: boolean) { const m = $("glossMsg"); m.className = "hint" + (warn ? " warn" : ""); m.textContent = t; }
export function setLocalGloss(text: string, at: number) {
  glossary.text = text; glossary.at = at; ls.set("ms.glossary", text); ls.set("ms.glossaryAt", at ? String(at) : ""); $("glossary").value = text;
}
export async function pullGloss(manual: boolean) {
  if (!server.passcode) { if (manual) gMsg("서버 비밀번호를 먼저 넣어 주세요.", true); return; }
  try {
    const s = await serverApi("/api/glossary", "GET");
    if (s.updatedAt && (manual || s.updatedAt > glossary.at)) { setLocalGloss(s.text || "", s.updatedAt); gMsg("서버에서 불러왔습니다 · " + glossCount() + "개 용어"); }
    else if (manual && !s.updatedAt) gMsg("서버에 저장된 사전이 아직 없습니다.");
    else if (manual) gMsg("이미 최신입니다 · " + glossCount() + "개 용어");
  } catch (e) { if (manual) gMsg(serverErrText(e) + " 불러오지 못했습니다.", true); }
}
/** saves locally, then to the server when a passcode is set; returns a status line */
export async function storeGlossary(text: string): Promise<{ msg: string; warn?: boolean }> {
  setLocalGloss(text, Date.now());
  if (!server.passcode) return { msg: text ? glossCount() + "개 용어를 이 기기에 저장했습니다." : "사전을 비웠습니다." };
  try { const s = await serverApi("/api/glossary", "PUT", { text }); setLocalGloss(s.text, s.updatedAt); return { msg: glossCount() + "개 용어를 서버에 저장했습니다. 다른 기기에서도 불러올 수 있습니다." }; }
  catch (e) { return { msg: serverErrText(e) + " 이 기기에만 저장했습니다.", warn: true }; }
}
/** add "right · 오인식: wrong" (or extend the existing line for that term) */
export function addToGlossary(text: string, right: string, wrong: string) {
  const lines = text ? text.split("\n") : []; const key = right.toLowerCase();
  const i = lines.findIndex((l) => l.trim().split(/\s*(?:=|·|\(|:)\s*/)[0].trim().toLowerCase() === key);
  if (i >= 0) { if (!lines[i].includes(wrong)) lines[i] = /오인식\s*:/.test(lines[i]) ? lines[i] + ", " + wrong : lines[i] + " · 오인식: " + wrong; }
  else lines.push(right + " · 오인식: " + wrong);
  return lines.join("\n").trim();
}
export { gMsg };

export function initGlossaryUI(afterSave: () => void) {
  $("glossary").value = glossary.text; $("passcode").value = server.passcode;
  $("saveGloss").addEventListener("click", async () => {
    setPasscode($("passcode").value.trim());
    if (server.passcode) gMsg("서버에 저장하는 중…");
    const r = await storeGlossary($("glossary").value.trim()); gMsg(r.msg, r.warn);
    if (server.passcode && !r.warn) afterSave();
  });
  $("syncGloss").addEventListener("click", () => { setPasscode($("passcode").value.trim()); pullGloss(true); });
  if (glossary.text) gMsg(glossCount() + "개 용어 저장됨");
  void pullGloss(false);
}
