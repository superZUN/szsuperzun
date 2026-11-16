// 회의 유형 (일반 · 영어 · 기술 · 고객사): one tap on a button. "영어 회의" switches recognition to English, the others to Korean.
import { $ } from "../util";

export const MTYPES: Record<string, string> = { general: "일반 회의", english: "영어 회의", tech: "기술 논의", client: "고객·협력사 미팅" };
let cur = "general";
export const meetingType = () => cur;
export const meetingTypeLabel = () => MTYPES[cur] || MTYPES.general;
export function setMeetingType(v: string, opts: { switchLang?: boolean } = {}) {
  cur = MTYPES[v] ? v : "general";
  document.querySelectorAll<HTMLElement>("#mtype [data-mt]").forEach((b) => { const on = b.dataset.mt === cur; b.setAttribute("aria-checked", String(on)); b.setAttribute("aria-selected", String(on)); });
  if (opts.switchLang) { const want = cur === "english" ? "en-US" : "ko-KR"; if ($("lang").value !== want) { $("lang").value = want; $("lang").dispatchEvent(new Event("change")); } }
}
export function initMeetingType() {
  document.querySelectorAll<HTMLElement>("#mtype [data-mt]").forEach((b) => b.addEventListener("click", () => setMeetingType(b.dataset.mt!, { switchLang: true })));
}
