use crate::types::*;
use soroban_sdk::{BytesN, Env};

/// Storage key for the DisputeState associated with a channel.
/// Uses a tuple to distinguish from the Channel key (which uses channel_id directly).
fn dispute_key(env: &Env, channel_id: &BytesN<32>) -> (BytesN<32>, u32) {
    (channel_id.clone(), 0u32)
}

pub fn initiate_dispute(
    env: &Env,
    channel_id: BytesN<32>,
    state: ChannelState,
    sig: BytesN<64>,
    is_agent: bool,
) {
    let mut channel: Channel = env
        .storage()
        .persistent()
        .get(&channel_id)
        .unwrap_or_else(|| panic!("not found: {}", ERR_NOT_FOUND));

    assert!(
        matches!(channel.status, ChannelStatus::Open),
        "not open: {}",
        ERR_NOT_OPEN
    );
    assert!(
        state.iteration >= channel.iteration,
        "bad iteration: {}",
        ERR_BAD_ITERATION
    );
    assert!(
        state.agent_balance + state.server_balance == channel.deposit,
        "bad balances: {}",
        ERR_BAD_BALANCES
    );
    assert!(
        state.agent_balance >= 0 && state.server_balance >= 0,
        "negative: {}",
        ERR_BAD_BALANCES
    );

    if is_agent {
        crate::crypto::verify_state_sig(
            env,
            &channel.agent_pubkey,
            &channel_id,
            state.iteration,
            state.agent_balance,
            state.server_balance,
            &sig,
        );
    } else {
        crate::crypto::verify_state_sig(
            env,
            &channel.server_pubkey,
            &channel_id,
            state.iteration,
            state.agent_balance,
            state.server_balance,
            &sig,
        );
    }

    let current_ledger = env.ledger().sequence();
    let observation_end = current_ledger + OBSERVATION_WINDOW;

    let dispute_state = DisputeState {
        channel_id: channel_id.clone(),
        iteration: state.iteration,
        agent_balance: state.agent_balance,
        server_balance: state.server_balance,
    };

    channel.status = ChannelStatus::Closing;
    channel.observation_end = Some(observation_end);

    let dkey = dispute_key(env, &channel_id);
    env.storage().persistent().set(&dkey, &dispute_state);
    env.storage()
        .persistent()
        .extend_ttl(&dkey, CHANNEL_TTL, CHANNEL_TTL);

    env.storage().persistent().set(&channel_id, &channel);
    env.storage()
        .persistent()
        .extend_ttl(&channel_id, CHANNEL_TTL, CHANNEL_TTL);
}

pub fn resolve_dispute(
    env: &Env,
    channel_id: BytesN<32>,
    state: ChannelState,
    agent_sig: BytesN<64>,
    server_sig: BytesN<64>,
) {
    let mut channel: Channel = env
        .storage()
        .persistent()
        .get(&channel_id)
        .unwrap_or_else(|| panic!("not found: {}", ERR_NOT_FOUND));

    assert!(
        matches!(channel.status, ChannelStatus::Closing),
        "not closing: {}",
        ERR_NOT_CLOSING
    );

    let observation_end = channel
        .observation_end
        .unwrap_or_else(|| panic!("not found: {}", ERR_NOT_FOUND));

    let current_ledger = env.ledger().sequence();
    assert!(
        current_ledger <= observation_end,
        "window expired: {}",
        ERR_WINDOW_EXPIRED
    );

    let dkey = dispute_key(env, &channel_id);
    let dispute_state: DisputeState = env
        .storage()
        .persistent()
        .get(&dkey)
        .unwrap_or_else(|| panic!("not found: {}", ERR_NOT_FOUND));

    assert!(
        state.iteration > dispute_state.iteration,
        "bad iteration: {}",
        ERR_BAD_ITERATION
    );
    assert!(
        state.agent_balance + state.server_balance == channel.deposit,
        "bad balances: {}",
        ERR_BAD_BALANCES
    );
    assert!(
        state.agent_balance >= 0 && state.server_balance >= 0,
        "negative: {}",
        ERR_BAD_BALANCES
    );

    crate::crypto::verify_state_sig(
        env,
        &channel.agent_pubkey,
        &channel_id,
        state.iteration,
        state.agent_balance,
        state.server_balance,
        &agent_sig,
    );
    crate::crypto::verify_state_sig(
        env,
        &channel.server_pubkey,
        &channel_id,
        state.iteration,
        state.agent_balance,
        state.server_balance,
        &server_sig,
    );

    let new_observation_end = current_ledger + OBSERVATION_WINDOW;

    let new_dispute_state = DisputeState {
        channel_id: channel_id.clone(),
        iteration: state.iteration,
        agent_balance: state.agent_balance,
        server_balance: state.server_balance,
    };

    channel.observation_end = Some(new_observation_end);

    env.storage().persistent().set(&dkey, &new_dispute_state);
    env.storage()
        .persistent()
        .extend_ttl(&dkey, CHANNEL_TTL, CHANNEL_TTL);

    env.storage().persistent().set(&channel_id, &channel);
    env.storage()
        .persistent()
        .extend_ttl(&channel_id, CHANNEL_TTL, CHANNEL_TTL);
}

pub fn finalize_dispute(env: &Env, channel_id: BytesN<32>) {
    let mut channel: Channel = env
        .storage()
        .persistent()
        .get(&channel_id)
        .unwrap_or_else(|| panic!("not found: {}", ERR_NOT_FOUND));

    assert!(
        matches!(channel.status, ChannelStatus::Closing),
        "not closing: {}",
        ERR_NOT_CLOSING
    );

    let observation_end = channel
        .observation_end
        .unwrap_or_else(|| panic!("not found: {}", ERR_NOT_FOUND));

    let current_ledger = env.ledger().sequence();
    assert!(
        current_ledger > observation_end,
        "window active: {}",
        ERR_WINDOW_ACTIVE
    );

    let dkey = dispute_key(env, &channel_id);
    let dispute_state: DisputeState = env
        .storage()
        .persistent()
        .get(&dkey)
        .unwrap_or_else(|| panic!("not found: {}", ERR_NOT_FOUND));

    crate::channel::payout(
        env,
        &channel,
        dispute_state.agent_balance,
        dispute_state.server_balance,
    );

    channel.status = ChannelStatus::Closed;
    env.storage().persistent().set(&channel_id, &channel);
}
