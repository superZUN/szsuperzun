// 할 일 tab: every task from every meeting plus ones added by hand. Filters, search, due tags (지남 red, D-n ≤ 3 days amber),
// tick → a one-line result field opens in place, tap → edit, swipe ⅓ of the width to delete (5 s undo).
// Stored in localStorage (ms.tasks) and, with a passcode, /api/tasks (merged per task by updatedAt; deletions as tombstones).
import { $, hhmm, simText } from "../util";
import { ls } from "../storage/ls";
import { server, serverApi } from "../storage/server";
import { sameAction, splitSlash } from "../meeting/actions";
import { carry, saveCarry, renderCarry, stripCarry } from "../meeting/carry";

export interface Task { id: string; text: string; owner: string; due: string; result: string; from: string; done: boolean; doneAt: number; at: number; updatedAt: number; deleted?: boolean; apart?: string[]; mergedInto?: string }
export const tasks: Task[] = (() => { const t = ls.json<any>("ms.tasks", []); return Array.isArray(t) ? t : []; })();
let filter: "open" | "done" | "all" = "open", openId: string | null = null, pushT: any = 0, syncing = false;
export const liveTasks = () => tasks.filter((t) => !t.deleted);
export function saveTasks(push?: boolean) { ls.set("ms.tasks", JSON.stringify(tasks)); updateTodoCount(); if (push !== false) { clearTimeout(pushT); pushT = setTimeout(pushTasks, 800); } }
export const touch = (t: Task) => { t.updatedAt = Date.now(); };
const todoVisible = () => !$("todoView").hidden;
let onNew: ((t: Task) => void) | null = null;
/** the 할 일 webhook hears about each brand-new task */
export const setNewTaskHook = (f: (t: Task) => void) => { onNew = f; };
export function addTask(a: { text: string; owner?: string; due?: string; from?: string }, opts: { quiet?: boolean } = {}): Task | null {
  const text = (a.text || "").trim(); if (!text) return null;
  const owner = (a.owner || "").trim(); // the same words for two different people are two tasks
  const ex = liveTasks().find((t) => !t.done && sameAction(t.text, text) && !(t.owner && owner && t.owner !== owner));
  if (ex) { let ch = false; if (!ex.owner && a.owner) { ex.owner = a.owner; ch = true; } if (!ex.due && a.due) { ex.due = a.due; ch = true; } if (ch) { touch(ex); saveTasks(); } return ex; }
  const t: Task = { id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, owner: (a.owner || "").trim(), due: (a.due || "").trim(), result: "", from: a.from || "", done: false, doneAt: 0, at: Date.now(), updatedAt: Date.now() };
  tasks.push(t); saveTasks(); if (todoVisible()) renderTodo(); if (onNew && !opts.quiet) try { onNew(t); } catch { /* never block adding */ } return t;
}
/** "11/20", "11월 20일", "2026-11-20", "11.20", 오늘, 내일 → end of that day; anything else → null */
export function parseDue(s: string): Date | null {
  s = String(s || "").trim(); if (!s) return null; const now = new Date(); let y = now.getFullYear(), m = 0, d = 0, k: RegExpMatchArray | null;
  if ((k = s.match(/(\d{4})[-./]\s*(\d{1,2})[-./]\s*(\d{1,2})/))) [y, m, d] = [+k[1], +k[2], +k[3]];
  else if ((k = s.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일?/)) || (k = s.match(/^(\d{1,2})\s*[/.]\s*(\d{1,2})/))) [m, d] = [+k[1], +k[2]];
  else if (/^오늘/.test(s)) return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59);
  else if (/^내일/.test(s)) return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 23, 59);
  else return null;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null; let dt = new Date(y, m - 1, d, 23, 59);
  if (!k![3] && dt.getTime() - now.getTime() < -180 * 864e5) dt = new Date(y + 1, m - 1, d, 23, 59); return dt;
}
export function dueTag(t: Task) {
  if (t.done) return null; const dt = parseDue(t.due); if (!dt) return null; const days = Math.ceil((dt.getTime() - Date.now()) / 864e5);
  if (dt.getTime() < Date.now()) return { cls: "over", text: "지남" }; if (days <= 1) return { cls: "soon", text: "오늘·내일" }; if (days <= 3) return { cls: "soon", text: `D-${days}` }; return { cls: "", text: `D-${days}` };
}
function sortedTasks() {
  const L = liveTasks(); const q = ($("todoSearch").value || "").trim().toLowerCase();
  const f = L.filter((t) => (filter === "all" || t.id === openId || (filter === "done") === !!t.done) && (!q || [t.text, t.owner, t.due, t.result, t.from].join(" ").toLowerCase().includes(q)));
  const dkey = (t: Task) => { const d = parseDue(t.due); return d ? d.getTime() : 9e15; };
  return f.sort((a, b) => (a.done !== b.done ? (a.done ? 1 : -1) : a.done ? b.doneAt - a.doneAt : dkey(a) - dkey(b) || a.at - b.at));
}
export function updateTodoCount() {
  const open = liveTasks().filter((t) => !t.done), over = open.filter((t) => { const d = parseDue(t.due); return d && d.getTime() < Date.now(); }).length;
  const c = $("todoCount"); if (!c) return; c.textContent = open.length || ""; c.classList.toggle("over", over > 0); c.title = over ? `기한 지난 일 ${over}개` : "";
}
export function renderTodo() {
  const box = $("todoList"); box.textContent = ""; const L = liveTasks();
  ([["open", "진행 중", L.filter((t) => !t.done).length], ["done", "완료", L.filter((t) => t.done).length], ["all", "전체", L.length]] as const).forEach(([k, l, n]) => { const b = $("todoF_" + k); b.textContent = `${l} ${n}`; b.setAttribute("aria-pressed", String(filter === k)); });
  const list = sortedTasks();
  const groups = similarGroups(list.filter((t) => !t.done)); const inGroup = new Map<string, Task[]>(); groups.forEach((g) => g.forEach((t) => inGroup.set(t.id, g)));
  $("todoDup").textContent = groups.length ? `비슷한 할 일 묶음 ${groups.length}개` : "";
  if (!list.length) { const p = document.createElement("div"); p.className = "note"; p.textContent = filter === "done" ? "아직 끝낸 일이 없습니다." : L.length ? "맞는 할 일이 없습니다." : "할 일이 없습니다. 위에서 추가하거나, 회의 중 AI가 찾은 할 일이 여기로 모입니다."; box.append(p); return; }
  const drawn = new Set<Task[]>();
  list.forEach((t) => {
    const g = inGroup.get(t.id);
    if (!g) { box.append(todoRow(t)); return; }
    if (drawn.has(g)) return; drawn.add(g); box.append(groupBox(g));
  });
}
/* ---------- similar tasks: shown together, merged on request ---------- */
const normT = (s: string) => s.toLowerCase().replace(/[\s.,·~\-_/()'"!?]/g, "");
/** the same task in other words: one contains the other, or most of the wording overlaps; different owners are never the same */
export function similarTasks(a: Task, b: Task) {
  if ((a.apart || []).includes(b.id) || (b.apart || []).includes(a.id)) return false;
  if (a.owner && b.owner && normT(a.owner) !== normT(b.owner)) return false;
  if (sameAction(a.text, b.text)) return true;
  const x = normT(a.text), y = normT(b.text); if (x.length < 4 || y.length < 4) return false;
  return simText(x, y) >= 0.6 && Math.min(x.length, y.length) / Math.max(x.length, y.length) >= 0.4;
}
export function similarGroups(open: Task[]): Task[][] {
  const parent = new Map(open.map((t) => [t.id, t.id])); const find = (i: string): string => { while (parent.get(i) !== i) i = parent.get(i)!; return i; };
  for (let i = 0; i < open.length; i++) for (let j = i + 1; j < open.length; j++) if (similarTasks(open[i], open[j])) parent.set(find(open[j].id), find(open[i].id));
  const by = new Map<string, Task[]>(); open.forEach((t) => { const r = find(t.id); by.set(r, [...(by.get(r) || []), t]); });
  return [...by.values()].filter((g) => g.length > 1);
}
function groupBox(g: Task[]) {
  const box = document.createElement("div"); box.className = "tgroup";
  const hd = document.createElement("div"); hd.className = "tghd";
  const lb = document.createElement("span"); lb.textContent = `비슷한 할 일 ${g.length}개`;
  const merge = document.createElement("button"); merge.className = "primary"; merge.textContent = "합치기"; merge.addEventListener("click", () => mergeSimilar(g));
  const apart = document.createElement("button"); apart.textContent = "따로 두기"; apart.addEventListener("click", () => keepApart(g));
  hd.append(lb, merge, apart); box.append(hd); g.forEach((t) => box.append(todoRow(t))); return box;
}
/** one task keeps its id (the oldest); it takes the most detailed wording, the first owner, the earliest due date, all results */
export function mergeSimilar(g: Task[]) {
  const before = g.map((t) => ({ t, before: { ...t } }));
  const keep = [...g].sort((a, b) => a.at - b.at)[0], others = g.filter((t) => t !== keep);
  keep.text = [...g].sort((a, b) => b.text.length - a.text.length)[0].text;
  keep.owner = keep.owner || g.map((t) => t.owner).find(Boolean) || "";
  const dues = g.map((t) => t.due).filter(Boolean); keep.due = dues.sort((a, b) => (parseDue(a)?.getTime() ?? 9e15) - (parseDue(b)?.getTime() ?? 9e15))[0] || "";
  keep.result = [...new Set(g.map((t) => t.result).filter(Boolean))].join(" / ");
  keep.from = [...new Set(g.flatMap((t) => (t.from || "").split(" · ")).filter(Boolean))].join(" · ");
  touch(keep);
  others.forEach((t) => { Object.assign(t, { deleted: true, mergedInto: keep.id }); touch(t); });
  saveTasks(); renderTodo();
  showUndo(`${g.length}개를 '${keep.text.slice(0, 20)}${keep.text.length > 20 ? "…" : ""}'로 합침`, () => { before.forEach(({ t, before: b }) => { Object.assign(t, b, { deleted: !!b.deleted }); touch(t); }); });
}
function keepApart(g: Task[]) {
  g.forEach((t) => { t.apart = [...new Set([...(t.apart || []), ...g.filter((x) => x !== t).map((x) => x.id)])].slice(-50); touch(t); });
  saveTasks(); renderTodo();
}
function todoRow(t: Task) {
  const wrap = document.createElement("div"); wrap.className = "tswipe"; wrap.dataset.id = t.id; const back = document.createElement("div"); back.className = "tback"; back.textContent = "삭제";
  const row = document.createElement("div"); row.className = "trow" + (t.done ? " done" : "") + (openId === t.id ? " open" : ""); wrap.append(back, row); swipeToDelete(wrap, row, t);
  const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!t.done; cb.setAttribute("aria-label", (t.done ? "완료 취소: " : "완료: ") + t.text);
  cb.addEventListener("change", () => {
    t.done = cb.checked; t.doneAt = t.done ? Date.now() : 0; touch(t); syncCarryDone(t); saveTasks();
    openId = t.done ? t.id : openId; renderTodo(); if (t.done) { const r = document.querySelector(`.trow.open [data-res]`) as HTMLElement | null; if (r) r.focus(); } // just finished: type a one-line result right away
  });
  const main = document.createElement("button"); main.type = "button"; main.className = "tmain";
  const tt = document.createElement("span"); tt.className = "ttext"; tt.textContent = t.text;
  const meta = document.createElement("span"); meta.className = "tmeta"; const dt = dueTag(t);
  const bits = [t.owner && "담당 " + t.owner, t.due && "기한 " + t.due, t.done && t.doneAt && "완료 " + new Date(t.doneAt).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }), t.from].filter(Boolean);
  meta.textContent = bits.join(" · "); if (dt) { const tag = document.createElement("b"); tag.className = "tdue " + dt.cls; tag.textContent = dt.text; meta.prepend(tag); }
  main.append(tt, meta);
  if (t.result && openId !== t.id) { const r = document.createElement("span"); r.className = "tres"; r.textContent = "결과 · " + t.result; main.append(r); }
  main.addEventListener("click", () => { openId = openId === t.id ? null : t.id; renderTodo(); });
  // one tap deletes (the 5-second 되돌리기 bar is the safety net)
  const del = document.createElement("button"); del.type = "button"; del.className = "tdel"; del.textContent = "✕"; del.title = "삭제"; del.setAttribute("aria-label", "삭제: " + t.text);
  del.addEventListener("click", (e) => { e.stopPropagation(); deleteTask(t); });
  row.append(cb, main, del);
  if (openId === t.id) {
    const ed = document.createElement("div"); ed.className = "tedit";
    const field = (label: string, key: keyof Task, ph: string, area?: boolean) => {
      const l = document.createElement("label"); l.className = "f"; l.textContent = label; const i = document.createElement(area ? "textarea" : "input") as HTMLInputElement; i.placeholder = ph; i.value = (t[key] as string) || "";
      if (key === "result") i.dataset.res = "1"; i.addEventListener("change", () => { const v = i.value.trim(); if (v === ((t[key] as string) || "")) return; (t as any)[key] = v; touch(t); saveTasks(); if (key === "result") syncCarryDone(t); }); l.append(i); return l;
    };
    ed.append(field("결과", "result", t.done ? "어떻게 끝났는지 한 줄로 (예: 고객사 통보 완료, 11/20 납기 확정)" : "진행 상황이나 결과를 짧게", true), field("할 일", "text", "할 일"), field("담당", "owner", "담당자"), field("기한", "due", "예: 11/20"));
    const bar = document.createElement("div"); bar.className = "row"; bar.style.justifyContent = "flex-end";
    const del = document.createElement("button"); del.textContent = "삭제"; let armed = false;
    del.addEventListener("click", () => { if (!armed) { armed = true; del.textContent = "한 번 더"; del.classList.add("arm"); setTimeout(() => { armed = false; del.textContent = "삭제"; del.classList.remove("arm"); }, 3000); return; } deleteTask(t); });
    const close = document.createElement("button"); close.textContent = "닫기"; close.addEventListener("click", () => { openId = null; renderTodo(); });
    bar.append(del, close); ed.append(bar); row.append(ed);
    ed.querySelector("textarea")!.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); (e.target as HTMLElement).blur(); openId = null; renderTodo(); } });
  }
  return wrap;
}
/** swipe a task sideways past a third of its width to delete it; vertical scrolling is left alone */
function swipeToDelete(wrap: HTMLElement, row: HTMLElement, t: Task) {
  let sx = 0, sy = 0, dx = 0, id: number | null = null, on = false;
  wrap.addEventListener("pointerdown", (e) => { if (e.button > 0 || (e.target as HTMLElement).closest("input,textarea,.tedit,.tdel")) return; id = e.pointerId; sx = e.clientX; sy = e.clientY; dx = 0; on = false; });
  wrap.addEventListener("pointermove", (e) => {
    if (e.pointerId !== id) return; const mx = e.clientX - sx, my = e.clientY - sy;
    if (!on) { if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { id = null; return; } if (Math.abs(mx) < 10) return; on = true; try { wrap.setPointerCapture(id!); } catch { /* gone */ } row.style.transition = "none"; wrap.classList.add("swiping"); }
    dx = mx; row.style.transform = `translateX(${dx}px)`; wrap.classList.toggle("armed", Math.abs(dx) > wrap.clientWidth * 0.33);
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return; id = null; if (!on) return; on = false; (wrap as any)._swiped = Date.now(); row.style.transition = "transform .2s ease-out";
    if (e.type !== "pointercancel" && Math.abs(dx) > wrap.clientWidth * 0.33) { row.style.transform = `translateX(${dx > 0 ? "" : "-"}110%)`; setTimeout(() => deleteTask(t), 180); }
    else { row.style.transform = ""; wrap.classList.remove("swiping", "armed"); }
  };
  wrap.addEventListener("pointerup", end); wrap.addEventListener("pointercancel", end);
  wrap.addEventListener("click", (e) => { if ((wrap as any)._swiped && Date.now() - (wrap as any)._swiped < 350) { e.stopPropagation(); e.preventDefault(); } }, true); // a swipe is not a tap
}
let undoT: any = 0, undoFn: (() => void) | null = null;
function showUndo(msg: string, fn: () => void) {
  undoFn = fn; const bar = $("todoUndo"); $("todoUndoMsg").textContent = msg; bar.hidden = false;
  clearTimeout(undoT); undoT = setTimeout(() => { bar.hidden = true; undoFn = null; }, 5000);
}
export function deleteTask(t: Task) {
  const before = { ...t }; Object.assign(t, { deleted: true }); touch(t); if (openId === t.id) openId = null; saveTasks(); renderTodo();
  showUndo(`'${before.text.slice(0, 24)}${before.text.length > 24 ? "…" : ""}' 삭제됨`, () => { Object.assign(t, before, { deleted: false }); touch(t); });
}
/** a task ticked here also ticks the matching item in the next-meeting check list (and the other way round, in carry.ts) */
function syncCarryDone(t: Task) {
  let ch = false; carry.items.forEach((x) => { if (sameAction(stripCarry(x.text), t.text) && (!!x.done !== !!t.done || (t.result && x.result !== t.result))) { x.done = t.done; if (t.result) x.result = t.result; ch = true; } });
  if (ch) { saveCarry(); renderCarry(); }
}
export function mergeTasks(remote: Task[]) {
  let ch = false; const map = new Map(tasks.map((t) => [t.id, t]));
  for (const r of remote || []) { const l = map.get(r.id); if (!l) { tasks.push(r); map.set(r.id, r); ch = true; } else if ((r.updatedAt || 0) > (l.updatedAt || 0)) { Object.assign(l, r); ch = true; } }
  return ch;
}
async function pushTasks() {
  if (!server.passcode) return;
  try { const j = await serverApi("/api/tasks", "PUT", { items: tasks }); if (j && mergeTasks(j.items)) { saveTasks(false); if (todoVisible()) renderTodo(); } $("todoSync").textContent = "서버와 동기화됨 · " + hhmm(Date.now()).slice(0, 5); }
  catch (e: any) { $("todoSync").textContent = e && e.code === "no_pass" ? "" : "서버 저장 실패 — 이 기기에는 저장되어 있습니다"; }
}
export async function pullTasks() {
  if (!server.passcode || syncing) return; syncing = true;
  try {
    const j = await serverApi("/api/tasks", "GET"); if (mergeTasks(j && j.items)) { saveTasks(false); if (todoVisible()) renderTodo(); }
    const remoteIds = new Set(((j && j.items) || []).map((t: Task) => t.id)); // anything only this device has goes up too
    if (tasks.some((t) => !remoteIds.has(t.id))) await pushTasks(); else $("todoSync").textContent = "서버와 동기화됨 · " + hhmm(Date.now()).slice(0, 5);
  } catch { /* offline */ }
  syncing = false;
}
function todoAddFromInput() {
  const v = $("todoInput").value.trim(); if (!v) return; const [text, owner, due] = splitSlash(v);
  const t = addTask({ text, owner, due, from: "직접 추가" }); $("todoInput").value = ""; if (t && filter === "done") filter = "open"; renderTodo(); $("todoInput").focus();
}
export function initTasks() {
  $("todoAdd").addEventListener("click", todoAddFromInput);
  $("todoInput").addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); todoAddFromInput(); } });
  (["open", "done", "all"] as const).forEach((k) => $("todoF_" + k).addEventListener("click", () => { filter = k; openId = null; renderTodo(); }));
  let st: any = 0; $("todoSearch").addEventListener("input", () => { clearTimeout(st); st = setTimeout(renderTodo, 120); });
  $("todoUndoBtn").addEventListener("click", () => { if (!undoFn) return; undoFn(); undoFn = null; $("todoUndo").hidden = true; saveTasks(); renderTodo(); });
  setInterval(updateTodoCount, 60000);
  // tasks that existed only in the next-meeting check list come along once
  let ch = false;
  carry.items.forEach((x) => { const text = stripCarry(x.text); if (!liveTasks().some((t) => sameAction(t.text, text))) { const t = addTask({ text, owner: x.owner, due: x.due, from: carry.from || "지난 회의" }, { quiet: true }); if (t && x.done) { t.done = true; t.doneAt = Date.now(); } ch = true; } });
  if (ch) saveTasks(); updateTodoCount();
  setTimeout(pullTasks, 1500);
}
