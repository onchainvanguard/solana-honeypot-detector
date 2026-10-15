# Orca Whirlpool account layout (Whirlpool + Position + LockConfig)

Orca Whirlpool is Solana's second-largest AMM (by TVL, behind Raydium). Unlike
Raydium/PumpSwap/DAMM v1, it has **no fungible LP mint** — liquidity is held as
**position NFTs**. This changes both pool discovery and the LP-lock check.

## Program

- Program ID: `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`
- Anchor-based. Every account is prefixed with an 8-byte discriminator:
  `sha256("account:<Name>")[..8]`.
- Layouts derive from the official `whirlpools` SDK codec (Rust crate
  `whirlpools`), cross-checked against mainnet account data.

## Discriminators

| account | discriminator (hex) | discriminator (bytes) |
|---|---|---|
| `Whirlpool` | `3f95d10ce1806309` | `[63,149,209,12,225,128,99,9]` |
| `Position` | `aabc8fe47a40f7d0` | `[170,188,143,228,122,64,247,208]` |
| `LockConfig` | `6a2fee9f7c0ca0c0` | `[106,47,238,159,124,12,160,192]` |

## 1. Whirlpool (653 bytes)

The pool itself. Only the fields needed for honeypot detection are listed; the
struct has more trailing fields.

| field | offset | type | note |
|---|---|---|---|
| discriminator | 0 | 8 B | `3f95d10ce1806309` |
| liquidity | 49 | u128 | pool's active liquidity |
| tokenMintA | 101 | pubkey (32 B) | one side of the pair |
| tokenVaultA | 133 | pubkey | vault holding token A |
| tokenMintB | 181 | pubkey | the other side |
| tokenVaultB | 213 | pubkey | vault holding token B |

Discovery: `getProgramAccounts` with a discriminator memcmp at offset 0, plus a
mint memcmp at offset 101 (tokenMintA) or 181 (tokenMintB), for each side.

## 2. Position (216 bytes)

One LP's liquidity in a pool. The `positionMint` is an NFT mint; whoever holds
that NFT controls the position.

| field | offset | type |
|---|---|---|
| discriminator | 0 | 8 B |
| whirlpool | 8 | pubkey |
| positionMint | 40 | pubkey (NFT mint) |
| liquidity | 72 | u128 |

## 3. LockConfig (241 bytes, incl. 128 B reserve)

Orca's official position lock. 241 bytes including a trailing 128-byte reserve
padding.

| field | offset | type |
|---|---|---|
| discriminator | 0 | 8 B |
| position | 8 | pubkey |
| position_owner | 40 | pubkey |
| whirlpool | 72 | pubkey |
| lock_type | 112 | u8 |

## Lock semantics

`lock_type` is the `LockType` / `LockTypeLabel` enum. **It has only one variant:
`Permanent = 0`.** There is no time-lock. So:

- A position with a `LockConfig` → its liquidity is **permanently locked**
  (cannot be withdrawn).
- A position without a `LockConfig` → unlocked; the position-NFT holder's
  authority determines control.

For the LP-lock check, the right anchor is the **largest position by
liquidity**, not "does any position have a LockConfig" — otherwise a pool whose
largest position is a normal wallet gets misread as permanently locked because a
tiny position happened to be locked.

## Golden samples (mainnet, verified)

- **Whirlpool** `Esvfxt3jMDdtTZqLF1fqRhDjzM8Bpr7fZxJMrK69PB7e` (WSOL/USDC):
  tokenMintA@101 = WSOL, tokenMintB@181 = USDC, liquidity@49 = 79,212,781,798,
  dataSize = 653.
- **Position** `8dDuyHzhMsniAEEnNmdVCBLZ5vqwcAdSjvu9nzJNt4Ek` (in the pool above):
  whirlpool@8 matches, positionMint@40 = NFT mint, liquidity@72 = 500,000,
  dataSize = 216. 34 positions exist in this pool.
- **LockConfig** `13iRKdqrqHoYxhGbHotBuHsnTtbvz37rExjUuGTGAqp`:
  lock_type@112 = 0 (Permanent), dataSize = 241. 1,719 LockConfig accounts exist
  program-wide, all with lock_type = 0.

## Traps

- **ownerless-burn misread**: a normal wallet's account owner is the System
  Program (`11111111111111111111111111111111`), which is exactly what the
  Raydium "ownerless burn" check (burn method B) looks for. Do **not** apply that
  check to position NFTs — a plain LP wallet would be misclassified as
  `PERMANENT`. Parameterize it off for the position path.
