// Carry-over: when minutes are confirmed, this meeting's open tasks (and last meeting's unfinished ones) move to the
// next meeting's 준비 tab, where they can be ticked off (kept in step with the 할 일 tab both ways).
import { $, stamp } from "../util";
import { S } from "../state";
import { ls } from "../storage/ls";
import { sameAction } from "./actions";
import { liveTasks, touch, saveTasks } from "../tasks/tasks";

export interface CarryItem { text: string; owner?: string; due?: string; done?: boolean; carried?: boolean; result?: string }
export const carry: { from?: string; date?: string; items: CarryItem[] } = (() => { const c = ls.json<any>("ms.carry", null); return c && Array.isArray(c.items) ? c : { items: [] }; })();
export const saveCarry = () => ls.set("ms.carry", carry.items.length ? JSON.stringify(carry) : "");
export const stripCarry = (t: string) => t.replace(/^\(이월\)\s*/, "");
export function carryForward(title: string) {
  const prevOpen = carry.items.filter((x) => !x.done).map((x) => ({ ...x, text: stripCarry(x.text), carried: true }));
  const items: CarryItem[] = [];
  [...prevOpen, ...S.actions.map((a) => ({ text: a.text, owner: a.owner, due: a.due, done: false }))].forEach((x) => { if (!items.some((y) => sameAction(y.text, x.text))) items.push(x); });
  carry.from = title; carry.date = stamp(new Date(S.meetingStart || Date.now())); carry.items = items; saveCarry(); renderCarry();
}
export function renderCarry() {
  const box = $("carryList"); box.textContent = "";
  $("carryInfo").textContent = carry.items.length ? `'${carry.from || "지난 회의"}'${carry.date ? " (" + carry.date + ")" : ""}에서 넘어온 할 일 ${carry.items.length}개 · 완료 ${carry.items.filter((x) => x.done).length}개` : "회의록을 작성하면 그 회의의 할 일이 여기로 넘어와, 다음 회의에서 진행 상황을 점검합니다.";
  carry.items.forEach((x) => {
    const r = document.createElement("label"); r.className = "citem" + (x.done ? " done" : ""); const c = document.createElement("input"); c.type = "checkbox"; c.checked = !!x.done;
    const s = document.createElement("span"); s.textContent = (x.carried ? "(이월) " : "") + x.text + (x.owner || x.due ? ` — ${[x.owner, x.due].filter(Boolean).join(", ")}` : "");
    c.addEventListener("change", () => {
      x.done = c.checked; saveCarry(); renderCarry();
      const tk = liveTasks().find((t) => sameAction(t.text, stripCarry(x.text))); if (tk && !!tk.done !== !!x.done) { tk.done = !!x.done; tk.doneAt = x.done ? Date.now() : 0; touch(tk); saveTasks(); }
    });
    r.append(c, s); box.append(r);
  });
}
export function initCarry() {
  const b = $("carryClear"); let armed = false;
  b.addEventListener("click", () => { if (!armed) { armed = true; b.textContent = "한 번 더"; setTimeout(() => { armed = false; b.textContent = "목록 비우기"; }, 3000); return; } carry.items = []; delete carry.from; saveCarry(); renderCarry(); armed = false; b.textContent = "목록 비우기"; });
}
