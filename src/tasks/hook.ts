// 할 일 웹훅: each task added on this device goes to the user's Power Automate flow as
// { issue: the task in English, pic: 담당자, status: "OPEN" } — through /api/hook, which holds the flow URL on the server.
// Only tasks created here are sent (synced copies from other devices are not), queued so a lost connection retries later.
import { $ } from "../util";
import { ls } from "../storage/ls";
import { server, serverApi, serverErrText } from "../storage/server";
import { ai, aiCall } from "../ai/client";
import { tasks, type Task } from "./tasks";

interface Item { id: string; tries: number; issue?: string; err?: string }
export const hook = { configured: ls.get("ms.hook.on") === "1", host: ls.get("ms.hook.host"), busy: false, sent: Number(ls.get("ms.hook.sent")) || 0, last: "", err: "" };
export const HOOK_TIMING = { retryMs: 120000 }; // tests shorten this
const queue = (): Item[] => ls.json<Item[]>("ms.hook.queue", []);
const saveQueue = (q: Item[]) => ls.set("ms.hook.queue", JSON.stringify(q));
function setConfigured(on: boolean, host = "") { hook.configured = on; hook.host = host; ls.set("ms.hook.on", on ? "1" : ""); ls.set("ms.hook.host", host); renderHook(); }
const update = (id: string, f: (x: Item) => void) => saveQueue(queue().map((x) => (x.id === id ? (f(x), x) : x)));
const drop = (id: string) => saveQueue(queue().filter((x) => x.id !== id));

/** a task title in English for the issue tracker (names, numbers, dates and codes kept) */
export async function toEnglish(text: string): Promise<string> {
  if (!/[^\x00-\x7F]/.test(text) || !ai.apiKey) return text;
  const t = await aiCall(`Translate this to-do item from a battery-cell (Formation/EOL) engineer into a concise English issue title in the imperative (at most 12 words). Keep people's names, numbers, dates, product and equipment codes. Output only the title.\n\n${text}`, { maxTokens: 80, kind: "hook" });
  const line = t.split("\n").map((x) => x.trim()).find(Boolean) || "";
  return line.replace(/^["'“”‘’`]+|["'“”‘’`.]+$/g, "").trim() || text;
}
export const payload = (t: Task, issue: string) => ({ issue, pic: (t.owner || "").trim() || "TBD", status: "OPEN" });

/** called by addTask for every brand-new task — queued whenever the server is reachable, even if this device
 *  has not heard yet that a webhook was saved (it may have been saved on another device a moment ago) */
export function queueTask(t: Task) {
  if (!server.passcode) return;
  const q = queue(); if (q.some((x) => x.id === t.id)) return; q.push({ id: t.id, tries: 0 }); saveQueue(q); renderHook(); void flushHook();
}
/** one round: every queued task once, oldest first; one task the flow refuses does not hold up the others */
export async function flushHook() {
  if (hook.busy || !server.passcode || !queue().length) return; hook.busy = true;
  try {
    if (!hook.configured) await refresh();
    if (!hook.configured) { saveQueue([]); return; } // no webhook saved anywhere: nothing to send
    const tried = new Set<string>(); let it: Item | undefined;
    while ((it = queue().find((x) => !tried.has(x.id)))) { // tasks added while this round runs are picked up too
      tried.add(it.id); const cur = it;
      const t = tasks.find((x) => x.id === cur.id);
      if (!t || t.deleted) { drop(cur.id); continue; } // removed before it went out
      let issue = cur.issue;
      if (!issue) {
        try { issue = await toEnglish(t.text); } catch { if (cur.tries < 2) { update(cur.id, (x) => { x.tries++; x.err = "영문 번역 대기(AI 응답 없음)"; }); continue; } issue = t.text; } // AI busy: next round, Korean after that
        update(cur.id, (x) => { x.issue = issue; });
      }
      try {
        await serverApi("/api/hook", "POST", payload(t, issue!));
        hook.sent++; ls.set("ms.hook.sent", String(hook.sent)); hook.last = issue!; hook.err = ""; drop(cur.id);
      } catch (e: any) {
        if (e && e.code === "server_err" && e.status === 409) { setConfigured(false); saveQueue([]); return; } // the URL was removed on the server
        const why = e && e.code === "server_err" && e.status === 502 ? `Power Automate가 받지 않음${e.detail ? " (" + e.detail + ")" : ""}` : serverErrText(e);
        hook.err = why; update(cur.id, (x) => { x.tries++; x.err = why; });
        if (queue().find((x) => x.id === cur.id)!.tries >= 10) drop(cur.id); // give up after 10 tries
        if (!(e && e.code === "server_err" && e.status === 502)) return; // no connection: stop this round
      }
    }
  } finally { hook.busy = false; renderHook(); }
}

/* ---------- settings ---------- */
function msg(t: string, warn = false) { const m = $("hookMsg"); m.textContent = t; m.className = "hint" + (warn ? " warn" : ""); }
export function renderHook() {
  const s = $("hookState"); if (!s) return; const q = queue(), n = q.length;
  s.textContent = hook.configured ? `연결됨 · ${hook.host}${n ? ` · 보낼 차례 ${n}개` : ""}` : "연결 안 됨";
  s.className = "mstate " + (hook.configured ? (n && q.some((x) => x.err) ? "warn" : "good") : "");
  const d = $("hookDetail"); if (!d) return; const err = q.find((x) => x.err);
  d.textContent = hook.configured ? `이 기기에서 보낸 할 일 ${hook.sent}개${hook.last ? ` · 마지막: ${hook.last}` : ""}${err ? ` · 문제: ${err.err}` : ""}` : "";
  $("hookRetry").hidden = !n;
}
async function refresh() {
  if (!server.passcode) return;
  try { const r = await serverApi("/api/hook", "GET"); setConfigured(!!r.configured, r.host || ""); } catch { /* offline: keep the last known state */ }
}
export function initHook() {
  renderHook();
  $("hookSave").addEventListener("click", async () => {
    const url = ($("hookUrl").value || "").trim();
    if (!server.passcode) { msg("먼저 '서버 동기화 비밀번호'를 넣어 주세요. 웹훅 주소는 서버에 보관됩니다.", true); return; }
    try {
      const r = await serverApi("/api/hook", "PUT", { url }); setConfigured(!!r.configured, r.host || ""); $("hookUrl").value = "";
      msg(r.configured ? "저장했습니다. 이제 새 할 일이 생기면 Power Automate로 보냅니다." : "웹훅을 껐습니다.");
    } catch (e: any) { msg(e && e.detail === "bad_url" ? "Power Automate(…powerplatform.com / …logic.azure.com)의 https 주소만 넣을 수 있어요." : serverErrText(e), true); }
  });
  $("hookTest").addEventListener("click", async () => {
    if (!server.passcode) { msg("먼저 '서버 동기화 비밀번호'를 넣어 주세요.", true); return; }
    try { await serverApi("/api/hook", "POST", { issue: "JAY-WEBHOOK-TEST", pic: "TBD", status: "OPEN" }); msg("시험 항목(JAY-WEBHOOK-TEST)을 보냈습니다. Power Automate 실행 기록에서 확인해 보세요."); }
    catch (e: any) { msg(e && e.status === 409 ? "아직 웹훅 주소가 저장되지 않았어요." : e && e.status === 502 ? "Power Automate가 받지 않았어요. 흐름이 켜져 있는지, 주소가 맞는지 확인해 주세요." : serverErrText(e), true); }
  });
  $("hookRetry").addEventListener("click", () => { msg("다시 보내는 중…"); void flushHook().then(() => msg(queue().length ? "아직 못 보낸 할 일이 있어요. 아래 '문제'를 확인해 주세요." : "모두 보냈습니다.", !!queue().length)); });
  void refresh().then(() => flushHook());
  setInterval(() => { if (queue().length) void flushHook(); }, HOOK_TIMING.retryMs);
  setInterval(() => void refresh(), 10 * 60000); // a webhook saved or removed on another device
}
