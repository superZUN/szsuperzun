// Calls to our own Netlify Functions (/api/glossary, /api/minutes, /api/tasks), all behind the same passcode.
import { ls } from "./ls";

export const server = { passcode: ls.get("ms.passcode") };
export function setPasscode(p: string) { server.passcode = p; ls.set("ms.passcode", p); }

export interface ServerError { code: "no_pass" | "no_server" | "network" | "bad_pass" | "not_configured" | "server_err"; status?: number; path?: string; detail?: string }

export async function serverApi(path: string, method: string, body?: any): Promise<any> {
  if (!server.passcode) throw { code: "no_pass" } as ServerError;
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") throw { code: "no_server" } as ServerError;
  let r: Response;
  try { r = await fetch(path, { method, headers: { "content-type": "application/json", "x-passcode": server.passcode }, body: body ? JSON.stringify(body) : undefined, cache: "no-store" }); }
  catch { throw { code: "network" } as ServerError; }
  const isJson = (r.headers.get("content-type") || "").includes("json");
  let j: any = null; if (isJson) { try { j = await r.clone().json(); } catch { /* not json */ } }
  if (r.status === 401) throw { code: "bad_pass" } as ServerError;
  if (j && j.error === "not_configured") throw { code: "not_configured" } as ServerError;
  if (r.status === 404 && !(j && j.error)) throw { code: "no_server", status: 404, path } as ServerError;
  if (!r.ok || !isJson) throw { code: "server_err", status: r.status, path, detail: j && j.error } as ServerError;
  return j ?? r.json();
}

export function serverErrText(e: any): string {
  const c = e && e.code;
  if (c === "bad_pass") return "서버 비밀번호가 맞지 않습니다.";
  if (c === "not_configured") return "Netlify에 SIDEKICK_PASSCODE가 설정되지 않았습니다.";
  if (c === "no_server") return location.protocol !== "https:" ? "https 주소(Netlify)로 열어야 서버 저장을 쓸 수 있습니다." : `이 주소에서 서버 기능(${e.path || "/api"})을 찾지 못했습니다(HTTP 404). 최근 배포에 netlify/functions 폴더가 빠졌는지 확인해 주세요.`;
  if (c === "server_err") return `서버 기능(${e.path || "/api"})에서 오류가 났습니다(HTTP ${e.status}${e.detail ? ", " + e.detail : ""}). Netlify의 Functions 로그를 확인해 주세요.`;
  if (c === "network") return "서버에 연결하지 못했습니다.";
  return "서버 처리 중 문제가 생겼습니다.";
}
