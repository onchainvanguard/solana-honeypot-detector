# Case Report — Trump Digital Gold (GOLD): a social-engineering rug, not a technical honeypot

**OnChain Vanguard — on-chain forensics. Detection: 2026-10-07, Solana mainnet-beta.**

## Summary

| Field | Value |
|---|---|
| Token | Trump Digital Gold (GOLD) |
| Mint | `EMWtbpHaNqMbjUMZguuazhuZUVLWG3z4C5oZnGJPSqxS` |
| Deployed | 2026-08-29/30 |
| Peak market cap | ~$60M (within two hours) |
| Drawdown | -95% to -99% |
| Rug method | hijacked @realtrumpcoins1 account + dev sell-first + LP removal |
| Independent reference | ChainBounty / SentinelTX CASE-20260829-GOLD |

## What the detector found

GOLD's mint and freeze authorities are both renounced, with no dangerous extensions and no transfer fee. The detector reports LOW 0/10 — technically it has no backdoor, and the detector did not invent one.

```
Token mint : EMWtbpHaNqMbjUMZguuazhuZUVLWG3z4C5oZnGJPSqxS
Program    : Token (legacy SPL)
Mint authority  : renounced
Freeze authority: renounced
Extensions (0)  : none
Sell-blockers   : none
Transfer fee    : none -> 0%
LP lock         : no Raydium AMM v4 pool found (main pool on Meteora)
VERDICT         : LOW (0/10)
```

## The honest boundary this case exposes

GOLD was a social-engineering rug — the token contract is technically clean, and the theft happened through a hijacked account, a dev sell-first, and LP removal. Not every rug is a honeypot:

- **Technical honeypot** (backdoor / sell tax / freeze) — detected by reading the token's authorities and extensions.
- **Social-engineering rug** (hijacked account / LP removal / coordinated exit) — needs cash-flow tracking and multi-AMM coverage, which are outside the current scope.

Two specifics worth noting:

1. **LP lock was reported `unknown`, not guessed.** GOLD's main pool is on Meteora, and pool discovery currently covers Raydium AMM v4 only. The detector did not claim "no liquidity" or fabricate a lock state — it reported that the pool could not be checked on the covered venue.

2. **The missing coverage is the real gap.** Had Meteora been covered, the LP-lock check would have flagged UNLOCKED (LP in an ordinary wallet, withdrawable at any time) and raised the score. Multi-AMM coverage is a planned extension, and this case shows why it matters.

## Conclusion

The value of this case is not that the detector caught the rug — it did not, and should not pretend otherwise. It is that the report stays accurate: no false backdoor, an explicit `unknown` for the uncovered venue, and a clear statement of the coverage boundary. That accuracy, not an inflated red flag, is the differentiator.
