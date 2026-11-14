// All-day mode: after a quiet stretch (3 min; ms.sleepAfterMs for tests) the app sleeps — recogniser off (only when the
// gauge can listen instead), no AI calls, no HUD drawing, a dark screen with a clock — and wakes on a voice, on recognised
// words, or on a tap. Also the screen wake lock, which must be taken again whenever the system drops it.
import { $ } from "../util";
import { S } from "../state";
import { cfg } from "../settings/settings";
import { rs, pauseRec, startRec } from "../speech/recognizer";
import { vadLive } from "../speech/gauge";
import { wake } from "../hud/field";
import { setStatus } from "../controls";

export function enterStandby() {
  if (S.standby || !S.running) return; S.standby = true;
  // with the gauge running the recogniser can be switched off entirely; without it, the recogniser itself stays on as the ear
  if (vadLive()) pauseRec();
  $("sleepVeil").hidden = false; $("sleepMsg").textContent = vadLive() ? "대기 중 · 목소리가 들리면 깨어납니다" : "대기 중 · 말소리를 알아들으면 깨어납니다";
  clock(); setStatus();
}
export function wakeUp(_why: string) {
  if (!S.standby) return; S.standby = false; $("sleepVeil").hidden = true; rs.lastHeardAt = Date.now();
  if (S.running && !rs.wanted) startRec(); setStatus(); wake(1500);
}
const clock = () => { $("sleepClock").textContent = new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }); };

/* screen wake lock: a locked iPad cuts the microphone; the system releases the lock when the page hides, so take it again */
let wakeLock: any = null;
export async function holdScreen() {
  if (!S.running || wakeLock || !(navigator as any).wakeLock) return;
  try {
    wakeLock = await (navigator as any).wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; if (S.running && document.visibilityState === "visible") setTimeout(holdScreen, 500); });
  } catch { wakeLock = null; }
}
export function releaseScreen() { const w = wakeLock; wakeLock = null; try { w && w.release(); } catch { /* gone */ } }

export function initStandby() {
  $("sleepVeil").addEventListener("click", () => wakeUp("tap"));
  $("allDay").addEventListener("change", () => { if (!cfg.allDay && S.standby) wakeUp("setting"); });
  const sleepAfter = () => cfg.sleepAfterMs;
  setInterval(() => {
    if (S.standby) { clock(); return; }
    if (!cfg.allDay || !S.running) return;
    if (Date.now() - Math.max(rs.lastHeardAt, rs.lastResultAt) > sleepAfter()) enterStandby();
  }, Math.min(5000, Math.max(250, cfg.sleepAfterMs / 4)));
  document.addEventListener("visibilitychange", () => { if (S.running && document.visibilityState === "visible") void holdScreen(); });
}
