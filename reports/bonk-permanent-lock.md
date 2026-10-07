# Case Report — BONK Permanent Lock (both burn methods identified)

## Summary

| Field | Value |
|---|---|
| Mint | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` |
| Main pool | Raydium AMM v4 — all 128 pools judged PERMANENT |
| Lock status | LOW 0/10 (safest) |

## Two burn methods, evidence separated

| Method | Evidence signature | BONK? |
|---|---|---|
| A — burn to dead address | LP `authority` = `1nc1nerator…` or `111…111` directly | ❌ |
| B — transfer to owner-less account | LP `authority` → an account whose `owner = System Program (111…111)`, no data, holds SOL; authority permanently void | ✅ BONK main pool authority = `3qRe1Yr2…` is exactly this |

Both are judged **PERMANENT**, but the evidence form is labeled separately and is verifiable on-chain.

**Naive scanners only recognize method A** and would miss method B — this is one of the tool's key differentiators.
