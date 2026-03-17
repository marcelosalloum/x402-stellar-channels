export interface ChannelState {
  channelId: string;    // hex-encoded 32 bytes
  iteration: bigint;
  agentBalance: bigint; // in token's smallest unit
  serverBalance: bigint;
}

export interface ChannelInfo {
  channelId: string;
  agentPublic: string;  // G... strkey
  agentPubkeyHex: string; // raw 32-byte pubkey hex (passed to contract)
  serverPublic: string;
  serverPubkeyHex: string;
  assetContractId: string;
  deposit: bigint;
  currentState: ChannelState;
  agentLastSig?: Buffer;
  serverLastSig?: Buffer;
}

export interface ChannelPaymentHeader {
  scheme: 'channel';
  channelId: string;
  iteration: string;    // bigint as decimal string
  agentBalance: string;
  serverBalance: string;
  agentSig: string;     // hex-encoded 64 bytes
}

export interface ChannelPaymentResponse {
  scheme: 'channel';
  channelId: string;
  iteration: string;
  serverSig: string;    // hex-encoded 64 bytes
}
