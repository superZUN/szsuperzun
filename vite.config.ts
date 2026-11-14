import { defineConfig, type PluginOption } from "vite";
import { pathToFileURL } from "node:url";
import path from "node:path";

export default defineConfig(async () => {
  const plugins: PluginOption[] = [];
  // tests only: serve the Netlify Functions locally with an in-memory Blobs store
  if (process.env.SIDEKICK_TEST_API === "1") {
    const href = pathToFileURL(path.resolve("tests/harness/api-plugin.mjs")).href;
    const { localApi } = await import(/* @vite-ignore */ href);
    plugins.push(localApi());
  }
  return {
    plugins,
    build: { outDir: "dist", target: "es2022", sourcemap: true },
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
  };
});
