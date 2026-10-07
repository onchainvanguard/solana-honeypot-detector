# Case Report — GOLD (Trump Digital Gold) Social-Engineering Rug

## Summary

| Field | Value |
|---|---|
| Token | Trump Digital Gold (GOLD) |
| Mint | `EMWtbpHaNqMbjUMZguuazhuZUVLWG3z4C5oZnGJPSqxS` |
| Rug time | 2026-08-29 — ~$60M market cap, collapsed ~95%+ in ~2 hours |
| Rug type | Social-engineering rug (stolen Trump-brand account + coordinated exit) |

## Detector results (5 checks)

| Check | Result |
|---|---|
| Can you sell? | ✅ Sellable (no sell tax, no blacklist) |
| Honeypot? | ✅ Not a honeypot (no transfer hook blocking sells) |
| LP lock | ⚠️ **Unknown** — main pool is on Meteora, not Raydium v4 (honestly reported, not fabricated) |
| Authorities | ✅ mint / freeze authority renounced |
| Backdoors | ✅ No permanent delegate or other dangerous extensions |

## Key takeaway

**The contract is technically clean.** This detector does NOT invent a backdoor where none exists — it honestly reports "main pool on Meteora, can't read."

The product boundary this exposes: catching "LP-withdrawal / coordinated-exit" rugs requires **Meteora coverage + a funds-flow dimension**, both marked TODO.

> This is the "宁缺毋假" (rather miss than fake) principle in action — a positive demonstration, not a failure.
