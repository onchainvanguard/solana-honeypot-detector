# Meteora DAMM v1 (Legacy Dynamic AMM) — Pool & LockEscrow account layout

Reference for the deprecated Meteora Dynamic AMM v1 (the "legacy vault" flavor of the
Dynamic AMM, distinct from the current DLMM and from the single-asset Dynamic Vault).
Offsets below are derived from the official Anchor IDL
(`@meteora-ag/dynamic-amm-sdk@1.4.1`, IDL version `0.5.3`) and confirmed against live
mainnet accounts.

- Program ID: `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB`
- Pool account discriminator: `f19a6d0411b16dbc` (`sha256("account:Pool")[..8]`)
- LockEscrow account discriminator: `be6a7906c8b6154b` (`sha256("account:LockEscrow")[..8]`)

Note: the `Pool` discriminator is identical to PumpSwap's, because both Anchor structs
are named `Pool`. A pool is disambiguated by its owner program id, never by discriminator
alone.

## Pool account layout (Anchor, 8-byte discriminator prefix)

Fields in IDL declaration order. Offsets are absolute (including the 8-byte prefix).

| offset | size | field | type | verified |
|-------:|-----:|-------|------|----------|
| 0      | 8    | (discriminator) | `f19a6d0411b16dbc` | chain |
| 8      | 32   | `lpMint` | pubkey | chain |
| 40     | 32   | `tokenAMint` | pubkey | chain |
| 72     | 32   | `tokenBMint` | pubkey | chain |
| 104    | 32   | `aVault` | pubkey | chain |
| 136    | 32   | `bVault` | pubkey | chain |
| 168    | 32   | `aVaultLp` | pubkey | chain |
| 200    | 32   | `bVaultLp` | pubkey | chain |
| 232    | 1    | `aVaultLpBump` | u8 | chain |
| 233    | 1    | `enabled` | bool | chain |
| 234    | 32   | `protocolTokenAFee` | pubkey | IDL |
| 266    | 32   | `protocolTokenBFee` | pubkey | IDL |
| 298    | 8    | `feeLastUpdatedAt` | u64 | IDL |
| 306    | 24   | `padding0` | u8[24] | IDL |
| 330    | 32   | `fees` | PoolFees (4 × u64) | IDL |
| 362    | 1    | `poolType` | enum (Permissioned=0 / Permissionless=1) | chain |
| 363    | 32   | `stake` | pubkey | IDL |
| 395    | 8    | `totalLockedLp` | u64 | chain |
| 403    | 73   | `bootstrapping` | Bootstrapping | IDL |

`totalLockedLp` is the field that matters for lock detection: it reports how much LP is
held inside the program's own lock escrow, directly from the pool's own accounting.

### Bootstrapping (offset 403)

| offset | size | field | type |
|-------:|-----:|-------|------|
| 403    | 8    | `activationPoint` | u64 (slot or timestamp) |
| 411    | 32   | `whitelistedVault` | pubkey |
| 443    | 32   | `poolCreator` | pubkey |
| 475    | 1    | `activationType` | u8 (0=slot, 1=timestamp) |

## LockEscrow account layout (Anchor, 8-byte discriminator prefix, 160 bytes)

| offset | size | field | type | verified |
|-------:|-----:|-------|------|----------|
| 0      | 8    | (discriminator) | `be6a7906c8b6154b` | chain |
| 8      | 32   | `pool` | pubkey | chain |
| 40     | 32   | `owner` | pubkey | IDL |
| 72     | 32   | `escrowVault` | pubkey | IDL |
| 104    | 1    | `bump` | u8 | IDL |
| 105    | 8    | `totalLockedAmount` | u64 | chain |
| 113    | 16   | `lpPerToken` | u128 | IDL |
| 129    | 8    | `unclaimedFeePending` | u64 | IDL |
| 137    | 8    | `aFee` | u64 | IDL |
| 145    | 8    | `bFee` | u64 | IDL |
| 153    | 7    | `padding` | u8[7] | IDL |

## Two pool sizes: 944 (legacy) vs 1387 (current)

Pool accounts exist in two `dataSize` values on mainnet — 944 bytes and 1387 bytes.
Every field up to `totalLockedLp` (offset 395) is at the same offset in both. The
difference lives entirely in the trailing fields after `bootstrapping`
(`partnerInfo`, `padding`, `curveType`, `padding1`), which are irrelevant to lock
detection.

Consequence for discovery: filter by **discriminator + mint memcmp only**, never by
`dataSize`. Hard-coding `dataSize: 1387` silently drops every 944-byte legacy pool.

## Lock semantics

DAMM v1 mints a fungible LP token (`lpMint`), so lock detection reuses the
"largest-holder authority" tri-state used for Raydium and PumpSwap, plus one extra
branch:

- The program's own `LockEscrow` (`create_lock_escrow` + `lock`) has **no unlock
  instruction**. LP deposited there is withdrawable only as the underlying tokens after
  the escrow is settled — it cannot be pulled back as LP. If the largest LP holder's
  token-account authority is a `LockEscrow` PDA (owner = the DAMM program), the pool is
  `PERMANENT` (burn method `program-escrow`).
- Judgment keys off the **largest holder**, not on "does any LockEscrow exist", so a pool
  where the bulk of LP sits in an ordinary wallet (with a small locked tail) is correctly
  `UNLOCKED`.

## Golden samples (mainnet, chain-verified)

| pool | size | lpMint | observation |
|------|-----:|--------|-------------|
| `X6vtmJzEjbZMnEcmjwfa839o5oDaxGdacucVSRcErDN` | 944 | fungible | 100% LP in LockEscrow → `PERMANENT` |
| `5yuefgbJJpmFNK2iiYbLSpv1aZXq7F9AUKkZKErTYCvs` | 1387 | `4x76pkvNJYy9YRZM6Y6RZXJckRpsHQEWoD6sM9HEpmB` | USDC/SOL; largest holder is an ordinary wallet → `UNLOCKED` (not a false positive) |
| `BXW3Ybme7j8xPodsvBySc73iGG6zoZ3YxnE3u27dUxXd` | 1387 | fungible | largest holder is LockEscrow → `PERMANENT` |

## Derivation method

1. Read the IDL struct fields in declaration order and accumulate type sizes
   (pubkey 32, u64 8, u128 16, u8 1, bool 1).
2. Anchor account data is prefixed with the 8-byte `sha256("account:<Name>")[..8]`
   discriminator.
3. Confirm each claimed offset against a live account: a wrong offset decodes to garbage
   (random pubkeys / absurd u64 values), a correct one decodes to real mints, vaults, and
   a `totalLockedLp` that is `<=` the `lpMint` total supply.

---
Vance | OnChain Vanguard
