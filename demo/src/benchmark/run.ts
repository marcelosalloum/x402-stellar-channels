import { writeFileSync } from 'fs';
import { runVanillaBenchmark } from './vanilla.js';
import { runChannelBenchmark } from './channel.js';
import type { BenchmarkResult } from './timer.js';

const N = parseInt(process.env.BENCHMARK_CALLS ?? '20', 10);

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

function fmt(ms: number): string {
  return ms.toLocaleString('en-US') + ' ms';
}

// ── Table ─────────────────────────────────────────────────────────────────────
const W0 = 20,
  W1 = 15,
  W2 = 15;
// Full row width: │ sp W0 sp │ sp W1 sp │ sp W2 sp │  = W0+W1+W2+10 = 60

function hline(l: string, m: string, r: string): string {
  return `${l}${'─'.repeat(W0 + 2)}${m}${'─'.repeat(W1 + 2)}${m}${'─'.repeat(W2 + 2)}${r}`;
}

function trow(
  c0: string,
  c1: string,
  c2: string,
  c1color?: (s: string) => string,
  c2color?: (s: string) => string,
): void {
  const p0 = c0.padEnd(W0);
  const p1 = c1.padStart(W1);
  const p2 = c2.padStart(W2);
  console.log(`│ ${p0} │ ${c1color ? c1color(p1) : p1} │ ${c2color ? c2color(p2) : p2} │`);
}

function printTable(
  vanilla: BenchmarkResult,
  channel: BenchmarkResult,
  be: number,
  speedupTotal: number,
  speedupPerCall: number,
): void {
  const title = `Results · ${N} calls on Stellar testnet`;
  const innerW = W0 + W1 + W2 + 8; // = 58, between the outer │ characters
  const titlePad = Math.floor((innerW - title.length) / 2);
  const titleRight = innerW - title.length - titlePad;

  const amortizedMs = Math.round(channel.totalMs / N);
  const amortizedSpeedup = vanilla.perCallAvgMs / (amortizedMs || 1);
  const beStr = isFinite(be) ? `${be} calls` : 'N/A';
  const netSpeedupStr = isFinite(speedupPerCall) ? `${Math.round(speedupPerCall)}×` : 'N/A';

  console.log('');
  console.log(`┌${'─'.repeat(innerW + 2)}┐`);
  console.log(`│ ${' '.repeat(titlePad)}${bold(title)}${' '.repeat(titleRight)} │`);
  console.log(hline('├', '┬', '┤'));
  trow('', 'Vanilla x402', 'Channel x402');
  console.log(hline('├', '┼', '┤'));
  trow('Per-call avg (net)', fmt(vanilla.perCallAvgMs), fmt(channel.perCallAvgMs), dim, cyan);
  trow('Amortized per call', fmt(vanilla.perCallAvgMs), fmt(amortizedMs), dim, cyan);
  trow(`Total (${N} calls)`, fmt(vanilla.totalMs), fmt(channel.totalMs), dim, cyan);
  trow('On-chain txs', String(N), '2', dim, cyan);
  console.log(hline('├', '┼', '┤'));
  trow('Net per-call speedup', '', netSpeedupStr, undefined, yellow);
  trow('Amortized speedup', '', `${amortizedSpeedup.toFixed(1)}×`, undefined, yellow);
  trow('Break-even', '', beStr, undefined, yellow);
  console.log(`└${'─'.repeat(W0 + 2)}┴${'─'.repeat(W1 + 2)}┴${'─'.repeat(W2 + 2)}┘`);
}

// ── Break-even ────────────────────────────────────────────────────────────────
function breakEven(vanilla: BenchmarkResult, channel: BenchmarkResult): number {
  const overhead = channel.overheadMs ?? 0;
  const diff = vanilla.perCallAvgMs - channel.perCallAvgMs;
  if (diff <= 0) return Infinity;
  return Math.ceil(overhead / diff);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(bold('\n=== x402 Channels Benchmark — Stellar Testnet ==='));

  // Vanilla ──
  console.log(`\n  ${bold('Vanilla x402')}  ${dim(`· on-chain per call · ${N} calls`)}`);
  process.stdout.write('  ');
  const vanilla = await runVanillaBenchmark(N, (r) => {
    process.stdout.write(r.success ? green('✓ ') : red('✗ '));
  });
  process.stdout.write('\n');
  console.log(
    `  ${dim('avg')} ${yellow(fmt(vanilla.perCallAvgMs))}  ${dim('·')}  ${dim('total')} ${yellow(fmt(vanilla.totalMs))}`,
  );

  // Channel ──
  console.log(`\n  ${bold('Channel x402')}  ${dim(`· ${N} calls`)}`);
  process.stdout.write(`  ${dim('Opening channel...')}`);

  const channel = await runChannelBenchmark(N, {
    onOpen(r) {
      const tick = r.success ? green('✓') : red('✗');
      process.stdout.write(`\r  ${dim('⬡')} Open    ${tick}  ${dim(fmt(r.durationMs))}\n`);
      process.stdout.write('  ');
    },
    onCall(r) {
      process.stdout.write(r.success ? green('✓ ') : red('✗ '));
    },
    onBeforeClose() {
      process.stdout.write(`\n  ${dim('Closing channel...')}`);
    },
    onClose(r) {
      const tick = r.success ? green('✓') : red('✗');
      process.stdout.write(`\r  ${dim('⬡')} Close   ${tick}  ${dim(fmt(r.durationMs))}\n`);
    },
  });

  const callsMs = channel.totalMs - (channel.overheadMs ?? 0);
  console.log(
    `  ${dim('avg')} ${cyan(fmt(channel.perCallAvgMs))}  ${dim('·')}  ${dim('calls total')} ${cyan(fmt(callsMs))}`,
  );

  const be = breakEven(vanilla, channel);
  const speedupTotal = vanilla.totalMs / channel.totalMs;
  const speedupPerCall = vanilla.perCallAvgMs / (channel.perCallAvgMs || 1);

  printTable(vanilla, channel, be, speedupTotal, speedupPerCall);

  const output = { vanilla, channel, breakEven: be, speedupTotal, speedupPerCall };
  writeFileSync(
    'benchmark-results.json',
    JSON.stringify(output, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );
  console.log(dim('\n  Results saved to benchmark-results.json'));
}

main().catch(console.error);
