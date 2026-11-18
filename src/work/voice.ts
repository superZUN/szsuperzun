// Voice commands: a sentence that starts with "Jay"/"제이" while listening —
//   "제이, 금요일까지 견적서 보내기 할 일에 추가해 줘" → 할 일 (담당·기한 read from the sentence)
//   "제이, 이거 메모해 둬" / "제이, 샘플 수량 300개 메모"  → 메모 (just "이거" = the sentence said before)
//   "제이, 오늘 할 일 뭐야?"                               → a question (answered on a card)
import { S, segText, type Seg } from "../state";
import { cfg } from "../settings/settings";
import { addNode } from "../hud/cards";
import { addAction, actionLine } from "../meeting/actions";
import { logLine } from "../memory/daylog";
import { updateEndBar } from "../minutes/minutes";
import { ask } from "../qa/ask";

const WAKE = /^\s*(?:헤이|hey|오케이|ok)?\s*(?:jay|제이|재이|쩨이|J)(?:\s*(?:야|아|씨|님))?\s*[,.!~?]?\s+(.+)$/i;
const TASK_CMD = /\s*(?:을|를)?\s*(?:(?:할\s*일|투두|to-?do)\s*(?:에|로|으로|목록에)?\s*(?:추가|넣어|등록|적어)\S*(?:\s*(?:줘|줄래|주세요|줘요|둬|놔))?|(?:추가|등록)\s*(?:해\s*(?:줘|줄래|주세요|줘요|둬)|하기|해))\s*[.!?~]*\s*$/i;
const MEMO_CMD = /\s*(?:을|를)?\s*(?:메모\s*(?:해|좀\s*해|로\s*남겨|에\s*적어|해\s*둬|해\s*놔)?\S*(?:\s*(?:줘|둬|놔|주세요))?|기억해\s*(?:줘|둬|놔)?|적어\s*(?:줘|둬|놔)|남겨\s*(?:줘|둬))\s*[.!?~]*\s*$/i;
const FILLER = /^(?:이거|이것|그거|그것|저거|방금|방금\s*거|방금\s*말|지금\s*말|지금\s*거|이\s*내용|그\s*내용|이\s*말|그\s*말)?\s*(?:한\s*거|한\s*것|말한\s*거|이야기|얘기)?\s*$/;
const WD: Record<string, number> = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const md = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;

/** "금요일까지", "다음 주 화요일까지", "내일까지", "모레", "11월 20일까지", "11/20까지", "20일까지" → { due: "M/D", rest } */
export function extractDue(s: string, now = new Date()) {
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate()); let m: RegExpMatchArray | null; let due = "", hit = "";
  const add = (n: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + n);
  if ((m = s.match(/(다음\s*주|담주|이번\s*주)?\s*([월화수목금토일])요일\s*(?:까지|중에?|에)?/))) {
    const target = WD[m[2]], today = base.getDay(); let n = (target - today + 7) % 7;
    if (m[1] && /다음|담/.test(m[1])) { const mon = (today + 6) % 7; n = 7 - mon + ((target + 6) % 7); }
    due = md(add(n)); hit = m[0];
  } else if ((m = s.match(/(오늘|내일|모레|글피)\s*(?:까지|중에?|안에)?/))) { due = md(add({ 오늘: 0, 내일: 1, 모레: 2, 글피: 3 }[m[1]]!)); hit = m[0]; }
  else if ((m = s.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*(?:까지|에)?/)) || (m = s.match(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])\s*(?:까지|에)?/))) { due = `${+m[1]}/${+m[2]}`; hit = m[0]; }
  else if ((m = s.match(/(?<![\d월/])(\d{1,2})\s*일\s*까지/))) { let d = new Date(base.getFullYear(), base.getMonth(), +m[1]); if (d < base) d = new Date(base.getFullYear(), base.getMonth() + 1, +m[1]); due = md(d); hit = m[0]; }
  else if ((m = s.match(/이번\s*주\s*(?:까지|안에|중에?)/))) { due = md(add((5 - base.getDay() + 7) % 7)); hit = m[0]; }
  return { due, rest: hit ? s.replace(hit, " ").replace(/\s+/g, " ").trim() : s.trim() };
}
/** "박지은 님이 …", "김민수 책임한테 …", "… 담당은 박지은" → owner */
export function extractOwner(s: string) {
  let m = s.match(/^([가-힣]{2,4})\s*(님|씨|책임|선임|수석|매니저|프로|팀장|과장|차장|부장|대리|주임|사원)?\s*(?:이|가|께서|한테|에게|이랑|하고)\s+/);
  if (m && (m[2] || /한테|에게|께서/.test(m[0]))) return { owner: m[1] + (m[2] && m[2] !== "님" && m[2] !== "씨" ? " " + m[2] : ""), rest: s.slice(m[0].length).trim() };
  m = s.match(/\s*,?\s*담당(?:은|는|자는)?\s*([가-힣]{2,4})(?:\s*님)?\s*$/);
  if (m) return { owner: m[1], rest: s.slice(0, m.index).trim() };
  return { owner: "", rest: s.trim() };
}
export type VoiceCmd = { kind: "task"; text: string; owner: string; due: string } | { kind: "memo"; text: string } | { kind: "ask"; q: string };
export function parseCommand(t: string, prev = ""): VoiceCmd | null {
  const w = t.match(WAKE); if (!w) return null; const body = w[1].trim(); if (body.length < 2) return null;
  if (TASK_CMD.test(body)) {
    let rest = body.replace(TASK_CMD, "").trim(); if (FILLER.test(rest)) rest = prev.trim();
    const d = extractDue(rest), o = extractOwner(d.rest); const text = o.rest.replace(/^(?:그럼|그러면|음|어)\s*/, "").replace(/[,.\s]+$/, "").trim();
    return text.length >= 2 ? { kind: "task", text, owner: o.owner, due: d.due } : null;
  }
  if (MEMO_CMD.test(body)) {
    let text = body.replace(MEMO_CMD, "").trim(); if (FILLER.test(text)) text = prev.trim();
    return text.length >= 2 ? { kind: "memo", text } : null;
  }
  return { kind: "ask", q: body.replace(/[.\s]+$/, "") };
}
/** called for every finished sentence heard */
export function onUtterance(seg: Seg) {
  if (!cfg.voiceOn) return; const t = seg.raw; if (!WAKE.test(t)) return;
  const i = S.segs.indexOf(seg), prev = i > 0 ? segText(S.segs[i - 1]) : "";
  const c = parseCommand(t, prev); if (!c) return;
  if (c.kind === "task") {
    addAction({ text: c.text, owner: c.owner, due: c.due, src: "voice" });
    addNode({ type: "action", title: c.text, body: actionLine(c) + "\n음성 명령으로 할 일에 추가됨", act: { text: c.text, owner: c.owner, due: c.due, added: true } });
  } else if (c.kind === "memo") {
    if (!S.meetingStart) S.meetingStart = Date.now();
    S.notes.push({ at: Date.now(), text: c.text }); logLine(c.text, "메모"); addNode({ type: "note", title: "", body: c.text, source: "음성 메모" }); updateEndBar();
  } else void ask(c.q);
}
