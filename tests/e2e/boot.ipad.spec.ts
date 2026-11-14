import { test, expect } from "../harness/fixtures";
test("아이패드 모양에서도 오류 없이 뜬다", async ({ open }) => {
  const page = await open();
  await expect(page.locator("#status")).toHaveText("STANDBY");
  expect(await page.evaluate(() => navigator.maxTouchPoints > 0 || "ontouchstart" in window)).toBe(true);
});
