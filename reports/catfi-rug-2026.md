# Case Study — CATFI (Catpie) Rug Pull

OnChain Vanguard — real incident, verifiable on-chain
Detection date: 2026-10-08 | Chain: Solana mainnet-beta

---

## Summary

CATFI was a liquidity-removal rug pull, not a technical honeypot. Its contract is clean on the surface: both mint and freeze authorities are renounced, no dangerous extensions, no permanent delegate, no transfer hook, no sell tax. The rug was a wash-trading pump followed by liquidity withdrawal from a standard Raydium AMM v4 pool.

CATFI is the first decentralized-exchange rug pull criminally prosecuted in South Korea. Five suspects were indicted on 2026-05-27 under the Virtual Asset User Protection Act — the first time the Act's unfair-trading provisions were applied to on-chain DEX conduct rather than a centralized exchange.

The token's pool type is exactly what this detector covers (Raydium AMM v4), so the LP-lock dimension is resolvable on-chain. The difference from the GOLD case is that CATFI's pool is on Raydium, not Meteora.

---

## Incident background (publicly verifiable)

| Item | Value |
|---|---|
| Token | CATFI (Catpie) |
| Mint | `5AKD6AqoaHxuePTZUfSkiHM6gpCT4tJ6UMrNwDZGpump` |
| Launch platform | Pump.fun (Solana) |
| Launch date | early February 2025 |
| Price move | ~1,001x in 26 hours after launch |
| Peak market cap | ~$8.37M–8.99M |
| Crash | ~99% to ~$12k |
| Victims | 256 confirmed, ~$600k combined loss |
| Illegal profit | ~$260k (from ~$10k initial outlay) |
| Suspects | 5 indicted; ringleader used alias "Eth Father" |
| Prosecution | Seoul Southern District Prosecutors' Office, 2026-05-27, Virtual Asset User Protection Act |

---

## Detector output (raw, on-chain state as of 2026-10-08)

The following fields were read directly from the mint account and pool account via public RPC. Each value is reproducible.

```
Token mint : 5AKD6AqoaHxuePTZUfSkiHM6gpCT4tJ6UMrNwDZGpump
Program    : TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA (legacy SPL)
Mint authority  : (renounced)   [option byte 0 = null]
Freeze authority: (renounced)   [option byte 0 = null]
Decimals   : 6
Supply     : 998,352,738,956,737 (raw u64)
Extensions : none (legacy SPL, no Token-2022 extensions)
Sell tax   : no TransferFeeConfig -> 0%
Pool       : 4CdF2c9ospY2dKKuonv7qgL1iUNMyujVJhcWZmWVz238
Pool owner : 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 (Raydium AMM v4)
Pool data  : 752 bytes (exact Raydium AMM v4 layout)
LP mint    : 7ZCHRLjK1M9NaQVTDvWGi6JcME4CoPywqAHLqvsnMemS
Pair       : CATFI / wrapped SOL
```

On-chain evidence for the mint account:

- owner program = `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` (standard SPL Token, not Token-2022)
- mint authority option (offset 0) = 0 -> renounced
- freeze authority option (offset 46) = 0 -> renounced
- data length = 82 bytes (exact legacy SPL Mint layout)

On-chain evidence for the pool account:

- owner = `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` (Raydium AMM v4 program)
- account data length = 752 bytes (matches Raydium AMM v4 `dataSize`)
- baseMint (offset 400) = wrapped SOL (`So11111111111111111111111111111111111111112`)
- quoteMint (offset 432) = CATFI (`5AKD6AqoaHxuePTZUfSkiHM6gpCT4tJ6UMrNwDZGpump`)
- lpMint (offset 464) = `7ZCHRLjK1M9NaQVTDvWGi6JcME4CoPywqAHLqvsnMemS`

The specific withdrawal transaction signature that drained liquidity in February 2025 is not published in any authoritative source (news coverage and GeckoTerminal do not disclose it). Marked unknown — not reconstructed.

---

## Post-mortem: why this is a liquidity rug, not a technical honeypot

### 1. The contract is technically clean (the detector was right not to flag a backdoor)

CATFI's mint and freeze authorities are both renounced. There is no permanent delegate, no transfer hook, no TransferFeeConfig. Any tool that inspects only authorities and extensions would report it as "no technical backdoor" — which is accurate. The mechanism of harm was not in the contract, but in the flow of liquidity.

### 2. The pool is on Raydium AMM v4 — inside this detector's coverage

The pool account owner is `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`, the Raydium AMM v4 program, with a 752-byte layout that matches the detector's `dataSize` filter. This is the exact pool type the LP-lock module discovers via `getProgramAccounts` + memcmp on the quote/base mint.

Contrast with the GOLD case: GOLD's main pool was on Meteora, outside the detector's coverage, so its LP-lock dimension reported unknown. CATFI's pool is on Raydium v4, so the LP-lock dimension is directly resolvable.

### 3. The rug was wash trading + liquidity withdrawal, both verifiable only with historical state

The prosecution's account describes the mechanics:

- Ringleader pre-loaded wallets with a dominant share of supply before public promotion.
- Coordinated wash trades (circular buys/sells across controlled wallets) faked volume and pushed price up ~1,001x in 26 hours.
- Liquidity was then withdrawn, collapsing the price ~99%.

Two of these are fund-flow facts (wash trading, pre-loaded wallets) that require historical transaction replay, not current account state. The liquidity withdrawal is reconstructable from the pool's LP-token balance history, but the specific withdrawal signature is not publicly documented.

### 4. Honest boundary

The detector, run today, reports a clean contract plus a Raydium v4 pool with an LP mint. It cannot, from current state alone, reconstruct that the pool was drained in February 2025 — that requires a historical snapshot of the LP-token balance. The report marks the withdrawal transaction signature as unknown rather than fabricating one.

---

## Conclusion

The CATFI case demonstrates a precise capability boundary in the opposite direction from GOLD:

1. Technical honeypot -> covered by the detector. CATFI has none, and the detector correctly reports none.
2. LP-lock / pool discovery -> covered for Raydium AMM v4, which is exactly where CATFI's pool lives.
3. Historical fund-flow (wash trading, withdrawal timing) -> outside current coverage; requires a historical-snapshot dimension.

The value here is the legal milestone as much as the technical one: CATFI is the first DEX rug pull criminally prosecuted in South Korea, and the first time the Virtual Asset User Protection Act's unfair-trading provisions were applied to on-chain conduct. It establishes that wash-trading patterns, wallet clustering, and coordinated sell-offs are forensically traceable and legally actionable even without a centralized exchange — the same evidence classes a fund-flow dimension would surface.
