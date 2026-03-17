/**
 * VanillaClient — standard x402 exact scheme.
 * Each request waits for on-chain facilitator verification before returning.
 * Used only in the benchmark to measure baseline latency.
 */
export class VanillaClient {
  constructor(
    private serverUrl: string,
    private agentSecret: string,
    private facilitatorUrl: string,
    private assetContractId: string,
  ) {}

  async get(path: string): Promise<unknown> {
    // Step 1: probe for 402
    const probe = await fetch(`${this.serverUrl}${path}`);
    if (probe.status !== 402) return probe.json();

    const paymentRequired = (await probe.json()) as {
      schemes: Array<{ scheme: string; price: string }>;
    };
    const exactScheme = paymentRequired.schemes.find((s) => s.scheme === 'exact');
    if (!exactScheme) throw new Error('server does not support exact scheme');

    // Step 2: submit to facilitator — pays and waits for on-chain confirmation
    const payRes = await fetch(`${this.facilitatorUrl}/pay/exact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentSecret: this.agentSecret,
        price: exactScheme.price,
        assetContractId: this.assetContractId,
      }),
    });
    if (!payRes.ok) throw new Error(`pay failed: ${await payRes.text()}`);
    const { authEntry } = (await payRes.json()) as { authEntry: string };

    // Step 3: final request with settled payment proof
    const finalRes = await fetch(`${this.serverUrl}${path}`, {
      headers: { 'X-Payment': JSON.stringify({ scheme: 'exact', authEntry }) },
    });
    if (!finalRes.ok) throw new Error(`final failed: ${finalRes.status}`);
    return finalRes.json();
  }
}
