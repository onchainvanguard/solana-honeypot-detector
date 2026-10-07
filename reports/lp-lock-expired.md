# Case Report — LP Lock Expired but Not Withdrawn (technical honeypot)

## Summary

| Field | Value |
|---|---|
| Mint | `FHea4fcmfsQYaZV89fRrW7iSX1ngHRzqYZ92TEexnyRX` |
| Pool | Raydium AMM v4, paired with SOL |
| Locker | UNCX (3 split locks) |
| Lock expiry | 2026-04-16 ~ 2026-04-17 (all **expired**, ~173 days past at detection time) |
| Remaining locked | 5.4e13 + 4.4e13 + 4.4e13 (LP still in vault, not withdrawn) |

## Verdict: HIGH — "expired & not withdrawn, rug-able any time"

All 3 locks have `unlock_date` in the past, yet the LP has NOT been withdrawn. The deployer can pull the pool in a single transaction at any moment.

**This is exactly the trap called out early on:** a lock whose time has passed but whose deployer hasn't moved is *deceptively* still "in the locker" on the surface — in reality it's one click away from a rug. The detector reads the exact unlock timestamp and upgrades it to HIGH.

> "Could have been caught 3 days early" — a live demonstration of why reading the *expiry time + whether already past* matters, not just "is it locked."
