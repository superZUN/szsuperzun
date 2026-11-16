// The layout uses the whole screen width on every device, with no sideways scrolling.
import { test, expect } from "../harness/fixtures";

const SIZES = [
  { name: "휴대폰", width: 375, height: 760 }, { name: "아이패드 세로", width: 820, height: 1180 }, { name: "아이패드 가로", width: 1180, height: 820 },
  { name: "노트북", width: 1440, height: 900 }, { name: "큰 모니터", width: 2560, height: 1300 },
];
for (const s of SIZES) {
  test(`${s.name} ${s.width}px: 화면 폭을 다 쓰고 가로 스크롤 없음 (모든 탭)`, async ({ open, page }) => {
    await page.setViewportSize({ width: s.width, height: s.height });
    await open({});
    for (const tab of ["tabLive", "tabPrep", "tabKb", "tabTodo", "tabMind", "tabSet"]) {
      await page.click("#" + tab);
      const r = await page.evaluate(() => ({ app: document.querySelector(".app")!.getBoundingClientRect().width, vw: innerWidth, sw: document.documentElement.scrollWidth }));
      expect(r.sw, tab).toBeLessThanOrEqual(r.vw);
      expect(r.app / r.vw, tab).toBeGreaterThan(s.width <= 400 ? 0.93 : 0.96);
    }
    await page.click("#tabLive");
    if (s.width >= 1400) { // cards grow with a big screen, the mesh spreads out
      await page.fill("#memoInput", "넓은 화면 카드"); await page.press("#memoInput", "Enter");
      const w = await page.locator("#field .callout:not(.example)").first().evaluate((e) => e.getBoundingClientRect().width);
      expect(w).toBeGreaterThan(360);
    }
  });
}
test("넓은 화면에서 할 일·회의록·설정도 전체 폭", async ({ open, page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await open({});
  await page.click("#tabTodo");
  expect(await page.locator(".todo").evaluate((e) => e.getBoundingClientRect().width)).toBeGreaterThan(1800);
  await page.click("#tabSet");
  const cols = await page.locator("#setView .kb").evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(" ").length);
  expect(cols).toBeGreaterThanOrEqual(4);
});
