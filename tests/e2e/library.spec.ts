// Step 9: importing documents (PDF, Word, PowerPoint, Excel, 한글, text, subtitles), the library list and reader,
// server sync between two devices, the 할 일 tab, and the archive board.
import { test, expect, app, FAKES } from "../harness/fixtures";
import { docx, pptx, xlsx, hwpx, pdf } from "../harness/files";
import type { Browser, Page } from "@playwright/test";

const ev = (page: Page, js: string) => page.evaluate(js);
const doc = (page: Page, name: string) => page.evaluate((n) => (window as any).__app.S.docs.find((d: any) => d.name === n)?.text ?? null, name);
async function upload(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.click("#tabKb"); await page.setInputFiles("#fileInput", files);
}
/** a second "device": its own browser context (own IndexedDB / localStorage), same server data */
async function device(browser: Browser, ns: string, storage: Record<string, string>) {
  const ctx = await browser.newContext({ baseURL: "http://localhost:5173" });
  const p = await ctx.newPage();
  await p.addInitScript({ path: FAKES });
  await p.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort("failed"));
  await p.route("**/api/**", (r) => r.continue({ headers: { ...r.request().headers(), "x-test-ns": ns } }));
  await p.addInitScript((s) => { if (!sessionStorage.getItem("__seeded")) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v as string); sessionStorage.setItem("__seeded", "1"); } }, storage);
  await p.goto("/"); await expect(p.locator("html[data-docs='1']")).toHaveCount(1);
  return p;
}

test.describe("자료 가져오기", () => {
  test("Word·PowerPoint(노트 포함)·Excel(시트별)·한글·PDF(쪽별)", async ({ open, page }) => {
    await open({});
    await upload(page, [
      { name: "사양서.docx", mimeType: "application/octet-stream", buffer: await docx(["셀 사양서", "Formation 전압 4.2V &amp; 온도 45℃"]) },
      { name: "발표.pptx", mimeType: "application/octet-stream", buffer: await pptx([{ text: ["1분기 실적", "수율 96.5%"], note: "발표자 노트: 강조할 것" }, { text: ["다음 계획"] }]) },
      { name: "데이터.xlsx", mimeType: "application/octet-stream", buffer: await xlsx({ "라인별": [["라인", "투입", "양품"], ["Form #01", 1000, 965]], "요약": [["합계", 965]] }) },
      { name: "보고서.hwpx", mimeType: "application/octet-stream", buffer: await hwpx(["한글 보고서 첫 문단", "둘째 문단"]) },
      { name: "spec.pdf", mimeType: "application/pdf", buffer: pdf([["Formation yield 96.5 percent", "Second line"], ["Page two text here"]]) },
    ]);
    await expect(page.locator("#uploadMsg")).toContainText("spec.pdf 저장됨", { timeout: 15000 });
    expect(await doc(page, "사양서")).toBe("셀 사양서\nFormation 전압 4.2V & 온도 45℃");
    expect(await doc(page, "발표")).toBe("## 슬라이드 1\n1분기 실적\n수율 96.5%\n(노트) 발표자 노트: 강조할 것\n\n## 슬라이드 2\n다음 계획");
    expect(await doc(page, "데이터")).toBe("## 시트: 라인별\n라인 | 투입 | 양품\nForm #01 | 1000 | 965\n\n## 시트: 요약\n합계 | 965");
    expect(await doc(page, "보고서")).toBe("한글 보고서 첫 문단\n둘째 문단");
    expect(await doc(page, "spec")).toBe("## 1쪽\nFormation yield 96.5 percent\nSecond line\n\n## 2쪽\nPage two text here");
    await expect(page.locator("#kbCount")).toHaveText("5");
  });

  test("TXT·MD·CSV·SRT(시간 제거)·VTT, 여러 개 한꺼번에", async ({ open, page }) => {
    await open({});
    await upload(page, [
      { name: "메모.txt", mimeType: "text/plain", buffer: Buffer.from("그냥 텍스트") },
      { name: "노트.md", mimeType: "text/markdown", buffer: Buffer.from("# 제목\n- 항목") },
      { name: "표.csv", mimeType: "text/csv", buffer: Buffer.from("a,b\n1,2") },
      { name: "자막.srt", mimeType: "text/plain", buffer: Buffer.from("1\n00:00:01,000 --> 00:00:03,000\n안녕하세요\n\n2\n00:00:04,000 --> 00:00:06,000\n회의를 시작합니다\n") },
      { name: "자막2.vtt", mimeType: "text/vtt", buffer: Buffer.from("WEBVTT\n\n00:00.000 --> 00:02.000\n첫 줄\n") },
    ]);
    await expect(page.locator("#uploadMsg")).toContainText("자막2.vtt 저장됨");
    expect(await doc(page, "자막")).toBe("안녕하세요\n\n회의를 시작합니다");
    expect(await doc(page, "자막2")).toBe("첫 줄");
    expect(await doc(page, "표")).toBe("a,b\n1,2");
  });

  test("못 읽는 파일은 이유와 방법을 알려 줌: 스캔 PDF·.hwp·사진", async ({ open, page }) => {
    await open({});
    await upload(page, [
      { name: "스캔.pdf", mimeType: "application/pdf", buffer: pdf([[], []]) },
      { name: "옛한글.hwp", mimeType: "application/octet-stream", buffer: Buffer.from("x") },
      { name: "사진.jpg", mimeType: "image/jpeg", buffer: Buffer.from("x") },
    ]);
    await expect(page.locator("#uploadMsg")).toContainText("사진은 아직 읽을 수 없습니다", { timeout: 15000 });
    await expect(page.locator("#uploadMsg")).toContainText("글자가 없는 스캔 PDF 같습니다");
    await expect(page.locator("#uploadMsg")).toContainText("HWPX 또는 PDF");
    await expect(page.locator("#kbCount")).toHaveText("0");
  });

  test("붙여넣기 저장, 목록 검색·미리보기, 문서 보기 검색어 강조, 삭제는 두 번 확인", async ({ open, page }) => {
    await open({});
    await page.click("#tabKb");
    await page.fill("#pasteName", "10/28 셀 라인 주간회의"); await page.fill("#pasteText", "# 회의\n- IR 불량 재측정\n- 납기 11/20"); await page.click("#pasteSave");
    await page.fill("#pasteName", "다른 회의"); await page.fill("#pasteText", "점심 메뉴 이야기"); await page.click("#pasteSave");
    await expect(page.locator("#docList .doc")).toHaveCount(2);
    await page.fill("#docSearch", "IR 불량");
    await expect(page.locator("#docList .doc")).toHaveCount(1);
    await expect(page.locator("#docList .snip")).toContainText("IR 불량 재측정");
    await page.locator("#docList .doc .name").click();
    await expect(page.locator("#docOut mark")).toHaveText("IR 불량");
    await page.click("#docClose");
    const del = page.locator("#docList .doc .del");
    await del.click(); await expect(del).toHaveText("한 번 더");
    await expect(page.locator("#kbCount")).toHaveText("2");
    await del.click();
    await expect(page.locator("#kbCount")).toHaveText("1");
  });
});

test.describe("서버 동기화 (두 기기)", () => {
  test("회의록: 올리면 다른 기기가 받아오고(☁), 지우면 다른 기기에서도 정리", async ({ open, page, browser, ns }) => {
    await open({ storage: { "ms.passcode": "test-pass" } });
    await page.click("#tabKb");
    await page.fill("#pasteName", "공유 회의록"); await page.fill("#pasteText", "다른 기기에서도 보여야 함"); await page.click("#pasteSave");
    await expect(page.locator("#docList")).toContainText("☁ 공유 회의록");
    const b = await device(browser, ns, { "ms.passcode": "test-pass" });
    await b.click("#tabKb");
    await expect(b.locator("#docList")).toContainText("☁ 공유 회의록");
    await expect(b.locator("#syncMsg")).toContainText("1개 받아옴");
    const del = page.locator("#docList .doc .del"); await del.click(); await del.click();
    await expect(page.locator("#kbCount")).toHaveText("0");
    await b.click("#syncDocs");
    await expect(b.locator("#syncMsg")).toContainText("다른 기기에서 지운 1개 정리");
    await expect(b.locator("#kbCount")).toHaveText("0");
    await b.context().close();
  });

  test("서버 암호가 틀리면 사람 말로 알려 주고 이 기기 자료는 그대로", async ({ open, page }) => {
    await open({ storage: { "ms.passcode": "wrong" } });
    await page.click("#tabKb");
    await page.fill("#pasteName", "로컬"); await page.fill("#pasteText", "로컬 자료"); await page.click("#pasteSave");
    await page.click("#syncDocs");
    await expect(page.locator("#syncMsg")).toContainText("서버 비밀번호가 맞지 않습니다. 이 기기의 회의록은 그대로 있습니다.");
    await expect(page.locator("#kbCount")).toHaveText("1");
  });

  test("용어 사전: 서버 저장 → 다른 기기에서 불러오기", async ({ open, page, browser, ns }) => {
    await open({});
    await page.click("#tabSet");
    await page.fill("#passcode", "test-pass"); await page.fill("#glossary", "NSE = NextStar Energy\n셀 라인 3호기 · 오인식: 쎌라인");
    await page.click("#saveGloss");
    await expect(page.locator("#glossMsg")).toContainText("2개 용어를 서버에 저장했습니다");
    const b = await device(browser, ns, { "ms.passcode": "test-pass" });
    await expect.poll(() => b.evaluate(() => localStorage.getItem("ms.glossary"))).toBe("NSE = NextStar Energy\n셀 라인 3호기 · 오인식: 쎌라인");
    await b.context().close();
  });
});

test.describe("할 일 탭", () => {
  test("추가(날짜 슬래시), 기한 표시(지남 빨강·D-n), 탭 옆 남은 개수", async ({ open, page }) => {
    await open({});
    await page.click("#tabTodo");
    const d = new Date(); const past = `${d.getMonth() + 1}/${Math.max(1, d.getDate() - 1)}`;
    const soon = new Date(Date.now() + 2 * 864e5); const soonS = `${soon.getMonth() + 1}/${soon.getDate()}`;
    await page.fill("#todoInput", `지난 일 / 김민수 / ${d.getDate() > 1 ? past : "2020-01-01"}`); await page.press("#todoInput", "Enter");
    await page.fill("#todoInput", `곧 할 일 / 박지은 / ${soonS}`); await page.press("#todoInput", "Enter");
    await page.fill("#todoInput", "기한 없는 일"); await page.press("#todoInput", "Enter");
    await expect(page.locator("#todoList .tswipe")).toHaveCount(3);
    await expect(page.locator("#todoList .tswipe").first()).toContainText("지난 일");
    await expect(page.locator("#todoList .tdue.over")).toHaveText("지남");
    await expect(page.locator("#todoList .tswipe", { hasText: "곧 할 일" }).locator(".tdue.soon")).toHaveText(/D-[23]/);
    await expect(page.locator("#todoList .tswipe", { hasText: "곧 할 일" })).toContainText("담당 박지은");
    await expect(page.locator("#todoCount")).toHaveText("3");
    await expect(page.locator("#todoCount")).toHaveClass(/over/);
  });

  test("체크하면 결과 한 줄 입력칸이 바로 열리고, Enter로 완료 목록으로", async ({ open, page }) => {
    await open({});
    await page.click("#tabTodo");
    await page.fill("#todoInput", "고객사 통보"); await page.press("#todoInput", "Enter");
    await page.locator("#todoList input[type=checkbox]").check();
    const res = page.locator("#todoList textarea[data-res]");
    await expect(res).toBeFocused();
    await res.fill("11/20 납기 확정 통보 완료"); await res.press("Enter");
    await expect(page.locator("#todoList .tswipe")).toHaveCount(0);
    await page.click("#todoF_done");
    await expect(page.locator("#todoList .tres")).toHaveText("결과 · 11/20 납기 확정 통보 완료");
    await expect(page.locator("#todoCount")).toHaveText("");
  });

  test("누르면 편집(결과·내용·담당·기한), 검색", async ({ open, page }) => {
    await open({});
    await page.click("#tabTodo");
    await page.fill("#todoInput", "샘플 재측정"); await page.press("#todoInput", "Enter");
    await page.fill("#todoInput", "견적 회신"); await page.press("#todoInput", "Enter");
    await page.locator("#todoList .tmain", { hasText: "샘플 재측정" }).click();
    const owner = page.locator(".tedit label", { hasText: "담당" }).locator("input"); await owner.fill("박지은"); await owner.dispatchEvent("change");
    await page.getByRole("button", { name: "닫기" }).click();
    await expect(page.locator("#todoList .tswipe", { hasText: "샘플 재측정" })).toContainText("담당 박지은");
    await page.fill("#todoSearch", "박지은");
    await expect(page.locator("#todoList .tswipe")).toHaveCount(1);
  });

  test("좌우로 밀어 삭제(폭 1/3 이상) + 5초 되돌리기, 조금 밀면 제자리", async ({ open, page }) => {
    await open({});
    await page.click("#tabTodo");
    await page.fill("#todoInput", "밀어서 지울 일"); await page.press("#todoInput", "Enter");
    const row = page.locator("#todoList .tswipe").first(); const b = (await row.boundingBox())!;
    const swipe = async (dx: number) => { await page.mouse.move(b.x + b.width * 0.6, b.y + b.height / 2); await page.mouse.down(); for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + b.width * 0.6 + (dx * i) / 8, b.y + b.height / 2 + 2); await page.mouse.up(); };
    await swipe(-b.width * 0.2);
    await page.waitForTimeout(300);
    await expect(page.locator("#todoList .tswipe")).toHaveCount(1);
    await swipe(-b.width * 0.45);
    await expect(page.locator("#todoList .tswipe")).toHaveCount(0);
    await expect(page.locator("#todoUndo")).toBeVisible();
    await expect(page.locator("#todoUndoMsg")).toHaveText("'밀어서 지울 일' 삭제됨");
    await page.click("#todoUndoBtn");
    await expect(page.locator("#todoList .tswipe")).toHaveCount(1);
  });

  test("두 기기가 서로 다른 할 일을 고쳐도 덮어쓰지 않음, 삭제도 전달", async ({ open, page, browser, ns }) => {
    await open({ storage: { "ms.passcode": "test-pass" } });
    await page.click("#tabTodo");
    await page.fill("#todoInput", "A 기기 일"); await page.press("#todoInput", "Enter");
    await page.fill("#todoInput", "같이 볼 일"); await page.press("#todoInput", "Enter");
    await expect(page.locator("#todoSync")).toContainText("서버와 동기화됨", { timeout: 4000 });
    const b = await device(browser, ns, { "ms.passcode": "test-pass" });
    await b.click("#tabTodo");
    await expect(b.locator("#todoList .tswipe")).toHaveCount(2, { timeout: 4000 });
    // device B ticks one; device A edits the other
    await b.locator("#todoList .tswipe", { hasText: "같이 볼 일" }).locator("input[type=checkbox]").check();
    await page.locator("#todoList .tmain", { hasText: "A 기기 일" }).click();
    const owner = page.locator(".tedit label", { hasText: "담당" }).locator("input"); await owner.fill("김민수"); await owner.dispatchEvent("change");
    await page.waitForTimeout(1500); await b.waitForTimeout(500);
    await page.click("#tabLive"); await page.click("#tabTodo"); await page.click("#todoF_all");
    await expect(page.locator("#todoList .tswipe.done, #todoList .trow.done")).toHaveCount(1, { timeout: 4000 });
    await expect(page.locator("#todoList .tswipe", { hasText: "A 기기 일" })).toContainText("담당 김민수");
    await b.click("#tabLive"); await b.click("#tabTodo"); await b.click("#todoF_all");
    await expect(b.locator("#todoList .tswipe", { hasText: "A 기기 일" })).toContainText("담당 김민수");
    await b.context().close();
  });

  test("준비 탭 이월 목록과 완료 상태가 양방향으로 맞춰짐", async ({ open, page }) => {
    await open({ storage: { "ms.carry": JSON.stringify({ from: "지난 주간회의", items: [{ text: "샘플 재측정", owner: "박지은", done: false }] }) } });
    await page.click("#tabTodo");
    await expect(page.locator("#todoList .tswipe")).toContainText("샘플 재측정");
    await page.locator("#todoList input[type=checkbox]").check();
    await page.click("#tabPrep");
    await expect(page.locator("#carryList .citem.done")).toHaveCount(1);
    await page.locator("#carryList input[type=checkbox]").uncheck();
    await page.click("#tabTodo");
    await expect(page.locator("#todoList .trow.done")).toHaveCount(0);
    await expect(page.locator("#todoList .tswipe")).toHaveCount(1);
  });
});

test.describe("기록 보드", () => {
  async function fill(page: Page, n: number) {
    await page.evaluate((n) => {
      const A = (window as any).__app;
      for (let i = 0; i < n; i++) A.S.history.unshift({ id: 1000 + i, type: i % 3 ? "info" : "term", title: `카드 ${i}`, body: i === 7 ? "납기 11/20 확정" : `내용 ${i}`, source: "", links: [], kw: "", img: null, time: "10:00:00" });
    }, n);
  }
  test("120장도 가볍게: 화면 근처만 붙이고, 열려 있는 동안 HUD 멈춤", async ({ open, page }) => {
    await open({});
    await fill(page, 120);
    await page.click("#histBtn");
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#boardCount")).toHaveText("120 / 120");
    const n = await app(page, "A.boardStats().attached") as number;
    expect(n).toBeGreaterThan(5); expect(n).toBeLessThan(70);
    const f0 = await app(page, "A.stats.frames") as number; await page.waitForTimeout(600);
    expect(await app(page, "A.stats.frames")).toBe(f0);
    await page.click("#boardClose");
    await expect.poll(() => app(page, "A.stats.frames")).toBeGreaterThan(f0);
  });

  test("검색(일치만 위로·강조), 종류 필터, 목록 보기, 카드 눌러 상세 → 화면에 다시 띄우기", async ({ open, page }) => {
    await open({});
    await fill(page, 20);
    await page.click("#histBtn");
    await page.fill("#boardSearch", "납기");
    await expect(page.locator("#boardCount")).toHaveText("1 / 20");
    await expect(page.locator("#boardPlane .bcard mark")).toHaveText("납기");
    await page.fill("#boardSearch", "");
    await page.locator("#boardTypes button[data-type='term']").click();
    await expect(page.locator("#boardCount")).toHaveText("7 / 20");
    await page.click("#boardList"); await expect(page.locator("#histSheet")).toBeVisible(); await page.click("#histClose");
    await page.locator("#boardPlane .bcard").first().click();
    await page.getByRole("button", { name: "화면에 다시 띄우기" }).click();
    await expect(page.locator("#board")).toBeHidden();
    await expect(page.locator("#field .callout.t-term")).toHaveCount(1);
  });

  test("판 끌기 = 둘러보기, ctrl+휠 = 확대(0.35~1.8), 카드 끌기 = 옮기기", async ({ open, page }) => {
    await open({});
    await fill(page, 30);
    await page.click("#histBtn");
    const v = (await page.locator("#boardView").boundingBox())!;
    const before = await page.locator("#boardPlane").evaluate((e) => e.style.transform);
    await page.mouse.move(v.x + v.width - 20, v.y + v.height - 20); await page.mouse.down(); await page.mouse.move(v.x + v.width - 220, v.y + v.height - 120, { steps: 5 }); await page.mouse.up();
    await expect.poll(() => page.locator("#boardPlane").evaluate((e) => e.style.transform)).not.toBe(before);
    await page.mouse.move(v.x + 300, v.y + 300);
    for (let i = 0; i < 10; i++) { await page.keyboard.down("Control"); await page.mouse.wheel(0, 200); await page.keyboard.up("Control"); }
    await expect.poll(() => app(page, "A.boardStats().scale")).toBe(0.35);
    for (let i = 0; i < 20; i++) { await page.keyboard.down("Control"); await page.mouse.wheel(0, -200); await page.keyboard.up("Control"); }
    await expect.poll(() => app(page, "A.boardStats().scale")).toBe(1.8);
    await page.click("#boardTidy");
    const card = page.locator("#boardPlane .bcard").first(); const cb = (await card.boundingBox())!;
    await page.mouse.move(cb.x + 30, cb.y + 20); await page.mouse.down(); await page.mouse.move(cb.x + 230, cb.y + 120, { steps: 6 }); await page.mouse.up();
    const after = (await card.boundingBox())!;
    expect(after.x - cb.x).toBeGreaterThan(150);
    await expect(page.locator("#focusVeil")).toBeHidden();
  });
});
