// This meeting's action items: found by the AI or typed ("할 일 / 담당 / 11/20" — slashes between digits belong to the date),
// merged when the same item comes again, editable in a sheet, mirrored into the 할 일 tab.
import { $, hhmm, armButton } from "../util";
import { S, type Action } from "../state";
import { addNode } from "../hud/cards";
import { addTask, tasks, touch, saveTasks } from "../tasks/tasks";
import { defaultTitle } from "../minutes/minutes";

const normA = (s: string) => s.replace(/[\s.,·~\-]/g, "").toLowerCase();
export function sameAction(a: string, b: string) { const x = normA(a), y = normA(b); return x === y || (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))); }
/** "할 일 / 담당 / 11/20": a slash between two digits is part of a date */
export const splitSlash = (v: string) => v.split(/(?<!\d)\s*\/\s*|\s*\/\s*(?!\d)/).map((x) => x.trim());
export const actionLine = (a: { owner: string; due: string }) => ["담당 " + (a.owner || "미정"), "기한 " + (a.due || "미정")].join(" · ");
export function addAction(a: { text: string; owner?: string; due?: string; src?: string }): Action | null {
  const text = (a.text || "").trim(); if (!text) return null;
  const ex = S.actions.find((x) => sameAction(x.text, text));
  if (ex) { if (!ex.owner && a.owner) ex.owner = a.owner; if (!ex.due && a.due) ex.due = a.due; renderActions(); return null; }
  const it: Action = { id: Date.now() + Math.random(), text, owner: (a.owner || "").trim(), due: (a.due || "").trim(), src: a.src || "me", at: Date.now() }; S.actions.push(it);
  const t = addTask({ text: it.text, owner: it.owner, due: it.due, from: defaultTitle() }); if (t) it.taskId = t.id; renderActions(); return it;
}
export function renderActions(force?: boolean) {
  $("actCount").textContent = S.actions.length; const box = $("actList"); if (!force && $("actSheet").hidden && box.childElementCount) return; box.textContent = "";
  const mk = (it: Action | null) => {
    const row = document.createElement("div"); row.className = "aitem" + (it ? "" : " new");
    const t = document.createElement("input"); t.placeholder = "할 일"; t.value = it ? it.text : "";
    const o = document.createElement("input"); o.placeholder = "담당"; o.value = it ? it.owner : "";
    const d = document.createElement("input"); d.placeholder = "기한"; d.value = it ? it.due : "";
    const b = document.createElement("button"); b.textContent = it ? "삭제" : "추가";
    if (!it) b.addEventListener("click", () => { const a = addAction({ text: t.value, owner: o.value, due: d.value, src: "me" }); if (a) addNode({ type: "action", title: a.text, body: actionLine(a) }); renderActions(true); });
    else {
      [t, o, d].forEach((el, k) => el.addEventListener("change", () => { const key = (["text", "owner", "due"] as const)[k]; it[key] = el.value.trim(); const tk = tasks.find((x) => x.id === it.taskId); if (tk) { (tk as any)[key] = it[key]; touch(tk); saveTasks(); } }));
      armButton(b, "삭제", () => { S.actions = S.actions.filter((x) => x !== it); const tk = tasks.find((x) => x.id === it.taskId); if (tk && !tk.done) { Object.assign(tk, { deleted: true, text: "" }); touch(tk); saveTasks(); } renderActions(true); });
    }
    row.append(t, o, d, b);
    if (it) { const s = document.createElement("div"); s.className = "src"; s.textContent = (it.src === "ai" ? "AI" : "직접 추가") + " · " + hhmm(it.at); row.append(s); }
    return row;
  };
  S.actions.forEach((it) => box.append(mk(it))); box.append(mk(null));
}
function addActFromInput() {
  const inp = $("actInput"), v = inp.value.trim(); if (!v) return; const [text, owner, due] = splitSlash(v);
  const a = addAction({ text, owner, due, src: "me" }); inp.value = ""; if (a) addNode({ type: "action", title: a.text, body: actionLine(a) }); inp.focus();
}
export function initActions() {
  $("actBtn").addEventListener("click", () => { $("actSheet").hidden = false; renderActions(true); });
  $("actClose").addEventListener("click", () => { $("actSheet").hidden = true; });
  $("actAdd").addEventListener("click", addActFromInput);
  $("actInput").addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); addActFromInput(); } });
}
