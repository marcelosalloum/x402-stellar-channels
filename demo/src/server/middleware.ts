import type { Request, Response, NextFunction } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { signState, verifyState } from '../crypto.js';
import type { ChannelInfo, ChannelPaymentHeader, ChannelPaymentResponse } from '../types.js';

interface MiddlewareOptions {
  serverKeypair: Keypair;
  price: bigint;
  assetContractId: string;
  channelContractId: string;
  facilitatorUrl: string;
}

// In-memory open channels: channelId → ChannelInfo
const openChannels = new Map<string, ChannelInfo>();

export function registerChannel(info: ChannelInfo): void {
  openChannels.set(info.channelId, info);
}

export function channelPaymentMiddleware(opts: MiddlewareOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rawHeader = req.headers['x-payment'];
    if (!rawHeader) {
      sendPaymentRequired(res, opts);
      return;
    }

    let payment: ChannelPaymentHeader;
    try {
      payment = JSON.parse(rawHeader as string) as ChannelPaymentHeader;
    } catch {
      res.status(402).json({ error: 'invalid X-Payment header' });
      return;
    }

    if (payment.scheme !== 'channel') {
      res.status(402).json({ error: 'only channel scheme supported in this demo' });
      return;
    }

    const channel = openChannels.get(payment.channelId);
    if (!channel) {
      sendPaymentRequired(res, opts);
      return;
    }

    const iteration = BigInt(payment.iteration);
    const agentBalance = BigInt(payment.agentBalance);
    const serverBalance = BigInt(payment.serverBalance);

    if (iteration <= channel.currentState.iteration) {
      res.status(402).json({ error: 'stale iteration' });
      return;
    }
    if (agentBalance + serverBalance !== channel.deposit) {
      res.status(402).json({ error: 'balances do not sum to deposit' });
      return;
    }
    if (serverBalance - channel.currentState.serverBalance !== opts.price) {
      res.status(402).json({ error: 'wrong payment amount' });
      return;
    }
    if (agentBalance < 0n || serverBalance < 0n) {
      res.status(402).json({ error: 'negative balance' });
      return;
    }

    const channelIdBuf = Buffer.from(payment.channelId, 'hex');
    const agentSig = Buffer.from(payment.agentSig, 'hex');

    try {
      verifyState(
        channel.agentPublic,
        agentSig,
        channelIdBuf,
        iteration,
        agentBalance,
        serverBalance,
      );
    } catch {
      res.status(402).json({ error: 'invalid agent signature' });
      return;
    }

    // Update stored state
    channel.currentState = { channelId: payment.channelId, iteration, agentBalance, serverBalance };
    channel.agentLastSig = agentSig;

    // Counter-sign
    const serverSig = signState(
      opts.serverKeypair,
      channelIdBuf,
      iteration,
      agentBalance,
      serverBalance,
    );
    channel.serverLastSig = serverSig;

    // Fire-and-forget keep_alive (no-op for demo; TTL set to 1yr at open)
    void keepAliveAsync(payment.channelId, opts.facilitatorUrl);

    const responseHeader: ChannelPaymentResponse = {
      scheme: 'channel',
      channelId: payment.channelId,
      iteration: String(iteration),
      serverSig: serverSig.toString('hex'),
    };
    res.setHeader('X-Payment-Response', JSON.stringify(responseHeader));
    next();
  };
}

function sendPaymentRequired(res: Response, opts: MiddlewareOptions): void {
  res.status(402).json({
    schemes: [
      {
        scheme: 'channel',
        price: String(opts.price),
        assetContractId: opts.assetContractId,
        channelParams: {
          contractId: opts.channelContractId,
          facilitatorUrl: opts.facilitatorUrl,
          minDeposit: String(opts.price * 100n),
          observationWindow: 500,
        },
      },
    ],
  });
}

let consecutiveKeepAliveFailures = 0;

async function keepAliveAsync(channelId: string, _facilitatorUrl: string): Promise<void> {
  try {
    // In a full implementation, POST to facilitator to extend on-chain TTL
    // For demo: no-op — TTL set to 1 year at channel open
    consecutiveKeepAliveFailures = 0;
  } catch {
    consecutiveKeepAliveFailures++;
    if (consecutiveKeepAliveFailures >= 3) {
      console.warn(
        `[x402] keep_alive failed ${consecutiveKeepAliveFailures} times for channel ${channelId}. Channel TTL may expire.`,
      );
    }
  }
}
