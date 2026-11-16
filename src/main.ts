// Jay (formerly 회의 옆자리) — boot. Modules set themselves up in this order; nothing runs at import time.
import "./styles.css";
import { $ } from "./util";
import { S } from "./state";
import { migrateSettings } from "./storage/ls";
import { openDB, loadDocs } from "./storage/idb";
import { initSettingsUI } from "./settings/settings";
import { refreshNote } from "./ai/client";
import { initGlossaryUI } from "./library/glossary";
import { rebuildIndex, syncDocsNow } from "./library/docs";
import { initLibraryUI } from "./library/ui";
import { initField } from "./hud/field";
import { addNode, initCardsUI } from "./hud/cards";
import { initBoard } from "./board/board";
import { initTranscriptUI, updateFixStat } from "./transcript";
import { initRecognizer } from "./speech/recognizer";
import { initGauge } from "./speech/gauge";
import { initMicCheck } from "./speech/miccheck";
import { initStandby } from "./power/standby";
import { initTopic } from "./analysis/topic";
import { initAnalyzeTicker, scheduleAnalyze } from "./analysis/analyze";
import { initKeywords } from "./analysis/keywords";
import { initAsk } from "./qa/ask";
import { preloadMermaid } from "./qa/visual";
import { initMinutesUI, markInterrupted } from "./minutes/minutes";
import { initPrep, renderAgBar, updatePrepCount } from "./meeting/prep";
import { initActions, renderActions } from "./meeting/actions";
import { initCarry } from "./meeting/carry";
import { initTasks } from "./tasks/tasks";
import { initSession, restoreSession, initialSnapshot } from "./meeting/session";
import { initControls, setStatus, showTab } from "./controls";
import { ai } from "./ai/client";
import { initDayLog, flushLog, LOG_TIMING } from "./memory/daylog";
import { initSummary, catchUp } from "./memory/summary";
import { renderLearn } from "./memory/learn";
import { initMindmap, mindState, weeklyMindmap } from "./mindmap/mindmap";
import { initCloud, cloud, CLOUD_TIMING } from "./speech/cloud";
import { cfg } from "./settings/settings";
import { usage } from "./ai/usage";
import { micCheckTiming } from "./speech/miccheck";
import { stats } from "./hud/field";
import { boardStats } from "./board/board";
import { cards } from "./hud/cards";
import { rs } from "./speech/recognizer";
import { vad } from "./speech/gauge";
import { tasks } from "./tasks/tasks";
import { M } from "./minutes/minutes";

migrateSettings();
initSettingsUI();
initControls();
initGlossaryUI(() => void syncDocsNow(false));
initLibraryUI();
initField(); initCardsUI(); initBoard();
initTranscriptUI(() => scheduleAnalyze());
initRecognizer(); initGauge(); initMicCheck(); initStandby();
initTopic(); initAnalyzeTicker(); initKeywords(); initAsk(); preloadMermaid();
initMinutesUI(); initPrep(() => showTab("tabPrep")); initActions(); initCarry(); initTasks(); initSession();
initDayLog(); initSummary(); renderLearn(); initMindmap(); initCloud();

setStatus(); refreshNote(); updateFixStat();
const restored = restoreSession(); renderAgBar(); updatePrepCount(); renderActions(); initialSnapshot();
if (!restored) [
  { type: "term", title: "SOH · State of Health", body: "배터리의 현재 용량을 신품 대비 비율로 나타낸 값입니다." },
  { type: "past", title: "샘플 납기 11/12 합의", body: "회의록에 '11/12까지 1차 샘플 전달'로 기록되어 있습니다.", source: "10/14 고객사 주간회의" },
  { type: "info", title: "'지난번 수준' = 수율 96.5%", body: "상대가 말한 '지난번 얘기한 수준'은 10/14 회의에서 합의한 Formation 수율 96.5%입니다." },
].reverse().forEach((x, i) => setTimeout(() => { if (!S.history.length) addNode(x, { example: true }); }, 400 + i * 500));
if (!ai.apiKey) showTab("tabSet");
void openDB().then(loadDocs).then(async (d) => { S.docs = d; markInterrupted(); rebuildIndex(); document.documentElement.dataset.docs = "1"; await syncDocsNow(false); setTimeout(() => void catchUp(), 3000); setTimeout(() => void weeklyMindmap(), 5000); });
/** read-only window into the app for the automated tests (and for debugging in the console) */
(window as any).__app = { S, cfg, ai, usage, micCheckTiming, stats, boardStats, cards, rs, vad, tasks, M, flushLog, LOG_TIMING, catchUp, mindState, weeklyMindmap, cloud, CLOUD_TIMING };
document.documentElement.dataset.ready = "1";
void $;
