// Step 10 (iPad shape): no zoom, 16 px inputs, frame rate by activity, canvas resolution cap, reduced motion, aria-live.
import { test, expect, startListening, app } from "../harness/fixtures";
import type { Page } from "@playwright/test";

const fps = async (page: Page, ms = 1000) => { const f0 = (await app(page, "A.stats.frames")) as number; await page.waitForTimeout(ms); return (((await app(page, "A.stats.frames")) as number) - f0) * (1000 / ms); };

test("확대 고정: viewport, touch-action, 제스처·두 손가락·ctrl+휠 막기(보드 제외)", async ({ open, page }) => {
  await open({});
  expect(await page.getAttribute("meta[name=viewport]", "content")).toContain("maximum-scale=1,user-scalable=no");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe("manipulation");
  const prevented = await page.evaluate(() => {
    const g = new Event("gesturestart", { cancelable: true }); document.dispatchEvent(g);
    const w = new WheelEvent("wheel", { ctrlKey: true, cancelable: true, bubbles: true }); document.getElementById("field")!.dispatchEvent(w);
    const t = document.createElement("div"); document.getElementById("boardView")!.append(t);
    const wb = new WheelEvent("wheel", { ctrlKey: true, cancelable: true, bubbles: true }); t.dispatchEvent(wb);
    return { gesture: g.defaultPrevented, wheel: w.defaultPrevented, boardWheel: wb.defaultPrevented };
  });
  expect(prevented).toEqual({ gesture: true, wheel: true, boardWheel: true /* the board handles its own zoom */ });
});

test("터치 기기에서 입력칸 글자 16px 이상 (아이패드는 16px 미만 입력칸을 누르면 확대)", async ({ open, page }) => {
  await open({});
  const small = await page.evaluate(() => [...document.querySelectorAll("input,textarea,select")].map((e) => [e.id, parseFloat(getComputedStyle(e).fontSize)] as const).filter(([, s]) => s < 16));
  expect(small).toEqual([]);
});

test("프레임: 조용하면 15fps 이하, 말할 때 30fps 안팎, 다른 탭이면 0", async ({ open, page }) => {
  await open({});
  await startListening(page);
  await page.waitForTimeout(4500); // the start-up sample cards keep it at full rate for 2.5 s each
  const quiet = await fps(page);
  expect(quiet).toBeLessThanOrEqual(17);
  const talking = await page.evaluate(async () => {
    const A = (window as any).__app; const f0 = A.stats.frames;
    const t = setInterval(() => { A.S.level = Math.max(A.S.level, 0.5); }, 50);
    await new Promise((r) => setTimeout(r, 1000)); clearInterval(t); return A.stats.frames - f0;
  });
  expect(talking).toBeGreaterThanOrEqual(18); expect(talking).toBeLessThanOrEqual(36);
  await page.click("#tabTodo");
  expect(await fps(page, 800)).toBe(0);
});

test("캔버스 해상도 상한: 자동 1.5배, 최대 절약 1배", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, baseURL: "http://localhost:5173" });
  const page = await ctx.newPage();
  await page.goto("/"); await page.click("#tabLive"); await page.waitForTimeout(500);
  const ratio = () => page.evaluate(() => { const c = document.getElementById("hud") as HTMLCanvasElement; return c.width / parseFloat(c.style.width); });
  expect(await ratio()).toBeCloseTo(1.5, 2);
  await page.click("#tabSet"); await page.selectOption("#powerMode", "save"); await page.setViewportSize({ width: 1100, height: 820 }); await page.click("#tabLive"); await page.waitForTimeout(500);
  expect(await ratio()).toBeCloseTo(1, 2);
  await ctx.close();
});

test("동작 줄이기 설정이면 애니메이션 끔(제목 즉시), 새 카드는 aria-live로 알림", async ({ open, page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open({});
  await page.fill("#memoInput", "접근성 메모"); await page.press("#memoInput", "Enter");
  await expect(page.locator("#announce")).toHaveText("내 메모: 접근성 메모");
  expect(await page.locator("#announce").getAttribute("aria-live")).toBe("polite");
  await page.click("#modeAct"); await page.fill("#actInput", "즉시 보일 제목"); await page.press("#actInput", "Enter");
  await expect(page.locator("#field .callout.t-action .title")).toHaveText("즉시 보일 제목", { timeout: 300 });
  expect(await page.evaluate(() => getComputedStyle(document.querySelector("#field .callout") as Element).transitionDuration.split(",").every((d) => parseFloat(d) === 0))).toBe(true);
});

test("아이패드 Safari 모양에서 시작 → 게이지 표시, 오류 없음", async ({ open, page }) => {
  await open({});
  await startListening(page);
  await expect(page.locator("#micBar")).toBeVisible();
  await expect(page.locator("#micState")).not.toHaveText("—");
  expect(await app(page, "A.cfg.vadOn")).toBe(true);
});
