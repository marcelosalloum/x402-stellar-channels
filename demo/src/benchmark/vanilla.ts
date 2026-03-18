import { Keypair } from '@stellar/stellar-sdk';
import { vanillaPayment } from '../facilitator/stellar.js';
import { measure, type BenchmarkResult, type TimedResult } from './timer.js';

export async function runVanillaBenchmark(
  calls: number,
  onProgress?: (r: TimedResult, index: number) => void,
): Promise<BenchmarkResult> {
  const agentKeypair = Keypair.fromSecret(process.env.AGENT_SECRET!);
  const serverPublic = process.env.SERVER_PUBLIC!;
  const assetContractId = process.env.TOKEN_CONTRACT_ID!;

  const results: TimedResult[] = [];
  for (let i = 1; i <= calls; i++) {
    const r = await measure(`Call ${String(i).padStart(2, ' ')}`, () =>
      vanillaPayment(agentKeypair, serverPublic, assetContractId).then(() => {}),
    );
    results.push(r);
    onProgress?.(r, i);
  }

  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);
  return {
    mode: 'vanilla',
    calls,
    results,
    totalMs,
    perCallAvgMs: Math.round(totalMs / calls),
  };
}
