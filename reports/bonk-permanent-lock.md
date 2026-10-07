# Case Report — BONK: permanent LP lock via the owner-less account burn

**OnChain Vanguard — on-chain forensics. Detection: 2026-10-07, Solana mainnet-beta.**

## Summary

| Field | Value |
|---|---|
| Token | BONK |
| Mint | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` |
| Pool | Raydium AMM v4 — 128 pools discovered |
| Lock status | PERMANENT (safest), verdict LOW 0/10 |

## What the detector found

BONK's main-pool LP is permanently locked, but not by burning to the incinerator. It was transferred to an owner-less account, which voids the authority permanently. The detector reports PERMANENT and labels the exact burn form.

```
LP lock:
  128 Raydium AMM v4 pools found
  pool ArPc4zuGURQmL6yipPjtoiKmd6SzAaecQEcTmASzXaZx -> PERMANENT
    burn form: owner-less account (authority permanently void)
    LP authority -> owner = System Program, no data
    lpMint: BpqWJpczgzWJzcgWQMtrXEJUvrygt1rzvNBgXtDdsXQQ

SCORE: LP lock SAFE (LOW)
VERDICT: LOW (0/10)
```

## Reading the on-chain evidence

The largest LP holder account and its authority:

| Field | Value |
|---|---|
| Largest LP token account | `BAaCuQFBymfAhEtHFfDxwEvuwzxRgqN9fgMSWuc31UfU` |
| LP balance | 19,669,827.5 LP |
| Authority of that token account | `3qRe1Yr2jYXiZPCBzMwFrDsfAbdFA3yCLRMFpjYpT28f` |
| Owner of that authority | `11111111111111111111111111111111` (System Program) |
| Data length of that authority | 0 |
| Lamports of that authority | 3,877,847 (active account, holds SOL) |

The authority account `3qRe1Yr2…` has the System Program as owner, carries no data, and holds SOL. No key or program can sign on its behalf, so the LP cannot be withdrawn. That is a permanent lock — achieved by transfer to an owner-less account rather than a burn address.

## The two burn forms

| Form | How | Authority shape | Generic tools |
|---|---|---|---|
| A — burn address | LP sent to `1nc1nerator…` | authority = burn address | recognized |
| B — owner-less account | LP sent to an account owned by the System Program with no data | authority = owner-less account | missed (they check `owner` and misjudge) |

Both forms are PERMANENT, with different evidence shapes. The detector labels which form applies, and the label is checkable on-chain.

## Conclusion

BONK is a healthy token and the detector scores it LOW 0/10 — it does not misread a compliant owner-less-account burn as a risk. The case pins two detection paths: distinguishing the two burn forms, and judging lock state by the token account authority rather than its owner.
