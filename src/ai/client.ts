// One streaming call for every provider: Anthropic (Claude), OpenAI, Gemini, OpenAI-compatible.
//   ai(prompt, {system, maxTokens, onText, tier, effort, think, kind}) -> full text
// `system` is the part of the prompt that stays the same call after call; Claude caches it (cache_control),
// OpenAI caches long identical prefixes on its own, Gemini gets it as systemInstruction.
import { $, safeUrl, hostOf } from "../util";
import { ls } from "../storage/ls";
import { recordCall, type CallUsage } from "./usage";

export type ProviderId = "anthropic" | "openai" | "gemini" | "compat";
export const PROVIDERS: Record<ProviderId, { label: string; fast: string; deep: string; key: string; hint: string }> = {
  anthropic: { label: "Claude", fast: "claude-haiku-5-5", deep: "claude-sonnet-5-5", key: "sk-ant-...", hint: "키는 platform.claude.com → API Keys에서 만듭니다. 요청은 api.anthropic.com으로만 갑니다." },
  openai: { label: "OpenAI", fast: "gpt-5.4-mini", deep: "gpt-6-astra", key: "sk-...", hint: "키는 platform.openai.com → API keys에서 만듭니다. 요청은 api.openai.com으로만 갑니다. 모델이 바뀌었으면 '모델 목록'으로 확인하세요." },
  gemini: { label: "Gemini", fast: "gemini-3.8-flash", deep: "gemini-4-argon", key: "AIza...", hint: "키는 aistudio.google.com → Get API key에서 만듭니다. 요청은 generativelanguage.googleapis.com으로만 갑니다." },
  compat: { label: "호환 API", fast: "", deep: "", key: "API 키", hint: "OpenAI Chat Completions 형식을 지원하는 서비스(Groq, OpenRouter, 사내 게이트웨이 등)의 주소와 모델 이름을 넣으세요. 그 서비스가 브라우저 접속(CORS)을 허용해야 합니다." },
};
export const ai = {
  provider: (PROVIDERS[ls.get("ms.prov") as ProviderId] ? ls.get("ms.prov") : "anthropic") as ProviderId,
  apiKey: "", model: "", deepModel: "", baseUrl: "",
};
export function loadProvider(p: ProviderId) {
  const P = PROVIDERS[p]; ai.provider = p;
  ai.apiKey = ls.get("ms.key." + p); ai.model = ls.get("ms.fast." + p) || P.fast;
  ai.deepModel = ls.get("ms.deep." + p) || P.deep || ai.model; ai.baseUrl = ls.get("ms.base." + p);
}
/** save the form values (default model names are stored as "" so a later default change applies) */
export function saveProvider(p: ProviderId, f: { apiKey: string; model: string; deepModel: string; baseUrl: string }) {
  const P = PROVIDERS[p]; ai.provider = p; ai.apiKey = f.apiKey; ai.model = f.model || P.fast; ai.deepModel = f.deepModel || P.deep || ai.model; ai.baseUrl = f.baseUrl.replace(/\/+$/, "");
  ls.set("ms.prov", p); ls.set("ms.key." + p, ai.apiKey); ls.set("ms.fast." + p, ai.model === P.fast ? "" : ai.model);
  ls.set("ms.deep." + p, ai.deepModel === P.deep ? "" : ai.deepModel); ls.set("ms.base." + p, ai.baseUrl);
}
loadProvider(ai.provider);

export const ANT = "https://api.anthropic.com/v1", OAI = "https://api.openai.com/v1", GEM = "https://generativelanguage.googleapis.com/v1beta";
const oaiBase = () => (ai.provider === "compat" ? ai.baseUrl : OAI);
const antHeaders = () => ({ "content-type": "application/json", "x-api-key": ai.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" });

export interface AIError { code: "no_key" | "no_base" | "bad_key" | "bad_model" | "rate_limited" | "network" | "http"; message?: string; text?: string }

/** send; if the service rejects an optional tuning field (400), retry with the next, plainer variant */
interface Variant { extra: any; retryIf?: RegExp }
async function sendWithFallback(build: (v: Variant) => [string, RequestInit], variants: Variant[]) {
  let r!: Response;
  for (let i = 0; i < variants.length; i++) {
    try { r = await fetch(...build(variants[i])); } catch { throw { code: "network" } as AIError; }
    if (r.status !== 400 || i === variants.length - 1) return r;
    const j = await r.clone().json().catch(() => ({}));
    if (!variants[i].retryIf || !variants[i].retryIf!.test(JSON.stringify(j).toLowerCase())) return r;
  }
  return r;
}
async function readSSE(r: Response, pick: (ev: any, text: string) => any, onText?: (t: string) => void) {
  const reader = r.body!.getReader(), dec = new TextDecoder(); let buf = "", text = "";
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim(); if (data === "[DONE]") continue;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      const piece = pick(ev, text);
      if (piece && piece.error) throw { ...piece.error, text };
      if (piece) { text += piece; onText && onText(text); }
    }
  }
  return text;
}
export async function httpError(r: Response): Promise<AIError> {
  let msg = ""; try { const j = await r.json(); msg = (j.error && (j.error.message || j.error.status)) || ""; } catch { /* not json */ }
  const s = r.status, low = msg.toLowerCase();
  return { code: s === 401 || s === 403 || /api[_ ]?key/.test(low) ? "bad_key" : s === 429 || s === 529 || s === 503 ? "rate_limited" : s === 404 || (s === 400 && /model/.test(low)) ? "bad_model" : "http", message: msg };
}

/**
 * Claude thinking/effort settings per model generation:
 *  - Haiku 5.x: thinking can be switched off (at effort ≤ high)
 *  - Sonnet 5.5: "disabled" is rejected; "between_tools" is its thinking-off mode
 *  - Opus 5.5 / Fable: thinking cannot be switched off; low effort keeps it short
 *  - other 5-generation models: disabled + low effort
 */
export function claudeTune(m: string, think: boolean, effort: string): any {
  const gen5 = /(haiku|sonnet|opus)-5|fable|mythos/i.test(m);
  if (!gen5) return null;
  if (think) return { thinking: { type: "adaptive" }, output_config: { effort } };
  if (/sonnet-5-5/i.test(m)) return { thinking: { type: "between_tools" }, output_config: { effort: "low" } };
  if (/opus-5-5|fable|mythos/i.test(m)) return { output_config: { effort: "low" } };
  return { thinking: { type: "disabled" }, output_config: { effort: "low" } };
}
/** the newer web-search tool (dynamic filtering) where the model has it; Haiku keeps the basic one */
export const webSearchType = (m: string) => (/haiku/i.test(m) || !/(sonnet|opus)-(5|4-[6-9])|fable|mythos/i.test(m) ? "web_search_20250305" : "web_search_20260209");

let tuneOk = true; // the service refused the tuning fields once: stop sending them
export interface AIOpts { system?: string; maxTokens?: number; onText?: (t: string) => void; tier?: "fast" | "deep"; effort?: string; think?: boolean; kind?: string }

export async function aiCall(prompt: string, { system = "", maxTokens = 700, onText, tier = "fast", effort = "low", think = false, kind = "other" }: AIOpts = {}): Promise<string> {
  if (!ai.apiKey) throw { code: "no_key" } as AIError;
  if (ai.provider === "compat" && !ai.baseUrl) throw { code: "no_base" } as AIError;
  const m = tier === "deep" ? ai.deepModel || ai.model : ai.model, P = ai.provider;
  const use: CallUsage = {}; let r: Response, text: string | undefined;
  const done = (t: string) => { if (!use.inTok) { use.inTok = Math.ceil((system.length + prompt.length) / 2); use.outTok = Math.ceil(t.length / 2); use.estimated = true; } recordCall(kind, use); return t; };
  if (P === "anthropic") {
    const tune = tuneOk ? claudeTune(m, think, effort) : null;
    const variants: Variant[] = tune ? [{ extra: tune, retryIf: /thinking|effort|output_config/ }, { extra: {} }] : [{ extra: {} }];
    const sys = system ? { system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] } : {};
    r = await sendWithFallback((v) => [ANT + "/messages", { method: "POST", headers: antHeaders(),
      body: JSON.stringify({ model: m, max_tokens: think ? Math.max(maxTokens, 2000) : maxTokens, stream: true, ...v.extra, ...sys, messages: [{ role: "user", content: prompt }] }) }], variants);
    if (r.ok) text = await readSSE(r, (ev) => {
      if (ev.type === "message_start" && ev.message?.usage) { const us = ev.message.usage; use.inTok = (us.input_tokens || 0) + (us.cache_read_input_tokens || 0) + (us.cache_creation_input_tokens || 0); use.cacheRead = us.cache_read_input_tokens || 0; use.cacheWrite = us.cache_creation_input_tokens || 0; }
      if (ev.type === "message_delta" && ev.usage) use.outTok = ev.usage.output_tokens || 0;
      return ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta" ? ev.delta.text : ev.type === "error" ? { error: { code: ev.error && ev.error.type === "overloaded_error" ? "rate_limited" : "http", message: ev.error && ev.error.message } } : "";
    }, onText);
  } else if (P === "openai" || P === "compat") {
    const tok = think ? Math.max(maxTokens, 3000) : maxTokens;
    const so = P === "openai" ? { stream_options: { include_usage: true } } : {};
    const variants: Variant[] = P === "openai"
      ? [{ extra: { ...so, max_completion_tokens: tok, reasoning_effort: think ? effort : "none" }, retryIf: /reasoning/ }, { extra: { ...so, max_completion_tokens: tok }, retryIf: /max_completion_tokens|stream_options/ }, { extra: { max_tokens: tok } }]
      : [{ extra: { max_tokens: tok }, retryIf: /max_tokens/ }, { extra: { max_completion_tokens: tok } }];
    const msgs = [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }];
    r = await sendWithFallback((v) => [oaiBase() + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + ai.apiKey },
      body: JSON.stringify({ model: m, stream: true, ...v.extra, messages: msgs }) }], variants);
    if (r.ok) text = await readSSE(r, (ev) => {
      if (ev.usage) { use.inTok = ev.usage.prompt_tokens || 0; use.outTok = ev.usage.completion_tokens || 0; use.cacheRead = ev.usage.prompt_tokens_details?.cached_tokens || 0; }
      return ev.error ? { error: { code: "http", message: ev.error.message } } : (ev.choices && ev.choices[0] && ev.choices[0].delta && ev.choices[0].delta.content) || "";
    }, onText);
  } else {
    const gc = { maxOutputTokens: think ? Math.max(maxTokens, 4000) : maxTokens * 3 };
    const variants: Variant[] = [{ extra: { ...gc, thinkingConfig: { thinkingLevel: think ? effort : "low" } }, retryIf: /thinking/ }, { extra: gc }];
    const sys = system ? { systemInstruction: { parts: [{ text: system }] } } : {};
    r = await sendWithFallback((v) => [`${GEM}/models/${encodeURIComponent(m)}:streamGenerateContent?alt=sse`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": ai.apiKey },
      body: JSON.stringify({ ...sys, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: v.extra }) }], variants);
    if (r.ok) text = await readSSE(r, (ev) => {
      if (ev.usageMetadata) { use.inTok = ev.usageMetadata.promptTokenCount || 0; use.outTok = ev.usageMetadata.candidatesTokenCount || 0; use.cacheRead = ev.usageMetadata.cachedContentTokenCount || 0; }
      const parts = (ev.candidates && ev.candidates[0] && ev.candidates[0].content && ev.candidates[0].content.parts) || [];
      return parts.filter((p: any) => !p.thought && p.text).map((p: any) => p.text).join("");
    }, onText);
  }
  if (text !== undefined) return done(text);
  throw await httpError(r);
}

/** one call with the provider's web-search tool; the model searches only if it decides to. `searched` says whether it did. */
export async function searchCall(prompt: string, { system = "", maxTokens = 600, onText, think = false, kind = "web" }: AIOpts = {}): Promise<{ text: string; links: { t: string; u: string }[]; searched: boolean }> {
  if (!ai.apiKey) throw { code: "no_key" } as AIError;
  const links: { t: string; u: string }[] = [], addLink = (t: string, u: string) => { u = safeUrl(u); if (u && !links.some((l) => l.u === u)) links.push({ t: t || hostOf(u), u }); };
  let r: Response, text = "", searched = false; const use: CallUsage = {}; const m = ai.model;
  if (ai.provider === "anthropic") {
    const tune = (tuneOk ? claudeTune(m, think, think ? "medium" : "low") : null) || {};
    const wsType = webSearchType(m);
    const base = (t: string) => ({ model: m, max_tokens: think ? Math.max(maxTokens, 2500) : maxTokens, stream: true, tools: [{ type: t, name: "web_search", max_uses: 1 }],
      ...(system ? { system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] } : {}), messages: [{ role: "user", content: prompt }] });
    const variants: Variant[] = [{ extra: { ...base(wsType), ...tune }, retryIf: /thinking|effort|output_config|web_search|tool/ }];
    if (Object.keys(tune).length) variants.push({ extra: base(wsType), retryIf: /web_search|tool/ });
    if (wsType !== "web_search_20250305") variants.push({ extra: base("web_search_20250305") });
    r = await sendWithFallback((v) => [ANT + "/messages", { method: "POST", headers: antHeaders(), body: JSON.stringify(v.extra) }], variants);
    if (!r.ok) throw await httpError(r);
    text = await readSSE(r, (ev) => {
      if (ev.type === "message_start" && ev.message?.usage) { const us = ev.message.usage; use.inTok = (us.input_tokens || 0) + (us.cache_read_input_tokens || 0) + (us.cache_creation_input_tokens || 0); use.cacheRead = us.cache_read_input_tokens || 0; }
      if (ev.type === "message_delta" && ev.usage) use.outTok = ev.usage.output_tokens || 0;
      if (ev.type === "content_block_start" && ev.content_block && /server_tool_use|web_search_tool_result/.test(ev.content_block.type || "")) searched = true;
      if (ev.type === "content_block_start" && ev.content_block && ev.content_block.type === "web_search_tool_result" && Array.isArray(ev.content_block.content)) ev.content_block.content.forEach((x: any) => addLink(x.title, x.url));
      if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") return ev.delta.text;
      if (ev.type === "error") return { error: { code: "http", message: ev.error && ev.error.message } };
      return "";
    }, onText);
  } else if (ai.provider === "gemini") {
    const variants: Variant[] = [{ extra: { thinkingConfig: { thinkingLevel: think ? "medium" : "low" } }, retryIf: /thinking/ }, { extra: {} }];
    r = await sendWithFallback((v) => [`${GEM}/models/${encodeURIComponent(m)}:streamGenerateContent?alt=sse`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": ai.apiKey },
      body: JSON.stringify({ ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { maxOutputTokens: think ? 4000 : Math.max(1200, maxTokens * 2), ...v.extra } }) }], variants);
    if (!r.ok) throw await httpError(r);
    text = await readSSE(r, (ev) => {
      if (ev.usageMetadata) { use.inTok = ev.usageMetadata.promptTokenCount || 0; use.outTok = ev.usageMetadata.candidatesTokenCount || 0; }
      const cand = ev.candidates && ev.candidates[0]; if (!cand) return ""; const gm = cand.groundingMetadata;
      if (gm && (gm.webSearchQueries || gm.groundingChunks)) searched = true;
      if (gm && gm.groundingChunks) gm.groundingChunks.forEach((g: any) => g.web && addLink(g.web.title, g.web.uri));
      return ((cand.content && cand.content.parts) || []).filter((p: any) => !p.thought && p.text).map((p: any) => p.text).join("");
    }, onText);
  } else throw { code: "http", message: "이 AI 서비스는 웹 검색을 지원하지 않습니다" } as AIError;
  searched = searched || links.length > 0;
  if (!use.inTok) { use.inTok = Math.ceil((system.length + prompt.length) / 2); use.outTok = Math.ceil(text.length / 2); use.estimated = true; }
  recordCall(kind, { ...use, web: searched });
  return { text: (text || "").trim(), links: links.slice(0, 4), searched };
}
export const canWebSearch = () => !!ai.apiKey && (ai.provider === "anthropic" || ai.provider === "gemini");

export async function listModels(): Promise<string[]> {
  if (!ai.apiKey) throw { code: "no_key" } as AIError; let r: Response;
  try {
    if (ai.provider === "anthropic") r = await fetch(ANT + "/models?limit=100", { headers: antHeaders() });
    else if (ai.provider === "gemini") r = await fetch(GEM + "/models?pageSize=200", { headers: { "x-goog-api-key": ai.apiKey } });
    else { if (ai.provider === "compat" && !ai.baseUrl) throw { code: "no_base" }; r = await fetch(oaiBase() + "/models", { headers: { authorization: "Bearer " + ai.apiKey } }); }
  } catch (e: any) { throw e && e.code ? e : { code: "network" }; }
  if (!r.ok) throw await httpError(r); const j = await r.json();
  if (ai.provider === "gemini") return (j.models || []).filter((x: any) => (x.supportedGenerationMethods || []).includes("generateContent")).map((x: any) => x.name.replace(/^models\//, ""));
  return (j.data || []).map((x: any) => x.id).filter(Boolean).sort();
}

export function errText(e: any): string {
  const c = e && e.code, L = PROVIDERS[ai.provider].label;
  if (c === "no_key") return "AI API 키가 없습니다. '설정' 탭에서 넣어 주세요.";
  if (c === "no_base") return "OpenAI 호환 API의 주소(Base URL)를 '설정' 탭에 넣어 주세요.";
  if (c === "bad_key") return `${L} API 키가 맞지 않습니다. '설정' 탭에서 확인해 주세요.` + (e.message ? " (" + e.message + ")" : "");
  if (c === "bad_model") return `모델 이름을 찾을 수 없습니다('${ai.model}'). '설정'의 '모델 목록'으로 확인해 주세요.` + (e.message ? " (" + e.message + ")" : "");
  if (c === "rate_limited") return "요청이 많아 잠시 쉬었다가 다시 분석합니다.";
  if (c === "network") return `${L} API에 연결하지 못했습니다. 인터넷 연결${ai.provider === "compat" ? "과 주소·CORS 허용 여부" : ""}를 확인해 주세요.`;
  return "분석 중 문제가 생겼습니다." + (e && e.message ? " (" + e.message + ")" : "");
}

/** keep the connection warm while in use (free model-list request every 45 s) so the first answer comes faster */
let warmAt = 0;
export function keepWarm(force?: boolean) {
  if (!ai.apiKey || document.visibilityState !== "visible") return;
  if (!force && Date.now() - warmAt < 45000) return; warmAt = Date.now();
  let u: [string, RequestInit] | null = null;
  if (ai.provider === "anthropic") u = [ANT + "/models?limit=1", { headers: antHeaders() }];
  else if (ai.provider === "gemini") u = [GEM + "/models?pageSize=1", { headers: { "x-goog-api-key": ai.apiKey } }];
  else if (ai.provider === "openai") u = [oaiBase() + "/models", { headers: { authorization: "Bearer " + ai.apiKey } }];
  if (u) fetch(...u).catch(() => {});
}

/** the 오늘 날짜 line every prompt carries */
export function todayLine(d = new Date()) {
  return `오늘은 ${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일(${"일월화수목금토"[d.getDay()]})입니다. AI의 학습 시점 이후 바뀐 사실이 많으니, 최신·현재 정보는 기억에 기대지 마세요.`;
}
export function refreshNote() {
  const n = $("aiNote"); if (!n) return;
  n.className = "hint" + (ai.apiKey ? "" : " warn");
  n.textContent = ai.apiKey ? "" : "분석하려면 '설정' 탭에서 AI 서비스와 API 키를 넣어 주세요. 받아쓰기와 회의록 저장은 키 없이도 됩니다.";
}
export function disableTune() { tuneOk = false; }
