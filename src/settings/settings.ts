// Every user setting, read from localStorage under the legacy key names, plus the controls in the 설정 tab.
import { $ } from "../util";
import { ls } from "../storage/ls";

export type Pace = "balanced" | "fast" | "save";
export const LEAD_DEFAULT = "네, 장군님.";

export const cfg = {
  baseOn: ls.get("ms.baseOff") !== "1",
  libOn: ls.get("ms.libOff") !== "1",
  fixOn: ls.get("ms.fixOff") !== "1",
  fixDaily: ls.get("ms.fixDaily") === "1",
  instantOn: ls.get("ms.instantOff") !== "1",
  wikiOn: ls.get("ms.wikiOff") !== "1",
  visOn: ls.get("ms.visOff") !== "1",
  webMode: (ls.get("ms.webMode") || "conv") as "conv" | "always" | "off",
  power: (ls.get("ms.power") || "auto") as "auto" | "save" | "full",
  vadOn: ls.get("ms.vadOff") !== "1",
  allDay: ls.get("ms.allDay") === "1",
  sleepAfterMs: Number(ls.get("ms.sleepAfterMs")) || 3 * 60000,
  minTemplate: ls.get("ms.minTemplate"),
  answerLead: ((): string => { const v = ls.get("ms.answerLead"); return !v ? LEAD_DEFAULT : v === "__none__" ? "" : v; })(),
  pace: ((): Pace => { const v = ls.get("ms.pace"); return v === "fast" || v === "save" ? v : "balanced"; })(),
  dailyLimit: Math.max(0, Number(ls.get("ms.dailyLimit")) || 0),
  micHintOff: ls.get("ms.micHintOff") === "1",
  dayLogOn: ls.get("ms.dayLogOff") !== "1",
  daySumOn: ls.get("ms.daySumOff") !== "1",
};

/** analysis pacing: how long to wait after speech stops, the minimum gap between calls, how much new text, and a forced interval */
export interface PaceParams { idle: number; gap: number; minChars: number; maxWait: number }
export const PACES: Record<Pace, PaceParams> = {
  fast: { idle: 400, gap: 1000, minChars: 15, maxWait: 4000 }, // the legacy app
  balanced: { idle: 600, gap: 3000, minChars: 30, maxWait: 0 },
  save: { idle: 800, gap: 6000, minChars: 60, maxWait: 0 },
};

type Listener = () => void;
const listeners: Listener[] = [];
export const onSettingsChange = (f: Listener) => listeners.push(f);
const changed = () => listeners.forEach((f) => f());

function bindCheck(id: string, key: keyof typeof cfg, lsKey: string, storeWhenOn: boolean) {
  const el = $(id); if (!el) return;
  el.checked = !!cfg[key];
  el.addEventListener("change", () => {
    (cfg as any)[key] = el.checked;
    // legacy keys store "1" for the *off* state (ms.xxxOff), newer ones for the on state
    ls.set(lsKey, storeWhenOn ? (el.checked ? "1" : "") : el.checked ? "" : "1");
    changed();
  });
}

export function initSettingsUI() {
  bindCheck("fixOn", "fixOn", "ms.fixOff", false);
  bindCheck("fixDaily", "fixDaily", "ms.fixDaily", true);
  bindCheck("instantOn", "instantOn", "ms.instantOff", false);
  bindCheck("wikiOn", "wikiOn", "ms.wikiOff", false);
  bindCheck("visOn", "visOn", "ms.visOff", false);
  bindCheck("allDay", "allDay", "ms.allDay", true);
  bindCheck("dayLogOn", "dayLogOn", "ms.dayLogOff", false);
  bindCheck("daySumOn", "daySumOn", "ms.daySumOff", false);
  const wm = $("webMode"); wm.value = cfg.webMode;
  wm.addEventListener("change", () => { cfg.webMode = wm.value; ls.set("ms.webMode", wm.value); changed(); });
  const pw = $("powerMode"); pw.value = cfg.power;
  pw.addEventListener("change", () => { cfg.power = pw.value; ls.set("ms.power", pw.value === "auto" ? "" : pw.value); changed(); });
  const pace = $("pace"); pace.value = cfg.pace;
  pace.addEventListener("change", () => { cfg.pace = pace.value; ls.set("ms.pace", pace.value === "balanced" ? "" : pace.value); changed(); });
  const lim = $("dailyLimit"); lim.value = cfg.dailyLimit ? String(cfg.dailyLimit) : "";
  lim.addEventListener("change", () => { cfg.dailyLimit = Math.max(0, Math.round(Number(lim.value) || 0)); lim.value = cfg.dailyLimit ? String(cfg.dailyLimit) : ""; ls.set("ms.dailyLimit", cfg.dailyLimit || ""); changed(); });
  const lead = $("answerLead"); lead.value = cfg.answerLead;
  lead.addEventListener("change", () => { cfg.answerLead = lead.value.trim(); ls.set("ms.answerLead", cfg.answerLead || "__none__"); });
  const tpl = $("minTemplate"); tpl.value = cfg.minTemplate;
  $("saveTemplate").addEventListener("click", () => {
    cfg.minTemplate = tpl.value.trim(); ls.set("ms.minTemplate", cfg.minTemplate);
    $("tplMsg").textContent = cfg.minTemplate ? "양식을 저장했습니다." : "기본 양식을 사용합니다.";
  });
}
