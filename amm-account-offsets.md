# AMM Account Offsets

Byte offsets for discovering and decoding Solana AMM pool state accounts.

Every offset below is derived from the program's official IDL (field order plus
type sizes) and then verified against a live mainnet account. No hand-written or
second-hand offset tables are used.

## PumpSwap

| Item | Value |
|---|---|
| Program ID | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` |
| Account | `Pool` |
| IDL | `pump_amm.json` (pump.fun public docs) |
| Serialization | Anchor default (Borsh): 8-byte discriminator + struct |

Pool account field layout (offset is absolute, from byte 0 of the account):

| Field | Offset | Size | Type |
|---|---|---|---|
| discriminator | 0 | 8 | `[241,154,109,4,17,177,109,188]` |
| pool_bump | 8 | 1 | u8 |
| index | 9 | 2 | u16 |
| creator | 11 | 32 | pubkey |
| base_mint | 43 | 32 | pubkey |
| quote_mint | 75 | 32 | pubkey |
| lp_mint | 107 | 32 | pubkey |
| pool_base_token_account | 139 | 32 | pubkey |
| pool_quote_token_account | 171 | 32 | pubkey |
| lp_supply | 203 | 8 | u64 |
| coin_creator | 211 | 32 | pubkey |
| is_mayhem_mode | 243 | 1 | bool |
| is_cashback_coin | 244 | 1 | bool |
| virtual_quote_reserves | 245 | 16 | i128 |
| creator_fee_bps | 261 | 8 | u64 |
| can_edit_creator_fee | 269 | 1 | bool |
| is_holder_reward | 270 | 1 | bool |
| protocol_fees | 271 | 8 | u64 |
| creator_fees | 279 | 8 | u64 |

Notes:

- The struct serializes to 287 bytes (279 payload + 8 discriminator). Live pool
  accounts are 300 bytes; the trailing 13 bytes are reserved. Pool discovery
  should match the 8-byte discriminator rather than an exact `dataSize`.
- Pool PDA seeds: `["pool", index, creator, base_mint, quote_mint]`.

Verification (mainnet): pool `GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J`
reads `base_mint` at offset 43 and `quote_mint` at offset 75, both matching the
known mints.

## Meteora DLMM

| Item | Value |
|---|---|
| Program ID | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` |
| Account | `LbPair` |
| IDL | `dlmm.json` (Meteora `lb_clmm` v0.12.0) |
| Serialization | `bytemuck` `repr(C)`: 8-byte discriminator + struct (explicit `_padding` fields, no implicit alignment padding) |

LbPair account field layout:

| Field | Offset | Size | Type |
|---|---|---|---|
| discriminator | 0 | 8 | `[33,11,49,98,181,101,177,13]` |
| parameters | 8 | 32 | StaticParameters |
| v_parameters | 40 | 32 | VariableParameters |
| bump_seed | 72 | 1 | [u8;1] |
| bin_step_seed | 73 | 2 | [u8;2] |
| pair_type | 75 | 1 | u8 |
| active_id | 76 | 4 | i32 |
| bin_step | 80 | 2 | u16 |
| status | 82 | 1 | u8 |
| require_base_factor_seed | 83 | 1 | u8 |
| base_factor_seed | 84 | 2 | [u8;2] |
| activation_type | 86 | 1 | u8 |
| creator_pool_on_off_control | 87 | 1 | u8 |
| token_x_mint | 88 | 32 | pubkey |
| token_y_mint | 120 | 32 | pubkey |
| reserve_x | 152 | 32 | pubkey |
| reserve_y | 184 | 32 | pubkey |
| protocol_fee | 216 | 16 | ProtocolFee |
| _padding_1 | 232 | 32 | [u8;32] |
| reward_infos | 264 | 288 | [RewardInfo;2] |
| oracle | 552 | 32 | pubkey |
| bin_array_bitmap | 584 | 128 | [u64;16] |
| last_updated_at | 712 | 8 | i64 |
| _padding_2 | 720 | 32 | [u8;32] |
| pre_activation_swap_address | 752 | 32 | pubkey |
| base_key | 784 | 32 | pubkey |
| activation_point | 816 | 8 | u64 |
| pre_activation_duration | 824 | 8 | u64 |
| _padding_3 | 832 | 8 | [u8;8] |
| _padding_4 | 840 | 8 | u64 |
| creator | 848 | 32 | pubkey |
| token_mint_x_program_flag | 880 | 1 | u8 |
| token_mint_y_program_flag | 881 | 1 | u8 |
| version | 882 | 1 | u8 |
| _reserved | 883 | 21 | [u8;21] |

Notes:

- Total account size is 904 bytes (8 discriminator + 896 struct), matching live
  mainnet `LbPair` accounts.
- DLMM liquidity is represented by position NFTs (`Position` / `PositionV2`),
  not a fungible LP mint. The lpMint-based lock classification does not apply.

Verification (mainnet): SOL/USDC `LbPair` accounts `5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6`
and `BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y` read `token_x_mint` at offset 88
(WSOL) and `token_y_mint` at offset 120 (USDC), matching the known pair.
