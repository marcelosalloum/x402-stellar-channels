import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer } from 'http';
import { Keypair } from '@stellar/stellar-sdk';
import { channelPaymentMiddleware, registerChannel } from '../src/server/middleware.js';
import { signState, deriveChannelId, pubkeyBytes } from '../src/crypto.js';
import type { ChannelInfo } from '../src/types.js';
import { randomBytes } from 'node:crypto';

describe('x402 middleware', () => {
  let httpServer: ReturnType<typeof createServer>;
  const serverKeypair = Keypair.random();
  const agentKeypair = Keypair.random();
  const PRICE = 1000n;
  const DEPOSIT = 1_000_0000n;
  let channelId: string;
  let port: number;

  beforeAll(() => {
    const app = express();
    app.use(
      channelPaymentMiddleware({
        serverKeypair,
        price: PRICE,
        assetContractId: 'CTEST',
        channelContractId: 'CTEST2',
        facilitatorUrl: 'http://localhost:3002',
      }),
    );
    app.get('/data', (_req, res) => res.json({ result: 'secret' }));
    httpServer = createServer(app);
    httpServer.listen(0);
    port = (httpServer.address() as { port: number }).port;

    // Pre-register a channel
    const nonce = randomBytes(32);
    const agentPkBytes = pubkeyBytes(agentKeypair.publicKey());
    channelId = deriveChannelId(agentPkBytes, nonce).toString('hex');
    const info: ChannelInfo = {
      channelId,
      agentPublic: agentKeypair.publicKey(),
      agentPubkeyHex: agentPkBytes.toString('hex'),
      serverPublic: serverKeypair.publicKey(),
      serverPubkeyHex: pubkeyBytes(serverKeypair.publicKey()).toString('hex'),
      assetContractId: 'CTEST',
      deposit: DEPOSIT,
      currentState: { channelId, iteration: 0n, agentBalance: DEPOSIT, serverBalance: 0n },
    };
    registerChannel(info);
  });

  afterAll(() => { httpServer.close(); });

  it('returns 402 with channel scheme when no X-Payment header', async () => {
    const res = await fetch(`http://localhost:${port}/data`);
    expect(res.status).toBe(402);
    const body = await res.json() as { schemes: Array<{ scheme: string }> };
    expect(body.schemes.some((s) => s.scheme === 'channel')).toBe(true);
  });

  it('returns 402 for unknown channelId', async () => {
    const header = JSON.stringify({
      scheme: 'channel', channelId: 'aa'.repeat(32),
      iteration: '1', agentBalance: '9990000', serverBalance: '1000',
      agentSig: '00'.repeat(64),
    });
    const res = await fetch(`http://localhost:${port}/data`, {
      headers: { 'X-Payment': header },
    });
    expect(res.status).toBe(402);
  });

  it('returns 200 with valid payment header', async () => {
    const channelIdBuf = Buffer.from(channelId, 'hex');
    const sig = signState(agentKeypair, channelIdBuf, 1n, DEPOSIT - PRICE, PRICE);
    const header = JSON.stringify({
      scheme: 'channel', channelId,
      iteration: '1',
      agentBalance: String(DEPOSIT - PRICE),
      serverBalance: String(PRICE),
      agentSig: sig.toString('hex'),
    });
    const res = await fetch(`http://localhost:${port}/data`, {
      headers: { 'X-Payment': header },
    });
    expect(res.status).toBe(200);
    const respHeader = res.headers.get('X-Payment-Response');
    expect(respHeader).toBeTruthy();
  });
});
