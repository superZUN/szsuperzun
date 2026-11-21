// 할 일 웹훅: a new task → { issue (English), pic, status: OPEN } through /api/hook to the saved flow URL (a local stand-in here).
import { test, expect, app } from "../harness/fixtures";
import { mockAI, type AICall } from "../harness/ai-mock";
import type { Page } from "@playwright/test";

const isHook = (c: AICall) => c.prompt.includes("concise English issue title");
const EN: Record<string, string> = { "고객사 견적서 회신": "Reply to customer quotation", "샘플 재측정": "Re-measure samples" };
const sinkOf = (page: Page, ns: string, fail = false) => `${new URL(page.url()).origin}/__test/hook-sink?ns=${ns}${fail ? "&fail=1" : ""}`;
const arrived = (page: Page, ns: string) => page.evaluate((n) => fetch(`/__test/hook-sink?ns=${n}`).then((r) => r.json()), ns);
async function setUrl(page: Page, url: string) { await page.click("#tabSet"); await page.fill("#hookUrl", url); await page.click("#hookSave"); }
async function addTodo(page: Page, line: string) { await page.click("#tabTodo"); await page.fill("#todoInput", line); await page.press("#todoInput", "Enter"); }

test("새 할 일 → 영문 issue·담당자 pic·OPEN으로 웹훅, 주소는 서버에만(화면·이 기기엔 안 남음)", async ({ open, page }) => {
  const ns = "h" + Date.now();
  await mockAI(page, (c) => { if (!isHook(c)) return "[]"; const k = Object.keys(EN).find((x) => c.prompt.includes(x)); return `"${k ? EN[k] : "Unknown"}."`; });
  await open({ key: true, storage: { "ms.passcode": "test-pass" } });
  await setUrl(page, sinkOf(page, ns));
  await expect(page.locator("#hookState")).toHaveText("연결됨 · localhost");
  await expect(page.locator("#hookMsg")).toContainText("저장했습니다");
  await expect(page.locator("#hookUrl")).toHaveValue("");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("hook-sink"); // the URL lives on the server only
  await addTodo(page, "고객사 견적서 회신 / 박지은 / 11/25");
  await addTodo(page, "샘플 재측정");
  await expect.poll(() => arrived(page, ns)).toEqual([
    { issue: "Reply to customer quotation", pic: "박지은", status: "OPEN" },
    { issue: "Re-measure samples", pic: "TBD", status: "OPEN" },
  ]);
  // the same task again only fills in details: nothing new is sent
  await addTodo(page, "샘플 재측정 / 김민수");
  await page.waitForTimeout(800);
  expect(await arrived(page, ns)).toHaveLength(2);
  // test button
  await page.click("#tabSet"); await page.click("#hookTest");
  await expect(page.locator("#hookMsg")).toContainText("시험 항목(JAY-WEBHOOK-TEST)을 보냈습니다");
  expect((await arrived(page, ns)).at(-1)).toEqual({ issue: "JAY-WEBHOOK-TEST", pic: "TBD", status: "OPEN" });
});

test("흐름이 받지 않으면 줄 세워 두었다가 다음 기회에 순서대로 보냄; 엉뚱한 주소는 거절", async ({ open, page }) => {
  const ns = "f" + Date.now();
  await mockAI(page, (c) => (isHook(c) ? (c.prompt.includes("견적서") ? "Reply to quotation" : "Check yield") : "[]"));
  await open({ key: true, storage: { "ms.passcode": "test-pass" } });
  await setUrl(page, "https://example.com/hook");
  await expect(page.locator("#hookMsg")).toContainText("powerplatform.com");
  await expect(page.locator("#hookState")).toHaveText("연결 안 됨");
  await setUrl(page, sinkOf(page, ns, true)); // the flow answers 500
  await addTodo(page, "견적서 회신 / 나");
  await page.click("#tabSet"); await expect(page.locator("#hookState")).toContainText("보낼 차례 1개");
  await setUrl(page, sinkOf(page, ns + "ok"));
  await addTodo(page, "수율 확인");
  await expect.poll(() => arrived(page, ns + "ok")).toEqual([
    { issue: "Reply to quotation", pic: "나", status: "OPEN" },
    { issue: "Check yield", pic: "TBD", status: "OPEN" },
  ]);
  expect(await app(page, "localStorage.getItem('ms.hook.queue')")).toBe("[]");
});

test("웹훅 주소가 없거나 서버 비밀번호가 없으면 할 일만 추가되고 아무것도 보내지 않음", async ({ open, page }) => {
  const ai = await mockAI(page, () => "[]");
  await open({ key: true });
  await addTodo(page, "견적서 회신");
  await expect.poll(() => app(page, "A.tasks.length")).toBe(1);
  await page.click("#tabSet"); await page.click("#hookSave");
  await expect(page.locator("#hookMsg")).toContainText("서버 동기화 비밀번호");
  expect(ai.calls.filter(isHook)).toHaveLength(0);
});

test("다른 기기에서 웹훅을 저장했는데 이 기기는 몰라도, 직접 추가한 할 일은 서버에 물어보고 보냄", async ({ open, page }) => {
  const ns = "d" + Date.now();
  await mockAI(page, (c) => (isHook(c) ? "Send the quotation" : "[]"));
  await open({ key: true, storage: { "ms.passcode": "test-pass" } });
  expect(await app(page, "A.hook.configured")).toBe(false);
  // saved from "another device": straight to the server
  await page.evaluate((u) => fetch("/api/hook", { method: "PUT", headers: { "content-type": "application/json", "x-passcode": "test-pass" }, body: JSON.stringify({ url: u }) }), sinkOf(page, ns));
  await addTodo(page, "견적서 보내기 / 나");
  await expect.poll(() => arrived(page, ns)).toEqual([{ issue: "Send the quotation", pic: "나", status: "OPEN" }]);
  expect(await app(page, "A.hook.configured")).toBe(true);
});

test("흐름이 한 건을 거절해도 뒤에 직접 추가한 할 일은 막히지 않고 바로 감, 상태에 문제 표시", async ({ open, page }) => {
  const ns = "b" + Date.now();
  await mockAI(page, (c) => (isHook(c) ? (c.prompt.includes("불량") ? "Analyze BAD defect" : "Book the meeting room") : "[]"));
  await open({ key: true, storage: { "ms.passcode": "test-pass" } });
  await setUrl(page, sinkOf(page, ns) + "&failOn=BAD");
  await addTodo(page, "불량 분석");
  await addTodo(page, "회의실 예약 / 박지은");
  await expect.poll(() => arrived(page, ns)).toEqual([{ issue: "Book the meeting room", pic: "박지은", status: "OPEN" }]);
  await page.click("#tabSet");
  await expect(page.locator("#hookState")).toContainText("보낼 차례 1개");
  await expect(page.locator("#hookDetail")).toContainText("문제: Power Automate가 받지 않음 (HTTP 500)");
  await expect(page.locator("#hookRetry")).toBeVisible();
});

test("이미 있는 할 일과 같아서 합쳐지면 알려 줌; 할 일 탭에서 지운 걸 실시간 '할 일' 칸에 다시 적으면 다시 추가·전송", async ({ open, page }) => {
  const ns = "m" + Date.now();
  await mockAI(page, (c) => (isHook(c) ? "Re-measure samples" : "[]"));
  await open({ key: true, storage: { "ms.passcode": "test-pass" } });
  await setUrl(page, sinkOf(page, ns));
  await page.click("#tabLive"); await page.click("#modeAct"); await page.fill("#actInput", "샘플 재측정"); await page.press("#actInput", "Enter");
  await expect.poll(() => arrived(page, ns)).toHaveLength(1);
  await addTodo(page, "샘플 재측정");
  await expect(page.locator("#todoDup")).toContainText("이미 있는 할 일 '샘플 재측정'과(와) 같아서 하나로 합쳤어요");
  // delete it in 할 일, then type it again in the live box
  await app(page, "(A.tasks.forEach(t => { t.deleted = true; }), 0)");
  await page.click("#tabLive"); await page.click("#modeAct"); await page.fill("#actInput", "샘플 재측정"); await page.press("#actInput", "Enter");
  await expect.poll(() => app(page, "A.tasks.filter(t => !t.deleted).length")).toBe(1);
  await expect.poll(() => arrived(page, ns)).toHaveLength(2);
});
