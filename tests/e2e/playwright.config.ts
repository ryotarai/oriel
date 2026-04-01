import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 120_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:0",
  },
});
