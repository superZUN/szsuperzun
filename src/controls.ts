// Header, tabs, input-row modes, start/stop, the AI connection form, dictionary lists, the cost panel, and no-zoom.
import { $ } from "./util";
import { S } from "./state";
import { cfg, onSettingsChange } from "./settings/settings";
import { ai, PROVIDERS, loadProvider, saveProvider, aiCall, listModels, errText, refreshNote, keepWarm, type ProviderId } from "./ai/client";
import { usage, onUsage, onLimit, overLimit, effectivePace } from "./ai/usage";
import { BASE_TERMS, LIB_TERMS, type Term } from "./library/dict";
import { syncDocsNow, lastSync } from "./library/docs";
import { addNode } from "./hud/cards";
import { wake } from "./hud/field";
import { renderCarry } from "./meeting/carry";
import { agenda, setAgenda } from "./meeting/prep";
import { needsBoundary, askBoundary } from "./meeting/session";
import { renderTodo, pullTasks } from "./tasks/tasks";
import { updateEndBar } from "./minutes/minutes";
import { analyze } from "./analysis/analyze";
import { updateFixStat } from "./transcript";
import { rs, startRec, stopRec, speechSupported, setMicFailHandler } from "./speech/recognizer";
import { vadStart, vadStop, renderGauge, vad } from "./speech/gauge";
import { holdScreen, releaseScreen } from "./power/standby";
import { resetCloud, cloudOn, testSttKey, setSwitchHandler } from "./speech/cloud";
import { pauseRec } from "./speech/recognizer";
import { renderLearn } from "./memory/learn";
import { renderMind } from "./mindmap/mindmap";
import { initMeetingType } from "./meeting/mtype";
import { renderWork } from "./work/work";

export function setStatus() {
  const s = $("status"); s.className = "status" + (S.busy ? " busy" : S.running ? " on" : "");
  s.textContent = S.standby ? "SLEEP" : S.deepRuns > 0 ? "DEEP SCAN" : S.busy ? "ANALYZING" : S.running ? "LISTENING" : "STANDBY"; s.classList.toggle("deep", S.deepRuns > 0);
  const b = $("startBtn"); b.textContent = S.running ? "멈춤" : "시작"; b.classList.toggle("stop", S.running);
}
export async function toggle() {
  if (!S.running && needsBoundary()) { askBoundary(); return; }
  S.running = !S.running;
  if (S.running) { S.startedAt = Date.now(); if (!S.meetingStart || !S.segs.length) S.meetingStart = S.startedAt; if (S.agIdx < 0 && agenda().length && S.appMode === "meet") setAgenda(0); }
  setStatus(); updateEndBar(); $("restoreBar").hidden = true;
  if (S.running) {
    rs.lastHeardAt = Date.now(); resetCloud(); void vadStart();
    if (cfg.sttMode === "cloud" && cloudOn()) { /* Gemini only: Safari recognition stays off; the gauge's microphone feeds Gemini */ }
    else if (!startRec()) { $("aiNote").className = "hint warn"; $("aiNote").textContent = "이 브라우저는 실시간 음성 인식을 지원하지 않아요. Chrome, Edge, Safari에서 열어 주세요. '원문'을 열고 직접 입력해도 분석됩니다."; }
    void holdScreen(); renderGauge(true); keepWarm(true);
  } else {
    stopRec(); vadStop(); if (S.standby) { S.standby = false; $("sleepVeil").hidden = true; } void analyze(false); releaseScreen(); renderGauge(true); setStatus();
  }
  wake(1500);
}
const TABS: Record<string, string> = { tabLive: "liveView", tabWork: "workView", tabPrep: "prepView", tabKb: "kbView", tabTodo: "todoView", tabMind: "mindView", tabSet: "setView" };
export function showTab(id: string) {
  Object.entries(TABS).forEach(([t, v]) => { $(v).hidden = t !== id; $(t).setAttribute("aria-selected", String(t === id)); });
  if (id === "tabPrep") renderCarry(); if (id === "tabTodo") { renderTodo(); void pullTasks(); } if (id === "tabKb" && Date.now() - lastSync > 20000) void syncDocsNow(false); if (id === "tabSet") { renderUsage(); renderLearn(); } if (id === "tabMind") renderMind(); if (id === "tabWork") renderWork();
}
function setInMode(m: "memo" | "ask" | "act") {
  ([["memo", "modeMemo", "memoInput", "memoAdd"], ["ask", "modeAsk", "askInput", "askBtn"], ["act", "modeAct", "actInput", "actAdd"]] as const).forEach(([k, t, i, b]) => { const on = k === m; $(t).setAttribute("aria-selected", String(on)); $(i).hidden = !on; $(b).hidden = !on; });
  $("askChips").hidden = m !== "ask"; $({ memo: "memoInput", ask: "askInput", act: "actInput" }[m]).focus();
}

/* ---------- AI connection form ---------- */
function showProviderForm() {
  const p = ai.provider, P = PROVIDERS[p];
  $("provider").value = p; $("apiKey").value = ai.apiKey; $("apiKey").placeholder = P.key; $("model").value = ai.model; $("model").placeholder = P.fast || "모델 이름";
  $("deepModel").value = ai.deepModel === P.deep ? P.deep : ai.deepModel; $("deepModel").placeholder = P.deep || "비우면 빠른 모델 사용";
  $("baseWrap").hidden = p !== "compat"; $("baseUrl").value = ai.baseUrl; $("provHint").textContent = P.hint; $("modelList").textContent = "";
}
const readForm = () => saveProvider($("provider").value, { apiKey: $("apiKey").value.trim(), model: $("model").value.trim(), deepModel: $("deepModel").value.trim(), baseUrl: $("baseUrl").value.trim() });
function initProviderForm() {
  showProviderForm();
  $("provider").addEventListener("change", () => { const p = $("provider").value as ProviderId; try { localStorage.setItem("ms.prov", p); } catch { /* blocked */ } loadProvider(p); showProviderForm(); $("keyMsg").textContent = ""; refreshNote(); updateFixStat(); });
  $("saveKey").addEventListener("click", () => { readForm(); $("keyMsg").textContent = ai.apiKey ? `저장했습니다 · ${PROVIDERS[ai.provider].label} · ${ai.model}` : "키를 입력해 주세요."; refreshNote(); updateFixStat(); });
  $("forgetKey").addEventListener("click", () => { ai.apiKey = ""; $("apiKey").value = ""; try { localStorage.removeItem("ms.key." + ai.provider); } catch { /* blocked */ } $("keyMsg").textContent = "키를 지웠습니다."; refreshNote(); });
  $("testKey").addEventListener("click", async () => {
    readForm(); $("keyMsg").textContent = "확인 중…";
    try { const t = await aiCall("'연결됨'이라고만 답하세요.", { maxTokens: 30, kind: "test" }); $("keyMsg").textContent = `연결 성공 (${PROVIDERS[ai.provider].label} · ${ai.model}): ${t.trim().slice(0, 40)}`; }
    catch (e) { $("keyMsg").textContent = errText(e); }
  });
  $("listModels").addEventListener("click", async () => {
    readForm(); $("keyMsg").textContent = "모델 목록을 불러오는 중…";
    try { const ids = await listModels(); const dl = $("modelList"); dl.textContent = ""; ids.forEach((id) => { const o = document.createElement("option"); o.value = id; dl.append(o); }); $("keyMsg").textContent = `${ids.length}개 모델 · 모델 칸을 누르면 고를 수 있습니다: ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? " …" : ""}`; }
    catch (e) { $("keyMsg").textContent = errText(e); }
  });
}
/* ---------- built-in dictionary toggles and lists ---------- */
function dictUI(on: string, count: string, show: string, list: string, arr: Term[], key: "baseOn" | "libOn", lsKey: string) {
  $(on).checked = cfg[key]; $(count).textContent = arr.length;
  $(on).addEventListener("change", () => { cfg[key] = $(on).checked; try { $(on).checked ? localStorage.removeItem(lsKey) : localStorage.setItem(lsKey, "1"); } catch { /* blocked */ } });
  $(show).addEventListener("click", () => {
    const box = $(list), open = box.hidden; box.hidden = !open; $(show).setAttribute("aria-expanded", String(open)); $(show).textContent = open ? "목록 닫기" : "목록 보기";
    if (open && !box.childElementCount) {
      const q = document.createElement("input"); q.className = "dsearch"; q.placeholder = "용어 검색 (예: SEI, 석출, 열폭주)"; q.setAttribute("aria-label", "용어 검색");
      const body = document.createElement("div"); box.append(q, body);
      const draw = () => {
        body.textContent = ""; const f = q.value.trim().toLowerCase(); let cat = "", n = 0;
        arr.forEach((x) => {
          if (f && !(x.t + " " + x.e + " " + x.d + " " + (x.n || "") + " " + (x.s || "")).toLowerCase().includes(f)) return; n++;
          if (x.c !== cat) { cat = x.c; const h = document.createElement("div"); h.className = "bcat"; h.textContent = cat; body.append(h); }
          const r = document.createElement("div"); r.className = "bterm"; const t = document.createElement("b"); t.textContent = x.t; const e = document.createElement("span"); e.className = "ben"; e.textContent = x.e !== x.t ? x.e : "";
          const d = document.createElement("div"); d.className = "bdef"; d.textContent = x.d + (x.n ? " · " + x.n : ""); r.append(t, e, d); body.append(r);
        });
        if (!n) { const p = document.createElement("div"); p.className = "note"; p.textContent = "찾는 용어가 없습니다."; body.append(p); }
      };
      q.addEventListener("input", draw); draw();
    }
  });
}
/* ---------- cost panel ---------- */
export function renderUsage() {
  const box = $("usageBox"); if (!box) return; const u = usage(); const k = (n: number) => (n >= 10000 ? (n / 1000).toFixed(0) + "k" : n.toLocaleString());
  const kinds = Object.entries(u.byKind).sort((a, b) => b[1] - a[1]).map(([n, c]) => ({ analyze: "분석", fix: "교정", ask: "질문", deep: "넓게 찾기", visual: "그림", kwweb: "키워드 검색", minutes: "회의록", check: "점검", mail: "메일", test: "연결 확인", daysum: "하루 요약", mindmap: "마인드맵", other: "기타" } as any)[n] + " " + c).join(" · ");
  box.innerHTML = "";
  const line = (t: string, cls = "") => { const d = document.createElement("div"); d.textContent = t; if (cls) d.className = cls; box.append(d); };
  line(`오늘 AI 호출 ${u.calls.toLocaleString()}회${cfg.dailyLimit ? ` / 한도 ${cfg.dailyLimit.toLocaleString()}` : ""} · 웹 검색 ${u.web}회`, overLimit() ? "over" : "");
  line(`토큰 약 입력 ${k(u.inTok)} (캐시 ${k(u.cacheRead)}) · 출력 ${k(u.outTok)}${u.est ? ` · ${u.est}회는 어림값` : ""}`);
  if (kinds) line(kinds);
  if (u.stt && u.stt.calls) line(`Gemini 받아쓰기 ${u.stt.calls}회 · 소리 ${Math.round(u.stt.sec / 60)}분 · 토큰 입력 ${k(u.stt.inTok)} / 출력 ${k(u.stt.outTok)}`);
  line(`지금 분석 빈도: ${({ balanced: "균형", fast: "빠르게", save: "절약" } as any)[effectivePace()]}${overLimit() ? " (하루 한도를 넘어 자동 절약 중)" : ""}`, overLimit() ? "over" : "");
}

export function initControls() {
  $("startBtn").addEventListener("click", toggle);
  Object.keys(TABS).forEach((t) => $(t).addEventListener("click", () => showTab(t)));
  $("modeMemo").addEventListener("click", () => setInMode("memo")); $("modeAsk").addEventListener("click", () => setInMode("ask")); $("modeAct").addEventListener("click", () => setInMode("act"));
  initMeetingType();
  setSwitchHandler(() => { if (!S.running) return; pauseRec(); vadStop(); vad.failed = false; resetCloud(); void vadStart(); renderGauge(true); });
  initProviderForm();
  $("sttTest").addEventListener("click", async () => { $("sttMsg").textContent = "확인 중…"; $("sttMsg").textContent = await testSttKey(); });
  dictUI("baseOn", "baseCount", "baseShow", "baseList", BASE_TERMS, "baseOn", "ms.baseOff");
  dictUI("libOn", "libCount", "libShow", "libList", LIB_TERMS, "libOn", "ms.libOff");
  onUsage(() => { if (!$("setView").hidden) renderUsage(); });
  onSettingsChange(() => { renderUsage(); updateFixStat(); wake(); });
  onLimit(() => addNode({ type: "risk", title: "오늘 AI 사용 한도 도달", body: `오늘 호출이 ${cfg.dailyLimit.toLocaleString()}회를 넘어 절약 모드로 바꿨습니다(분석 6초·60자마다, 키워드 자동 웹 검색 끔). 설정 → 비용에서 한도를 바꿀 수 있습니다.` }));
  setMicFailHandler(() => { if (S.running) void toggle(); });
  setInterval(() => { if ((S.running && !S.standby) || Date.now() - S.lastUserAct < 120000) keepWarm(); }, 15000);
  // the page never zooms: pinch, double-tap and ctrl+wheel are ignored (the board has its own zoom)
  ["gesturestart", "gesturechange", "gestureend"].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
  document.addEventListener("touchmove", (e) => { if (e.touches && e.touches.length > 1 && !(e.target as HTMLElement).closest?.("#boardView")) e.preventDefault(); }, { passive: false });
  document.addEventListener("wheel", (e) => { if ((e.ctrlKey || e.metaKey) && !(e.target as HTMLElement).closest?.("#boardView")) e.preventDefault(); }, { passive: false });
  let lastTouchEnd = 0; // iOS double-tap zoom outside the HUD
  document.addEventListener("touchend", (e) => { const now = Date.now(); if (now - lastTouchEnd < 300 && !(e.target as HTMLElement).closest?.("input,textarea,select,.callout,#boardView")) e.preventDefault(); lastTouchEnd = now; }, { passive: false });
  if (!speechSupported()) { /* the start button still works for typed transcripts */ }
}
