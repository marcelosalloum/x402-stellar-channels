# x402 Stellar Channels — Design Spec

**Date:** 2026-03-17
**Status:** Approved
**Context:** [Slack thread](https://stellarfoundation.slack.com/archives/C09R7495RDF/p1773445997072879) | [Ideas repo](https://github.com/stellar-experimental/ideas/tree/main/x402-zero-latency)

---

## Problem

[x402](https://www.x402.org/) requires an on-chain transaction + verification loop for every API call. For AI agents making dozens of calls in a single workflow, this compounds to minutes of cumulative latency — making x402 impractical for iterative, high-frequency agentic use cases.

## Solution

Implement a **unidirectional payment channel** using a Soroban smart contract. The agent deposits USDC once (open), signs off-chain auth entries per request (zero on-chain overhead), and settles once (close). N requests = 2 on-chain transactions total.

The off-chain state uses Stellar's existing `SorobanAuthorizationEntry` signing mechanism — the same primitive current x402 clients already use — making the client experience backwards-compatible. The client signs an auth entry for `channel_contract.update_state()` (a sub-invocation) instead of `token.transfer()`.

---

## Scope

- Soroban contract: channel lifecycle + full dispute mechanism
- TypeScript demo: server, client, facilitator (standalone, not extending x402-stellar)
- Benchmark: vanilla x402 vs. channel x402 on Stellar testnet
- Testnet setup script: creates funded accounts, deploys contract
- Documentation for sharing with the Stellar ecosystem

---

## Repository Structure

```
x402-stellar-channels/
├── contract/                    # Soroban Rust contract
│   ├── src/
│   │   ├── lib.rs               # Contract entry point + public interface
│   │   ├── channel.rs           # Channel state machine
│   │   ├── dispute.rs           # Dispute resolution logic
│   │   └── types.rs             # Shared data types
│   └── Cargo.toml
├── demo/                        # TypeScript demo
│   ├── src/
│   │   ├── server/              # Paid API server (exact + channel schemes)
│   │   ├── client/              # Agent client (channel lifecycle + request logic)
│   │   ├── facilitator/         # Manages open/close on-chain
│   │   └── benchmark/           # Benchmark runner + timing instrumentation
│   ├── package.json
│   └── tsconfig.json
├── scripts/
│   ├── setup-testnet.ts         # Create funded testnet accounts, deploy contract
│   └── deploy-contract.ts
├── docs/
│   └── superpowers/specs/
│       └── 2026-03-17-x402-stellar-channels-design.md
└── README.md
```

---

## Soroban Contract

### On-chain state (per channel)

```rust
pub struct Channel {
    pub id:               BytesN<32>,   // SHA-256(agent || server || asset || nonce)
    pub agent:            Address,
    pub server:           Address,
    pub asset:            Address,       // USDC token contract
    pub deposit:          i128,
    pub iteration:        u64,           // latest agreed iteration (starts at 0)
    pub agent_balance:    i128,
    pub server_balance:   i128,
    pub status:           ChannelStatus,
    pub dispute_state:    Option<ChannelState>,
    pub observation_end:  Option<u32>,   // ledger sequence; dispute window closes *after* this ledger
}

pub enum ChannelStatus { Open, Closing, Closed }

pub struct ChannelState {               // the off-chain signed payload
    pub channel_id:       BytesN<32>,
    pub iteration:        u64,
    pub agent_balance:    i128,
    pub server_balance:   i128,
}
```

**Channel ID derivation:** `channel_id = SHA-256(agent_address || server_address || asset_address || nonce)` where `nonce` is a random 32-byte value supplied by the agent at open time. This allows multiple concurrent channels between the same agent/server pair (different assets, or multiple sessions). The contract stores channels keyed by `channel_id`.

### `update_state` — internal sub-invocation target

`update_state(channel_id, iteration, agent_balance, server_balance)` is an **internal contract function** that validates a state transition and requires agent authorization via `require_auth()`. It is never called directly by external transactions — it is invoked as a sub-invocation from `close_channel`, `initiate_dispute`, and `resolve_dispute`. The agent signs a `SorobanAuthorizationEntry` that authorizes this sub-invocation; the outer function provides the calling context.

Validation inside `update_state`:
- `iteration > channel.iteration`
- `agent_balance + server_balance == channel.deposit`
- `agent_balance >= 0` and `server_balance >= 0`

### Contract functions

| Function | Caller | Behavior |
|---|---|---|
| `open_channel(server, asset, deposit, nonce)` | Agent | Transfers `deposit` from agent into contract escrow; derives and returns `channel_id`; status → `Open` |
| `close_channel(channel_id, state, agent_auth, server_auth)` | Either | Calls `update_state` with both auth entries present → immediate settlement; pays out `agent_balance` to agent, `server_balance` to server; status → `Closed` |
| `initiate_dispute(channel_id, state, initiator_auth)` | Either | Calls `update_state` requiring only the initiator's auth entry; stores `dispute_state`, sets `observation_end = current_ledger + OBSERVATION_WINDOW`; status → `Closing` |
| `resolve_dispute(channel_id, state, agent_auth, server_auth)` | Either | Before `observation_end` only; calls `update_state` requiring both auth entries; accepted only if `state.iteration > dispute_state.iteration`; resets `observation_end = current_ledger + OBSERVATION_WINDOW` |
| `finalize_dispute(channel_id)` | Anyone | Only when `current_ledger > observation_end` (exclusive boundary); settles using the stored `dispute_state`; status → `Closed` |
| `keep_alive(channel_id)` | Anyone | Extends Soroban contract storage TTL for the channel entry; should be called by the SDK on every payment request to prevent state expiry during long-running channels |

**Dispute model:** `initiate_dispute` requires only the initiator's auth entry because they are asserting their own last-known state. `resolve_dispute` requires both parties' auth entries because it is asserting a mutually-agreed state, which by definition both parties have signed. The observation window resets on each successful `resolve_dispute` call; this is bounded by the number of valid state transitions (not an unbounded griefing vector), since each resolution must present a higher iteration.

**`finalize_dispute` access:** Intentionally permissionless — anyone can call it after the window expires. `observation_end` is an exclusive boundary (`current_ledger > observation_end`), ensuring a `resolve_dispute` and `finalize_dispute` in the same ledger always resolves in favor of the resolution.

### Off-chain auth entries (per request)

**Agent auth entry:** The client signs a `SorobanAuthorizationEntry` targeting the `update_state` sub-invocation:
```
channel_contract.update_state(channel_id, iteration, agent_balance, server_balance)
```
- `signature_expiration_ledger` is set to a far-future ledger (channel lifetime)
- The SDK sets this automatically when constructing channel auth entries
- The signed payload commits to exact values of `channel_id`, `iteration`, `agent_balance`, `server_balance`

**Server counter-auth entry:** After verifying the agent's auth entry, the server signs its own `SorobanAuthorizationEntry` for the same `update_state(channel_id, iteration, agent_balance, server_balance)` sub-invocation. This is returned in the payment response header.

Both parties accumulate each other's latest auth entries. Either can submit `close_channel` or `initiate_dispute` using the state they hold.

---

## x402 Protocol Integration

### 402 Response (server advertises channel support)

```json
{
  "schemes": [
    {
      "scheme": "exact",
      "price": "0.001",
      "asset": "USDC"
    },
    {
      "scheme": "channel",
      "price": "0.001",
      "asset": "USDC",
      "channelParams": {
        "contractId": "C...",
        "facilitatorUrl": "http://localhost:3002",
        "minDeposit": "0.10",
        "observationWindow": 500
      }
    }
  ]
}
```

### Per-request payment header (client → server)

```json
{
  "scheme": "channel",
  "channelId": "abc123...",
  "iteration": 42,
  "agentBalance": "0.958",
  "serverBalance": "0.042",
  "authEntry": "<XDR-encoded SorobanAuthorizationEntry for update_state(...)>"
}
```

### Server-side verification (fully local, no chain)

```
1. Parse channelId → look up channel in in-memory open-channels map
2. Check iteration > channel.lastIteration
3. Check agentBalance + serverBalance == channel.deposit
4. Check serverBalance - channel.lastServerBalance == price
5. Decode authEntry XDR; verify the sub-invocation args match
   {channel_id, iteration, agent_balance, server_balance} exactly
6. Verify authEntry ed25519 signature against agent's public key
→ All pass: serve response, update stored state, call keep_alive(channelId) async
→ Any fail: 402
```

Step 5 prevents a replayed auth entry from a different channel or iteration passing steps 1–4 while its embedded payload mismatches.

### Payment response header (server → client)

```json
{
  "scheme": "channel",
  "channelId": "abc123...",
  "iteration": 42,
  "serverAuthEntry": "<XDR SorobanAuthorizationEntry — server's auth for update_state(...)>"
}
```

Both parties now hold mutually-signed auth entries for iteration N. Either can submit `close_channel(channelId, state, agentAuth, serverAuth)` on-chain.

---

## Benchmark

Runs both modes against the same Stellar testnet, same server, N requests (configurable via `BENCHMARK_CALLS` env var, default 20).

### Expected output

```
=== x402 Channels Benchmark — Stellar Testnet ===

--- Vanilla x402 (exact scheme, 20 calls) ---
  Call  1:  5,312ms  ✓
  Call  2:  4,988ms  ✓
  ...
  Call 20:  5,102ms  ✓
  Total: 101,840ms | Per-call avg: 5,092ms

--- Channel x402 (20 calls) ---
  Channel open:   6,234ms
  Call  1:           11ms  ✓
  ...
  Call 20:           12ms  ✓
  Channel close:  5,117ms
  Total: 11,582ms | Per-call avg (excl. open/close): 10ms

--- Summary ---
  Break-even point: 3 calls
  Total speedup (20 calls): 8.8x
  Per-call speedup (after open): 509x
```

### Benchmark files

- `benchmark/run.ts` — orchestrates both runs, prints results, saves `benchmark-results.json`
- `benchmark/vanilla.ts` — vanilla x402 run using exact scheme
- `benchmark/channel.ts` — channel run: open → N calls → close
- Both share a `TimedApiClient` with per-call timing instrumentation

---

## Testnet Setup

`scripts/setup-testnet.ts` (one command: `pnpm setup:testnet`):

1. Creates 3 Stellar testnet keypairs: agent, server, facilitator
2. Funds all three via Friendbot
3. Deploys the channel Soroban contract
4. Writes all keys + `CONTRACT_ID` to `.env.testnet`

---

## Security Properties

**Agent protection:** deposit exposure is bounded; agent can unilaterally initiate dispute and recover unspent funds if server goes offline.

**Server protection:** server holds the latest mutually-signed auth entries; can initiate dispute and claim accumulated payments if agent disappears.

**Replay protection:** contract enforces `iteration > stored_iteration` inside `update_state`; once a higher iteration is on-chain, all lower ones are permanently invalid.

**Dispute protection:** observation window (~42 min at default 500 ledgers) gives the other party time to submit a higher-iteration state before funds are finalized. Window resets on each valid resolution.

**Storage liveness:** Soroban contract storage has ledger-based TTL. The `keep_alive` function extends the TTL on every payment request, preventing channel state from expiring during long-running sessions. The SDK calls `keep_alive` asynchronously (fire-and-forget) after each successful request; a single failed call is acceptable because the next successful request will extend the TTL. The SDK should warn (not error) if `keep_alive` fails on consecutive requests.

---

## What This Is Not

- Not a general-purpose L2 rollup
- Not bidirectional (agent → server only; server never pays agent)
- Not suitable for one-off API calls (break-even at ~3 calls; use `exact` for fewer)
- Not a replacement for improving Stellar's base throughput
- Not privacy-preserving: final on-chain settlement reveals total payment flow (agent and server balances) for the entire channel lifetime to all observers

---

## References

- [x402-zero-latency ideas doc](https://github.com/stellar-experimental/ideas/tree/main/x402-zero-latency)
- [x402-stellar (vanilla implementation)](https://github.com/stellar/x402-stellar)
- [Starlight paper](https://stellar.org/blog/developers/starlight-a-layer-2-payment-channel-protocol-for-stellar)
- [PrivateX402 proposal](https://ethresear.ch/t/privatex402-privacy-preserving-payment-channels-for-multi-agent-ai-systems/24151)
