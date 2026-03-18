import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { ChannelClient } from '../src/client/channel-client.js';

const SKIP = !process.env.AGENT_SECRET;

describe.skipIf(SKIP)('Channel x402 E2E (testnet)', () => {
  let client: ChannelClient;

  beforeAll(async () => {
    client = new ChannelClient({
      agentKeypair: Keypair.fromSecret(process.env.AGENT_SECRET!),
      serverPublic: process.env.SERVER_PUBLIC!,
      assetContractId: process.env.TOKEN_CONTRACT_ID!,
      channelContractId: process.env.CHANNEL_CONTRACT_ID!,
      facilitatorUrl: `http://localhost:${process.env.FACILITATOR_PORT ?? 3002}`,
      serverUrl: `http://localhost:${process.env.SERVER_PORT ?? 3001}`,
      pricePerCall: 1000n,
      deposit: 1_000_0000n,
    });
    await client.open();
  }, 60_000);

  afterAll(async () => {
    await client.close();
  }, 60_000);

  it('makes 5 successful paid requests', async () => {
    for (let i = 0; i < 5; i++) {
      const result = (await client.get('/data')) as { result: string };
      expect(result).toHaveProperty('result');
    }
  }, 30_000);

  it('each call completes in under 500ms', async () => {
    const start = performance.now();
    await client.get('/data');
    expect(performance.now() - start).toBeLessThan(500);
  }, 5_000);
});
