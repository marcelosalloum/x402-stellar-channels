import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { createHash } from 'node:crypto';

/**
 * Builds the canonical 72-byte state message matching the Rust contract:
 * channel_id (32 BE) || iteration (8 BE) || agent_balance (16 BE) || server_balance (16 BE)
 */
export function stateMessage(
  channelId: Buffer,
  iteration: bigint,
  agentBalance: bigint,
  serverBalance: bigint,
): Buffer {
  const buf = Buffer.alloc(72);
  channelId.copy(buf, 0);
  buf.writeBigUInt64BE(iteration, 32);
  writeBigInt128BE(buf, agentBalance, 40);
  writeBigInt128BE(buf, serverBalance, 56);
  return buf;
}

function writeBigInt128BE(buf: Buffer, value: bigint, offset: number): void {
  const mask64 = (BigInt(1) << BigInt(64)) - BigInt(1);
  const hi = (value >> BigInt(64)) & mask64;
  const lo = value & mask64;
  buf.writeBigUInt64BE(hi, offset);
  buf.writeBigUInt64BE(lo, offset + 8);
}

/** Signs the 72-byte state message with the given Stellar keypair. Returns 64-byte sig. */
export function signState(
  keypair: Keypair,
  channelId: Buffer,
  iteration: bigint,
  agentBalance: bigint,
  serverBalance: bigint,
): Buffer {
  const msg = stateMessage(channelId, iteration, agentBalance, serverBalance);
  return Buffer.from(keypair.sign(msg));
}

/**
 * Verifies a state signature. Throws if invalid.
 * publicKeyStrkey: G... Stellar public key.
 */
export function verifyState(
  publicKeyStrkey: string,
  sig: Buffer,
  channelId: Buffer,
  iteration: bigint,
  agentBalance: bigint,
  serverBalance: bigint,
): void {
  const msg = stateMessage(channelId, iteration, agentBalance, serverBalance);
  const kp = Keypair.fromPublicKey(publicKeyStrkey);
  if (!kp.verify(msg, sig)) {
    throw new Error('invalid state signature');
  }
}

/**
 * Derives channel_id matching the contract: sha256(agent_pubkey_32 || nonce_32).
 * agentPubkeyBytes: raw 32-byte ed25519 public key (from pubkeyBytes()).
 */
export function deriveChannelId(agentPubkeyBytes: Buffer, nonce: Buffer): Buffer {
  return createHash('sha256').update(agentPubkeyBytes).update(nonce).digest();
}

/** Decodes a G... strkey to raw 32-byte ed25519 public key. */
export function pubkeyBytes(strkey: string): Buffer {
  return Buffer.from(StrKey.decodeEd25519PublicKey(strkey));
}
