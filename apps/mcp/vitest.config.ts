import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    testTimeout: 15_000, // child-process spawn + first-import warmup needs headroom
  },
});
