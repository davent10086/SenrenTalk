import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: [
      "tests/**/*.test.ts",
      "tests/renderer/**/*.test.tsx",
    ],
    exclude: ["tests/helpers/**", "node_modules/**"],
    globals: true,
    coverage: {
      reporter: ["text", "html"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.d.ts", "src/renderer/main.tsx", "src/server/index.ts"],
    },
  },
});
