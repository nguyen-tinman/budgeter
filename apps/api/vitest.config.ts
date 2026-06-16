import { defineConfig } from "vitest/config";

// `node:sqlite` is a Node 23+ builtin. Vitest 2.x runs through Vite's
// transform pipeline, which doesn't know about Node builtins by default and
// tries to resolve them on disk. Excluding from optimizeDeps + marking as
// external for both server and ssr leaves it for Node's native resolver.
export default defineConfig({
  optimizeDeps: {
    exclude: ["node:sqlite"],
  },
  ssr: {
    external: ["node:sqlite"],
  },
  test: {
    pool: "forks",
    server: {
      deps: {
        external: ["node:sqlite", /^node:/],
      },
    },
  },
});
