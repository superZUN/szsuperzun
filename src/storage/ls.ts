// localStorage, always guarded (private mode / full storage must never break the app).
// Key names are the legacy app's (ms.*) so existing users keep their settings.
export const ls = {
  get(k: string): string { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set(k: string, v: string | number | null | undefined) { try { v ? localStorage.setItem(k, String(v)) : localStorage.removeItem(k); } catch { /* full or blocked */ } },
  json<T>(k: string, fallback: T): T { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v ?? fallback; } catch { return fallback; } },
};

/** one-time upgrades of settings written by older versions */
export function migrateSettings() {
  // Claude-only version -> per-provider keys
  if (ls.get("ms.apiKey") && !ls.get("ms.key.anthropic")) {
    ls.set("ms.key.anthropic", ls.get("ms.apiKey"));
    if (ls.get("ms.model")) ls.set("ms.fast.anthropic", ls.get("ms.model"));
    ls.set("ms.apiKey", ""); ls.set("ms.model", "");
  }
  // leftovers of the periodic Safari restart and the old meter auto-off, no longer used
  ["ms.recRefreshMs", "ms.forceRefresh", "ms.vadAutoOff"].forEach((k) => ls.set(k, ""));
}
// runs as soon as storage is first imported — before any module reads its settings
migrateSettings();
