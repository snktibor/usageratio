import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Three test projects share this config:
 *
 *   unit         tests/*.test.ts             pure logic, plus the in-memory Redis (lib/redis-memory.ts)
 *   integration  tests/integration/*.test.ts route handlers and server actions on the in-memory Redis,
 *                                            or on the Docker one when TEST_REDIS=real (tests/helpers/redis-fixture.ts)
 *   component    tests/components/*.test.tsx React components in jsdom, with the English messages
 *
 * `npm test` runs all three; `npx vitest run --project unit` runs one.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // The `@/` alias from tsconfig.json.
    tsconfigPaths: true,
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          // Handlers share one store per file; files run one after another so they never see each other's keys.
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: "component",
          environment: "jsdom",
          include: ["tests/components/**/*.test.tsx"],
          setupFiles: ["tests/setup/dom.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["lib/**", "app/api/**", "app/actions.ts", "proxy.ts", "components/**"],
      exclude: ["i18n/locales.generated.ts", "**/*.d.ts", "lib/demo/**"],
      reporter: ["text-summary", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
