// Step 4: speech recognition (restart only when needed, stuck sentences, duplicates, permissions), the mic gauge,
// the mic check, all-day standby, the screen wake lock.
import { test, expect, startListening, app } from "../harness/fixtures";
import type { Page } from "@playwright/test";

const ev = (page: Page, js: string) => page.evaluate(js);
const transcript = (page: Page) => app(page, "A.S.segs.map(s => s.fix ?? s.raw).join(' | ')") as Promise<string>;
const counts = (page: Page) => ev(page, "({ starts: window.__recStarts, instances: window.__sr.instances.length })") as Promise<{ starts: number; instances: number }>;

test.describe("음성 인식", () => {
  test("시작하면 게이지 줄: MIC 막대·상태, 인식 상태, 마이크 점검 버튼", async ({ open, page }) => {
    await open({});
    await startListening(page);
    await expect(page.locator("#micBar")).toBeVisible();
    await expect(page.locator("#recState")).toHaveText("듣는 중");
    await expect(page.locator("#micCheckBtn")).toBeVisible();
    await expect(page.locator("#status")).toHaveText("LISTENING");
    await expect(page.locator("#startBtn")).toHaveText("멈춤");
    await ev(page, "window.__say('안녕하세요 반갑습니다')");
    await expect(page.locator("#recState")).toHaveText("알아듣는 중");
    expect(await transcript(page)).toBe("안녕하세요 반갑습니다");
    await page.click("#startBtn");
    await expect(page.locator("#micBar")).toBeHidden();
    await expect(page.locator("#status")).toHaveText("STANDBY");
  });

  test("게이지: 말소리 / 60Hz 웅웅거림은 말소리 아님 / 8초 무입력 → 마이크 확인", async ({ open, page }) => {
    await page.clock.install();
    await open({});
    await startListening(page);
    await expect.poll(() => app(page, "!!A.vad.timer")).toBe(true);
    await ev(page, "window.__mic.set({ voice: 1 })"); await page.clock.runFor(800);
    await expect(page.locator("#micState")).toHaveText("말소리");
    await ev(page, "window.__mic.set({ voice: 0, hum: 1 })"); await page.clock.runFor(1600);
    await expect(page.locator("#micState")).toHaveText("조용함");
    await ev(page, "window.__mic.set({ voice: 0, hum: 0 })"); await page.clock.runFor(9000);
    await expect(page.locator("#micState")).toHaveText("입력 없음 — 마이크 확인");
  });

  test("대안 3개 중 용어사전 표기가 든 것을 고름 (업무 대화)", async ({ open, page }) => {
    await open({});
    await startListening(page);
    await ev(page, "window.__say('에서 이 아이 형성이 늦어요', { alts: ['SEI 형성이 늦어요'] })");
    expect(await transcript(page)).toBe("SEI 형성이 늦어요");
  });

  test("멈춘 문장(2초)은 확정만 — 재시작 없음, 뒤에 온 같은 문장은 겹치는 부분 제거", async ({ open, page }) => {
    await open({});
    await startListening(page);
    await ev(page, "window.__interim('샘플 납기는 다음 주')");
    await expect.poll(() => transcript(page), { timeout: 4000 }).toBe("샘플 납기는 다음 주");
    expect(await counts(page)).toEqual({ starts: 1, instances: 1 });
    await ev(page, "window.__say('샘플 납기는 다음 주 금요일입니다')");
    expect(await transcript(page)).toBe("샘플 납기는 다음 주 | 금요일입니다");
    await ev(page, "window.__interim('수율은 96%')");
    await expect.poll(() => transcript(page), { timeout: 4000 }).toContain("수율은 96%");
    await ev(page, "window.__say('수율은 96%')"); // the same sentence again as a final: dropped
    expect((await transcript(page)).match(/수율은 96%/g)).toHaveLength(1);
  });

  test("다음 문장 앞에 이전 문장이 다시 붙어 오면 새 부분만", async ({ open, page }) => {
    await open({});
    await startListening(page);
    await ev(page, "window.__say('첫 번째 안건입니다')");
    await ev(page, "window.__say('첫 번째 안건입니다 두 번째는 일정입니다')");
    expect(await transcript(page)).toBe("첫 번째 안건입니다 | 두 번째는 일정입니다");
  });

  test("브라우저가 끝내면 같은 인스턴스로 다시 켬 (새 인스턴스 아님)", async ({ open, page }) => {
    await open({});
    await startListening(page);
    await ev(page, "window.__end()");
    await expect.poll(() => counts(page)).toEqual({ starts: 2, instances: 1 });
    await expect.poll(() => ev(page, "!!window.__sr.live")).toBe(true);
    await expect(page.locator("#recCount")).toHaveText("다시 켬 1회");
  });

  test("주기적 새로 고침 재시작 없음: 2분 동안 말이 이어져도 인스턴스 1개", async ({ open, page }) => {
    await page.clock.install();
    await open({ storage: { "ms.vadOff": "1" } });
    await page.click("#startBtn"); await page.clock.runFor(100);
    for (let i = 0; i < 12; i++) { await ev(page, `window.__say('문장 ${i}번입니다')`); await page.clock.runFor(10000); }
    expect(await counts(page)).toEqual({ starts: 1, instances: 1 });
  });

  test("30초 동안 아무 이벤트 없으면 죽은 것으로 보고 새 인스턴스 (게이지 없음)", async ({ open, page }) => {
    await page.clock.install();
    await open({ storage: { "ms.vadOff": "1" } });
    await page.click("#startBtn"); await page.clock.runFor(100);
    await page.clock.runFor(25000);
    expect((await counts(page)).instances).toBe(1);
    await page.clock.runFor(7000);
    expect((await counts(page)).instances).toBe(2);
  });

  test("소리는 들리는데 글자가 없으면 재시작, 두 번 소용없으면 쉼", async ({ open, page }) => {
    await page.clock.install();
    await open({});
    await page.click("#startBtn"); await page.clock.runFor(200);
    await expect.poll(() => app(page, "!!A.vad.timer")).toBe(true);
    // someone talking (with the short pauses real speech has), but the recogniser returns nothing
    const talk = async (ms: number) => { for (let t = 0; t < ms; t += 1000) { await ev(page, "window.__mic.set({ voice: 1 })"); await page.clock.runFor(800); await ev(page, "window.__mic.set({ voice: 0 })"); await page.clock.runFor(200); } };
    await talk(3000);
    await expect(page.locator("#recState")).toHaveText("소리는 들리는데 글자가 안 나옴");
    await talk(1000);
    expect((await counts(page)).instances).toBe(2);
    await talk(8000);
    expect((await counts(page)).instances).toBe(3);
    await talk(9000); // the third time it rests instead of restarting
    expect(await app(page, "A.vad.pauseUntil > Date.now()")).toBe(true);
    expect((await counts(page)).instances).toBe(3);
  });

  test("처음부터 마이크 거부면 멈추고 안내", async ({ open, page }) => {
    await open({});
    await ev(page, "window.__sr.denyStarts = 1");
    await page.click("#startBtn");
    await expect(page.locator("#startBtn")).toHaveText("시작");
    await expect(page.locator("#aiNote")).toContainText("마이크 사용이 막혀 있어요");
  });

  test("세션 도중 not-allowed는 1.2초 뒤 다시 시도, 듣기는 계속", async ({ open, page }) => {
    await open({});
    await startListening(page);
    await ev(page, "window.__err('not-allowed')");
    await expect(page.locator("#micHint")).toBeVisible();
    await expect(page.locator("#micHintMsg")).toContainText("마이크 허용이 끊겨");
    await expect.poll(() => counts(page), { timeout: 4000 }).toEqual({ starts: 2, instances: 2 });
    await expect(page.locator("#startBtn")).toHaveText("멈춤");
    await expect.poll(() => ev(page, "!!window.__sr.live")).toBe(true);
  });

  test("시작이 매번 1.5초 넘게 걸리면(=허용을 묻는 중) 영구 허용 안내", async ({ open, page }) => {
    await open({});
    await ev(page, "window.__sr.startDelay = 1600");
    await page.click("#startBtn");
    await expect.poll(() => ev(page, "!!window.__sr.live"), { timeout: 4000 }).toBe(true);
    await expect(page.locator("#micHint")).toBeHidden();
    await ev(page, "window.__end()");
    await expect(page.locator("#micHint")).toBeVisible({ timeout: 4000 });
    await expect(page.locator("#micHintMsg")).toContainText("허용을 자꾸 묻고");
    await page.click("#micHintClose");
    expect(await ev(page, "localStorage.getItem('ms.micHintOff')")).toBe("1");
  });

  test("인식이 audio-capture를 내면 게이지가 양보하고 인식은 다시 켜짐", async ({ open, page }) => {
    await open({});
    await startListening(page);
    await expect.poll(() => app(page, "!!A.vad.timer")).toBe(true);
    await ev(page, "window.__err('audio-capture')");
    await expect(page.locator("#micState")).toHaveText("막대 끔 (마이크를 인식에 양보)");
    await expect.poll(() => counts(page)).toEqual({ starts: 2, instances: 2 });
    await expect(page.locator("#startBtn")).toHaveText("멈춤");
    expect(await ev(page, "localStorage.getItem('ms.vadOff')")).toBeNull(); // not switched off for good
  });

  test("Chrome phrases 힌트(최대 120개), 지원 안 하면 끄고 재시작", async ({ open, page }) => {
    await open({ storage: { "ms.glossary": "NSE = NextStar Energy" } });
    await ev(page, "window.__sr.phrases = true");
    await startListening(page);
    const n = await ev(page, "window.__sr.live.phrases.length") as number;
    expect(n).toBeGreaterThan(50); expect(n).toBeLessThanOrEqual(120);
    expect(await ev(page, "window.__sr.live.phrases.map(p => p.phrase).includes('NSE')")).toBe(true);
    await ev(page, "window.__err('phrases-not-supported', { end: false })");
    await expect.poll(() => counts(page)).toEqual({ starts: 2, instances: 2 });
    expect(await ev(page, "window.__sr.instances[1].phrases.length")).toBe(0);
  });
});

test.describe("화면 꺼짐 방지", () => {
  test("시작하면 Wake Lock, 시스템이 풀면 다시 잡음, 멈추면 놓음", async ({ open, page }) => {
    await open({});
    await startListening(page);
    await expect.poll(() => ev(page, "window.__wake.requests")).toBe(1);
    await ev(page, "window.__wake.release()");
    await expect.poll(() => ev(page, "window.__wake.requests"), { timeout: 3000 }).toBe(2);
    await expect.poll(() => ev(page, "!!window.__wake.active")).toBe(true);
    await page.click("#startBtn");
    await expect.poll(() => ev(page, "!!window.__wake.active")).toBe(false);
    await page.waitForTimeout(800);
    expect(await ev(page, "window.__wake.requests")).toBe(2);
  });
});

test.describe("마이크 점검", () => {
  const fast = "Object.assign(A.micCheckTiming, { meterMs: 700, recMs: 1200, gapMs: 50 })";
  const runCheck = async (page: Page, voice: number, say: string | null) => {
    await app(page, fast);
    await ev(page, `window.__mic.set({ voice: ${voice} })`);
    if (await page.locator("#micCheckBtn").isVisible()) await page.click("#micCheckBtn"); else { await page.click("#tabSet"); await page.click("#micCheckBtn2"); }
    await expect(page.locator("#mcStep")).toContainText("②", { timeout: 5000 });
    if (say) { await expect.poll(() => ev(page, "!!window.__sr.live")).toBe(true); await ev(page, `window.__say(${JSON.stringify(say)})`); }
    await expect(page.locator("#mcStep")).toHaveText("결과", { timeout: 6000 });
    return page.locator("#mcResult").getAttribute("data-kind");
  };
  test("둘이 부딪힘(각자는 정상) → '게이지 끄고 인식만 쓰기', 끝나면 듣기 복귀", async ({ open, page }) => {
    await open({});
    await startListening(page);
    expect(await runCheck(page, 1, "테스트 문장입니다")).toBe("conflict");
    await expect(page.locator("#mcResult")).toContainText("게이지(음성 감지)를 끄면");
    await page.getByRole("button", { name: "게이지 끄고 인식만 쓰기" }).click();
    await expect(page.locator("#mcSheet")).toBeHidden();
    expect(await ev(page, "localStorage.getItem('ms.vadOff')")).toBe("1");
    await expect.poll(() => ev(page, "!!window.__sr.live")).toBe(true);
    await expect(page.locator("#micState")).toHaveText("막대 꺼짐");
  });
  test("마이크 문제(소리 거의 없음)", async ({ open, page }) => {
    await open({});
    expect(await runCheck(page, 0, null)).toBe("mic");
  });
  test("거리 문제(작음)", async ({ open, page }) => {
    await open({});
    expect(await runCheck(page, 0.02, null)).toBe("distance");
  });
  test("인식 문제(소리는 충분, 글자 없음)", async ({ open, page }) => {
    await open({});
    expect(await runCheck(page, 1, null)).toBe("recogniser");
    await expect(page.locator("#mcResult")).toContainText("받아쓰기 활성화");
  });
});

test.describe("하루 종일 켜두기", () => {
  test("조용하면 대기(인식 끔·검은 화면·SLEEP), 목소리에 깨어남", async ({ open, page }) => {
    await open({ storage: { "ms.allDay": "1", "ms.sleepAfterMs": "1200" } });
    await startListening(page);
    await expect(page.locator("#sleepVeil")).toBeVisible({ timeout: 4000 });
    await expect(page.locator("#status")).toHaveText("SLEEP");
    await expect(page.locator("#sleepClock")).not.toBeEmpty();
    await expect.poll(() => ev(page, "!!window.__sr.live")).toBe(false);
    await ev(page, "window.__mic.set({ voice: 1 })");
    await expect(page.locator("#sleepVeil")).toBeHidden({ timeout: 3000 });
    await expect(page.locator("#status")).toHaveText("LISTENING");
    await expect.poll(() => ev(page, "!!window.__sr.live")).toBe(true);
  });
  test("대기 중 탭하면 깨어남, 대기 중엔 AI 분석 없음", async ({ open, page }) => {
    let calls = 0;
    await page.route("https://api.anthropic.com/**", (r) => { calls++; return r.abort(); });
    await open({ key: true, storage: { "ms.allDay": "1", "ms.sleepAfterMs": "1200" } });
    await startListening(page);
    await expect(page.locator("#sleepVeil")).toBeVisible({ timeout: 4000 });
    const before = calls;
    await page.click("#analyzeBtn", { force: true }).catch(() => {});
    await page.waitForTimeout(300); expect(calls).toBe(before);
    await page.click("#sleepVeil");
    await expect(page.locator("#sleepVeil")).toBeHidden();
    await expect.poll(() => ev(page, "!!window.__sr.live")).toBe(true);
  });
  test("게이지가 없으면 인식이 귀 역할 — 대기 중에도 인식은 켜져 있고 말을 알아들으면 깨어남", async ({ open, page }) => {
    await open({ storage: { "ms.allDay": "1", "ms.sleepAfterMs": "1200", "ms.vadOff": "1" } });
    await startListening(page);
    await expect(page.locator("#sleepVeil")).toBeVisible({ timeout: 4000 });
    expect(await ev(page, "!!window.__sr.live")).toBe(true);
    await ev(page, "window.__say('다시 시작합시다')");
    await expect(page.locator("#sleepVeil")).toBeHidden();
  });
});
