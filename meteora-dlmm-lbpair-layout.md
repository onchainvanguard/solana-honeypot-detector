# Meteora DLMM — LbPair Full Account Layout

Companion to `amm-account-offsets.md`. That file lists only the two mint offsets;
this one documents the complete 904-byte `LbPair` layout and which fields a
liquidity or lock check actually needs.

Every offset below is derived from the official `dlmm.json` IDL (field order +
type sizes, `bytemuck` C-repr with explicit padding fields) and verified against
live SOL/USDC pairs on mainnet.

## Full field table (absolute offsets, byte 0 = discriminator)

| Field | Offset | Size | Type | Note |
|---|---|---|---|---|
| discriminator | 0 | 8 | [u8;8] | `21 0b 31 62 b5 65 b1 0d` |
| parameters | 8 | 32 | StaticParameters | base / decay / volatility fee params |
| v_parameters | 40 | 32 | VariableParameters | volatility accumulator |
| bump_seed | 72 | 1 | u8 | |
| bin_step_seed | 73 | 2 | [u8;2] | |
| pair_type | 75 | 1 | u8 | |
| active_id | 76 | 4 | i32 | current price bin (signed) |
| bin_step | 80 | 2 | u16 | price step |
| status | 82 | 1 | u8 | PairStatus: 0 = Enabled, 1 = Disabled |
| require_base_factor_seed | 83 | 1 | u8 | |
| base_factor_seed | 84 | 2 | [u8;2] | |
| activation_type | 86 | 1 | u8 | |
| creator_pool_on_off_control | 87 | 1 | u8 | |
| token_x_mint | 88 | 32 | Pubkey | |
| token_y_mint | 120 | 32 | Pubkey | |
| reserve_x | 152 | 32 | Pubkey | LB token X vault |
| reserve_y | 184 | 32 | Pubkey | LB token Y vault |
| protocol_fee | 216 | 16 | ProtocolFee | amount_x + amount_y (u64 x2) |
| _padding_1 | 232 | 32 | [u8;32] | |
| reward_infos | 264 | 288 | [RewardInfo;2] | 144 bytes x2 |
| oracle | 552 | 32 | Pubkey | |
| bin_array_bitmap | 584 | 128 | [u64;16] | initialized bin array state |
| last_updated_at | 712 | 8 | i64 | |
| _padding_2 | 720 | 32 | [u8;32] | |
| pre_activation_swap_address | 752 | 32 | Pubkey | |
| base_key | 784 | 32 | Pubkey | |
| activation_point | 816 | 8 | u64 | |
| pre_activation_duration | 824 | 8 | u64 | |
| _padding_3 | 832 | 8 | [u8;8] | |
| _padding_4 | 840 | 8 | u64 | |
| creator | 848 | 32 | Pubkey | |
| token_mint_x_program_flag | 880 | 1 | u8 | |
| token_mint_y_program_flag | 881 | 1 | u8 | |
| version | 882 | 1 | u8 | |
| _reserved | 883 | 21 | [u8;21] | |

Total: 904 bytes.

## What a liquidity check actually reads

- `reserve_x` (152) and `reserve_y` (184) are the pool's two token vault
  accounts. A pool's real reserves are the SPL token balances of these two
  accounts, not any field inside `LbPair` itself. To answer "is there still
  money in this pool" (the sell-exit question), read both vault accounts and
  check their `amount` field (offset 64 of the SPL token account).
- `active_id` (76) plus `bin_step` (80) give the current price. `active_id` is a
  signed i32; reading it as an unsigned value silently corrupts negative bins.
- `status` (82) is the pair's enabled/disabled flag.

## No lpMint — lock checks must change

DLMM has no `lpMint` field anywhere in `LbPair` (the IDL exposes only the X and
Y tokens). Liquidity is held as position accounts, so the Raydium-style check
"read the LP token account's authority" does not apply. A DLMM lock check has to
reason about position accounts instead — do not port the Raydium lpMint logic
verbatim.

## Verification

Two live SOL/USDC pairs (`5rCf1DM…AS6`, `BGm1tav…KD5Y`), read via public RPC:

- discriminator matches `[33,11,49,98,181,101,177,13]`, data length 904.
- `token_x_mint` @88 = WSOL, `token_y_mint` @120 = USDC.
- `reserve_x` @152 and `reserve_y` @184 each decode to a live SPL token account
  whose `mint` equals `token_x_mint` / `token_y_mint` respectively — the offset
  is correct, not guessed.
- Reading one byte off (151 / 183) yields garbage pubkeys, the usual negative
  control.
