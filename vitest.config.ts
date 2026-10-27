import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["test/**/*.test.ts", "free/test/**/*.test.ts"] } });
