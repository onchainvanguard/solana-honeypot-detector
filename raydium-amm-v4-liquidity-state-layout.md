# Raydium AMM v4 — LiquidityStateV4 account layout

The on-chain account for a Raydium AMM v4 pool is a 752-byte `LiquidityStateV4`
owned by program `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`. This is the
anchor AMM of our honeypot detector — the original LP-lock check — and the
only one of the five covered AMMs whose layout was not yet written down as a
standalone note. This document closes that gap.

Every offset below is derived from the official `raydium-sdk`
(`@raydium-io/raydium-sdk` 1.3.1-beta.58, `LIQUIDITY_STATE_LAYOUT_V4`) and
cross-checked against a live mainnet account.

## Layout (752 bytes)

The struct is a flat C-layout of `u64`, `u128`, `Pubkey` (32 bytes), and a
3×`u64` tail padding. Offsets are byte offsets from the start of account data.
There is no discriminator prefix — Raydium v4 predates Anchor and identifies
accounts purely by `owner == 675kPX9M...` + `dataSize == 752`.

### Scalar preamble (u64 × 32, offsets 0–248)

| offset | field |
|-------:|-------|
| 0 | status |
| 8 | nonce |
| 16 | maxOrder |
| 24 | depth |
| 32 | baseDecimal |
| 40 | quoteDecimal |
| 48 | state |
| 56 | resetFlag |
| 64 | minSize |
| 72 | volMaxCutRatio |
| 80 | amountWaveRatio |
| 88 | baseLotSize |
| 96 | quoteLotSize |
| 104 | minPriceMultiplier |
| 112 | maxPriceMultiplier |
| 120 | systemDecimalValue |
| 128 | minSeparateNumerator |
| 136 | minSeparateDenominator |
| 144 | tradeFeeNumerator |
| 152 | tradeFeeDenominator |
| 160 | pnlNumerator |
| 168 | pnlDenominator |
| 176 | swapFeeNumerator |
| 184 | swapFeeDenominator |
| 192 | baseNeedTakePnl |
| 200 | quoteNeedTakePnl |
| 208 | quoteTotalPnl |
| 216 | baseTotalPnl |
| 224 | poolOpenTime |
| 232 | punishPcAmount |
| 240 | punishCoinAmount |
| 248 | orderbookToInitTime |

### Swap amounts (u128 × 4 + u64 × 2, offsets 256–328)

| offset | field |
|-------:|-------|
| 256 | swapBaseInAmount (u128) |
| 272 | swapQuoteOutAmount (u128) |
| 288 | swapBase2QuoteFee (u64) |
| 296 | swapQuoteInAmount (u128) |
| 312 | swapBaseOutAmount (u128) |
| 328 | swapQuote2BaseFee (u64) |

### Vaults, mints, market accounts (Pubkey × 12, offsets 336–688)

| offset | field | note |
|-------:|-------|------|
| 336 | baseVault | SPL token account holding base |
| 368 | quoteVault | SPL token account holding quote |
| 400 | baseMint | |
| 432 | quoteMint | |
| 464 | lpMint | fungible LP mint |
| 496 | openOrders | OpenBook/Serum open-orders account |
| 528 | marketId | OpenBook/Serum market |
| 560 | marketProgramId | `srmqPvym...` (Serum DEX v3) |
| 592 | targetOrders | |
| 624 | withdrawQueue | `111...` when unused |
| 656 | lpVault | `111...` when unused |
| 688 | owner | pool authority |

### Tail (offset 720)

| offset | field |
|-------:|-------|
| 720 | lpReserve (u64) |
| 728 | padding (u64 × 3) → total 752 |

## Fields the detector reads

For LP-lock classification the detector reads only six fields, all verified:

- `status` @0 — pool state (6 = live)
- `baseVault` @336, `quoteVault` @368 — the "is there money in the pool" question
- `baseMint` @400, `quoteMint` @432 — pool discovery (`memcmp` on 400 / 432)
- `lpMint` @464 — the "largest-holder authority" lock classification

## Live golden sample

Pool `JEGvWDXsmHJ54vJ4oXCpavtEZjDp6kQ9LJSESG9E6qa4` (WSOL / `5BNbY59...pump`):

| field | on-chain value | matches |
|-------|----------------|---------|
| status @0 | 6 | ✓ |
| baseDecimal @32 | 9 (WSOL) | ✓ |
| quoteDecimal @40 | 6 | ✓ |
| baseMint @400 | `So1111...11112` (WSOL) | ✓ |
| quoteMint @432 | `5BNbY59...pump` | ✓ |
| marketProgramId @560 | `srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX` | ✓ (Serum DEX v3) |
| lpReserve @720 | 4043044538617 | ✓ |

## Offset bug found in `src/lpLock.js`

The constant block in `src/lpLock.js` declares three dead fields with wrong
offsets:

```
lpVault: 560,   // correct: 656
owner:   592,   // correct: 688
lpReserve: 624, // correct: 720
```

They are off by 96 bytes — exactly three `Pubkey`s — because the market trio
(`openOrders` @496, `marketId` @528, `marketProgramId` @560) was skipped in the
hand-written offset table. The on-chain read at offset 560 returns
`srmqPvym...` (Serum DEX v3), which is `marketProgramId`, not `lpVault`.

The bug is currently latent: `parseRaydiumV4State` only decodes
`status / baseVault / quoteVault / baseMint / quoteMint / lpMint`, none of which
are affected, so the BONK 128-pool result was unaffected. The three fields are
declared but never referenced. Fixing them (656 / 688 / 720) removes the trap
for any future code that wants the pool owner or LP reserve.

---

_Source: `@raydium-io/raydium-sdk` 1.3.1-beta.58 `LIQUIDITY_STATE_LAYOUT_V4`;
mainnet verification via Helius RPC, October 16 2026._
