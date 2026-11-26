import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    // Tests truncate their database, so they run against support_ai_test, never the development database.
    // Legacy agent/voice suites open anonymous sessions; the sign-in requirement is covered in phase9.integration.spec.ts.
    env: { ALLOW_ANONYMOUS_SESSIONS: 'true', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://support:support@localhost:5433/support_ai_test' },
    globalSetup: ['./test/global-setup.ts'],
    include: ['**/*.spec.ts'],
    // Integration suites share one Postgres and reseed it, so files run one at a time.
    fileParallelism: false,
    // Database-backed tests can exceed the 5 s default when turbo runs build/lint/web tests alongside them.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
