# PumpSwap fee fields and the Pump bonding curve

pump.fun ships three programs, not one. Knowing which account lives on which
program matters when you are decoding a token's lifecycle.

| program | ID | role |
|---|---|---|
| Pump (bonding curve) | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | pre-graduation curve, `create_v2` / `buy` / `sell` / `migrate` |
| PumpSwap (AMM) | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | constant-product pool after `migrate` |
| Pump Fees | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` | dynamic fee tiers (`FeeConfig`) |

Official IDLs: `idl/pump.json`, `idl/pump_amm.json`, `idl/pump_fees.json` in the
`pump-fun/pump-public-docs` repo.

## 1. PumpSwap `Pool` (300 bytes)

Account seeds: `["pool", index, creator, base_mint, quote_mint]`. The first
fields were covered in the AMM offset reference; the fee fields are the
addition here.

| field | offset | type |
|---|---|---|
| discriminator | 0 | 8 B |
| pool_bump | 8 | u8 |
| index | 9 | u16 |
| creator | 11 | pubkey |
| base_mint | 43 | pubkey |
| quote_mint | 75 | pubkey |
| lp_mint | 107 | pubkey |
| pool_base_token_account | 139 | pubkey |
| pool_quote_token_account | 171 | pubkey |
| lp_supply | 203 | u64 |
| coin_creator | 211 | pubkey |
| is_mayhem_mode | 243 | bool |
| is_cashback_coin | 244 | bool |
| virtual_quote_reserves | 245 | i128 |
| creator_fee_bps | 261 | u64 |
| can_edit_creator_fee | 269 | bool |
| is_holder_reward | 270 | bool |
| protocol_fees | 271 | u64 |
| creator_fees | 279 | u64 |

287 bytes of fields + 13 bytes trailing reserve = 300 on-chain.

## 2. `BondingCurve` (Pump program)

Account seeds: `["bonding-curve", mint]`. The mint itself is in the seeds, not
in the account data.

| field | offset | type |
|---|---|---|
| discriminator | 0 | 8 B (`17b7f83760d8ac60`) |
| virtual_token_reserves | 8 | u64 |
| virtual_quote_reserves | 16 | u64 |
| real_token_reserves | 24 | u64 |
| real_quote_reserves | 32 | u64 |
| token_total_supply | 40 | u64 |
| complete | 48 | bool |
| creator | 49 | pubkey |
| is_mayhem_mode | 81 | bool |
| is_cashback_coin | 82 | bool |
| quote_mint | 83 | pubkey |
| creator_fee_bps | 115 | u64 |
| can_edit_creator_fee | 123 | bool |
| is_holder_reward | 124 | bool |
| creator_fee | 125 | u64 |
| protocol_fees | 133 | u64 |
| depth | 141 | u8 |
| initial_virtual_quote_reserves | 142 | u64 |
| post_complete_base_out | 150 | u64 |
| post_complete_quote_in | 158 | u64 |

The current IDL totals 166 bytes, but on-chain curves can be 150 bytes (older
accounts not reallocated past `initial_virtual_quote_reserves`). The reserves,
`token_total_supply`, `complete`, and `creator` — the fields that matter for
judging a token's stage — sit in the first 81 bytes and are stable across both.

`virtual_*_reserves` are synthetic (drive the curve price), `real_*_reserves`
are the actual token/quote balances. `complete == true` means the curve has
graduated and migrated to a PumpSwap pool.

## 3. Fee configs

`GlobalConfig` (PumpSwap, seeds `["global_config"]`) holds `lp_fee_basis_points`
(20), `protocol_fee_basis_points` (5), `coin_creator_fee_basis_points`, and
`protocol_fee_recipients` (8 recipients, round-robin). `FeeConfig` on the Pump
Fees program adds per-market-cap `FeeTier`s. The per-pool accumulated fees land
in the `Pool` account's `protocol_fees` / `creator_fees` fields.

## Golden samples (mainnet, verified)

- **Pool** `GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J` (300 B): base_mint@43 =
  `7LSsEoJGh…pump`, quote_mint@75 = WSOL, lp_supply@203 = 4194352106721,
  protocol_fees@271 = 1846, creator_fees@279 = 90286, coin_creator@211 =
  `5L5k7gtN…`.
- **BondingCurve** `3MUkKMbuornHohtAtzrToSzqkj1gEEhQqYVz8sZnmQg1` (150 B, migrated):
  discriminator `17b7f83760d8ac60`, token_total_supply@40 = 1e15, complete@48 =
  1, creator@49 = `5L5k7gtN…` (matches the pool's coin_creator).

## Honeypot-detector note

`BondingCurve.complete` is the cheapest "is this token still on the curve"
signal: a token with `complete == false` has never graduated, so a PumpSwap
`Pool` for it does not exist yet. The `Pool` fee fields are read-only accruals,
useful for distinguishing real LP activity (nonzero `protocol_fees` /
`creator_fees`) from an empty pool.
