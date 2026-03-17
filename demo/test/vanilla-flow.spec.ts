import { describe, it, expect } from 'vitest';
import { VanillaClient } from '../src/client/vanilla-client.js';

const SKIP = !process.env.AGENT_SECRET;

describe.skipIf(SKIP)('Vanilla x402 E2E (testnet)', () => {
  it('makes 2 paid requests and both succeed', async () => {
    const client = new VanillaClient(
      `http://localhost:${process.env.SERVER_PORT ?? 3001}`,
      process.env.AGENT_SECRET!,
      `http://localhost:${process.env.FACILITATOR_PORT ?? 3002}`,
      process.env.TOKEN_CONTRACT_ID!,
    );
    for (let i = 0; i < 2; i++) {
      const result = await client.get('/data') as { result: string };
      expect(result).toHaveProperty('result');
    }
  }, 120_000);
});
