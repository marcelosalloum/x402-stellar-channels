import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // E2E tests require live testnet — run separately with pnpm test:e2e
    exclude: ['test/channel-flow.spec.ts', 'test/vanilla-flow.spec.ts', '**/node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/benchmark/**',         // entry-point scripts, not unit-testable
        'src/server/index.ts',      // express wiring
        'src/facilitator/server.ts', // express wiring
        'src/facilitator/stellar.ts', // requires live Stellar network
        'src/client/vanilla-client.ts', // requires live network
      ],
    },
  },
});
