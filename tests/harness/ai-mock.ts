// Mocks for every external service the app talks to: the four AI providers (streaming SSE), Wikipedia and Wikimedia Commons.
// A test passes one handler; it sees which provider was called and the prompt text, and returns what the "AI" should say.
import type { Page, Route } from "@playwright/test";

export type Provider = "anthropic" | "openai" | "gemini" | "compat";
export interface AICall {
  provider: Provider;
  url: string;
  body: any;
  prompt: string; // all user text joined
  system: string; // system text, if any (Anthropic `system`, joined)
  webSearch: boolean; // the request carried a web-search tool
  at: number;
}
export interface AIReply {
  text?: string;
  status?: number; // non-200 => error response
  error?: string; // error message for status replies
  searched?: { title: string; url: string }[]; // pretend a web search ran and found these
  delayMs?: number; // before the first byte
  chunk?: number; // characters per SSE event (default 12)
}
export type AIHandler = (call: AICall) => AIReply | string | Promise<AIReply | string>;

const textOf = (content: any): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c.text || "").join("") : "";

function parseCall(provider: Provider, url: string, body: any): AICall {
  let prompt = "", system = "", webSearch = false;
  if (provider === "anthropic") {
    prompt = (body.messages || []).map((m: any) => textOf(m.content)).join("\n");
    system = textOf(body.system);
    webSearch = (body.tools || []).some((t: any) => /web_search/.test(t.type || ""));
  } else if (provider === "gemini") {
    prompt = (body.contents || []).flatMap((c: any) => (c.parts || []).map((p: any) => p.text || "")).join("\n");
    system = (body.systemInstruction?.parts || []).map((p: any) => p.text || "").join("\n");
    webSearch = (body.tools || []).some((t: any) => t.google_search);
  } else {
    prompt = (body.messages || []).filter((m: any) => m.role !== "system").map((m: any) => textOf(m.content)).join("\n");
    system = (body.messages || []).filter((m: any) => m.role === "system").map((m: any) => textOf(m.content)).join("\n");
  }
  return { provider, url, body, prompt, system, webSearch, at: Date.now() };
}

function pieces(text: string, n: number) {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out;
}
const sse = (events: any[]) => events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");

function sseBody(provider: Provider, r: AIReply): string {
  const parts = pieces(r.text || "", r.chunk || 12);
  if (provider === "anthropic") {
    const ev: any[] = [{ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } }];
    if (r.searched) {
      ev.push({ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", name: "web_search" } });
      ev.push({ type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", content: r.searched.map((s) => ({ type: "web_search_result", title: s.title, url: s.url })) } });
    }
    ev.push({ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } });
    parts.forEach((p) => ev.push({ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: p } }));
    ev.push({ type: "message_delta", usage: { output_tokens: Math.ceil((r.text || "").length / 2) } }, { type: "message_stop" });
    return ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  }
  if (provider === "gemini") {
    const ev: any[] = parts.map((p) => ({ candidates: [{ content: { parts: [{ text: p }] } }] }));
    if (r.searched) ev.push({ candidates: [{ content: { parts: [] }, groundingMetadata: { webSearchQueries: ["q"], groundingChunks: r.searched.map((s) => ({ web: { title: s.title, uri: s.url } })) } }] });
    return sse(ev);
  }
  return sse([...parts.map((p) => ({ choices: [{ delta: { content: p } }] })), "[DONE]"]);
}

export interface AIMock { calls: AICall[]; byProvider(p: Provider): AICall[] }

/** Route all AI provider traffic of `page` to `handler`. Model-list requests always succeed. */
export async function mockAI(page: Page, handler: AIHandler, opts: { compatBase?: string } = {}): Promise<AIMock> {
  const calls: AICall[] = [];
  const serve = (provider: Provider) => async (route: Route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors() });
    if (/\/models(\?|$)/.test(url) && req.method() === "GET") {
      const models = provider === "gemini"
        ? { models: [{ name: "models/gemini-test", supportedGenerationMethods: ["generateContent"] }] }
        : { data: [{ id: provider === "anthropic" ? "claude-haiku-5-5" : "gpt-test" }, { id: "model-b" }] };
      return route.fulfill({ status: 200, headers: { ...cors(), "content-type": "application/json" }, body: JSON.stringify(models) });
    }
    let body: any = {};
    try { body = req.postDataJSON() || {}; } catch { body = {}; }
    const call = parseCall(provider, url, body);
    calls.push(call);
    let r = await handler(call);
    if (typeof r === "string") r = { text: r };
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    if (r.status && r.status !== 200) {
      return route.fulfill({ status: r.status, headers: { ...cors(), "content-type": "application/json" }, body: JSON.stringify({ error: { message: r.error || "error", type: "error" } }) });
    }
    return route.fulfill({ status: 200, headers: { ...cors(), "content-type": "text/event-stream" }, body: sseBody(provider, r) });
  };
  await page.route("https://api.anthropic.com/**", serve("anthropic"));
  await page.route("https://api.openai.com/**", serve("openai"));
  await page.route("https://generativelanguage.googleapis.com/**", serve("gemini"));
  if (opts.compatBase) await page.route(opts.compatBase.replace(/\/+$/, "") + "/**", serve("compat"));
  return { calls, byProvider: (p) => calls.filter((c) => c.provider === p) };
}

function cors() {
  return { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS" };
}

export interface WikiPage { title: string; extract?: string; thumb?: string; original?: string }
/** Wikipedia (ko/en) and Commons. `pages` maps a search word (lower case, substring match) to a page. */
export async function mockWiki(page: Page, data: { ko?: Record<string, WikiPage>; en?: Record<string, WikiPage>; commons?: Record<string, { title: string; url: string }> } = {}) {
  const hits: string[] = [];
  const find = <T>(m: Record<string, T> | undefined, q: string) => {
    if (!m) return null;
    const k = Object.keys(m).find((k) => q.toLowerCase().includes(k.toLowerCase()));
    return k ? m[k] : null;
  };
  await page.route(/https:\/\/(ko|en)\.wikipedia\.org\/w\/api\.php.*/, (route) => {
    const u = new URL(route.request().url());
    const lang = u.hostname.slice(0, 2) as "ko" | "en";
    const q = u.searchParams.get("gsrsearch") || "";
    hits.push(`${lang}:${q}`);
    const p = find(data[lang], q);
    const pages = p ? { "1": { pageid: 1, index: 1, title: p.title, extract: p.extract, thumbnail: p.thumb ? { source: p.thumb } : undefined, original: p.original ? { source: p.original } : undefined } } : undefined;
    return route.fulfill({ status: 200, headers: cors(), contentType: "application/json", body: JSON.stringify(pages ? { query: { pages } } : {}) });
  });
  await page.route(/https:\/\/commons\.wikimedia\.org\/w\/api\.php.*/, (route) => {
    const q = new URL(route.request().url()).searchParams.get("gsrsearch") || "";
    hits.push(`commons:${q}`);
    const p = find(data.commons, q);
    const pages = p ? { "1": { index: 1, title: "File:" + p.title, imageinfo: [{ thumburl: p.url, url: p.url, descriptionurl: "https://commons.wikimedia.org/wiki/File:" + p.title }] } } : undefined;
    return route.fulfill({ status: 200, headers: cors(), contentType: "application/json", body: JSON.stringify(pages ? { query: { pages } } : {}) });
  });
  // pictures referenced by the mocked pages
  await page.route(/https:\/\/upload\.wikimedia\.org\/.*/, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") }));
  return { hits };
}
