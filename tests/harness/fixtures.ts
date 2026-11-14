// Playwright fixtures shared by every test:
//  - fakes.js is injected before the app runs (speech, mic, wake lock)
//  - all outside traffic is blocked unless a test mocks it (no real AI / Wikipedia / fonts calls)
//  - /api/* requests carry this test's own data namespace, so tests never share server data
//  - console errors and page errors fail the test unless allowed
import { test as base, expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKES = path.join(here, "fakes.js");

export interface Opts {
  /** localStorage entries set before the app loads */
  storage?: Record<string, string>;
  /** an Anthropic key (true = "sk-test") */
  key?: boolean | string;
  /** documents put into the legacy IndexedDB before the app loads */
  idbDocs?: any[];
  /** false = stay on the tab the app chose (settings when there is no key) */
  tab?: false;
}

type Fixtures = {
  ns: string;
  errors: string[];
  allowErrors: RegExp[];
  open: (opts?: Opts) => Promise<Page>;
};

export const test = base.extend<Fixtures>({
  ns: async ({}, use, info) => {
    await use(`t${info.workerIndex}-${info.testId}-${info.retry}`);
  },
  allowErrors: async ({}, use) => { await use([]); },
  errors: async ({ page, allowErrors }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
    await use(errors);
    const bad = errors.filter((e) => !allowErrors.some((r) => r.test(e)) && !/net::ERR_FAILED|Failed to load resource/.test(e));
    expect(bad, "no page errors").toEqual([]);
  },
  page: async ({ page, ns }, use) => {
    await page.addInitScript({ path: FAKES });
    // block the outside world; tests mock what they need (later routes take priority)
    await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort("failed"));
    await page.route("**/api/**", (r) => r.continue({ headers: { ...r.request().headers(), "x-test-ns": ns } }));
    await use(page);
  },
  open: async ({ page, errors }, use) => {
    await use(async (opts = {}) => {
      const storage = { ...(opts.key ? { "ms.key.anthropic": opts.key === true ? "sk-test" : opts.key } : {}), ...(opts.storage || {}) };
      if (Object.keys(storage).length) {
        await page.addInitScript((s) => { if (!sessionStorage.getItem("__seeded")) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v as string); sessionStorage.setItem("__seeded", "1"); } }, storage);
      }
      await page.goto("/");
      await expect(page.locator("html[data-ready='1']")).toHaveCount(1);
      await expect(page.locator("html[data-docs='1']")).toHaveCount(1);
      if (opts.idbDocs) { // written the way the legacy app stored them, then the app is reloaded
        await page.evaluate((docs) => new Promise<void>((res) => {
          const r = indexedDB.open("meeting-copilot", 1);
          r.onsuccess = () => { const tx = r.result.transaction("docs", "readwrite"); docs.forEach((d: any) => tx.objectStore("docs").put(d)); tx.oncomplete = () => { r.result.close(); res(); }; };
        }), opts.idbDocs);
        await page.reload();
        await expect(page.locator("html[data-docs='1']")).toHaveCount(1);
      }
      if (opts.tab !== false) await page.click("#tabLive");
      void errors;
      return page;
    });
  },
});
export { expect };

/** press 시작 and wait until the (fake) recogniser is listening */
export async function startListening(page: Page) {
  await page.click("#startBtn");
  await expect.poll(() => page.evaluate(() => !!(window as any).__sr.live)).toBe(true);
}
export const app = (page: Page, expr: string) => page.evaluate(`(() => { const A = window.__app; return ${expr}; })()`);
/** a JSON-array analysis answer */
export const cardsJSON = (items: any[]) => JSON.stringify(items);
