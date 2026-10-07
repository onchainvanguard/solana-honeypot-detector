# Case Report — LP lock expired but not withdrawn (technical honeypot)

**OnChain Vanguard — on-chain forensics. Detection: 2026-10-07, Solana mainnet-beta.**

## Summary

| Field | Value |
|---|---|
| Mint | `FHea4fcmfsQYaZV89fRrW7iSX1ngHRzqYZ92TEexnyRX` |
| Pool | Raydium AMM v4, paired with SOL |
| Locker | UNCX (3 split locks) |
| Lock expiry | 2026-04-16 to 2026-04-17 — all expired, ~173 days past at detection |
| Remaining locked | 5.45e13 + 4.43e13 + 4.42e13 LP, still in vault |

## What the detector found

All three locks have an `unlock_date` in the past, yet the LP has not been withdrawn. The detector reports HIGH: expired and not withdrawn.

```
LP lock:
  1 Raydium AMM v4 pool found
  pool 31NU9EUNGnkan7YXnjjPzzkGvEuu9CsuFw7QX1mbvSAP -> TIME_LOCKED
    HIGH: lock expired (unlock 2026-04-16 18:15:37 UTC), LP not yet withdrawn
    lpMint: 8VbK6FBqNQuKrcVrcp4vidE4ThW7W8QUizJshf3k7HQd
    UNCX lock 2uM6LzWHqRWVfMnBYMDyZjRaGmGpzyXSDa7s1qjPHP1k
      expiry 2026-04-17 00:13:01 UTC  [expired, not withdrawn] [revocable]
      remaining: 54,566,831,522,654
    UNCX lock 5rBUVfivrykbELGSavgeJEy9zY5k23gvJAmv4BaKoraH
      expiry 2026-04-16 21:04:48 UTC  [expired, not withdrawn] [revocable]
      remaining: 44,372,078,020,795
    UNCX lock 6B4XxbQ6kDe5pp7hgxc1wRw3rY9JTVfr4VU7grevjFKS
      expiry 2026-04-16 18:15:37 UTC  [expired, not withdrawn] [revocable]
      remaining: 44,273,155,954,495

SCORE: LP lock TIME_LOCKED (HIGH)
VERDICT: MEDIUM (3/10)
```

## Why this matters

An expired-but-not-withdrawn lock looks locked on most dashboards while being one transaction away from a rug. The deployer can pull the pool at any time. The detector reads the exact `unlock_date` and marks the token HIGH instead of "safe, locked".

Three points where generic tools fall short:

1. **It reads `unlock_date` (offset 89 in the UNCX TokenLock account), not just "is the authority a locker".** Generic tools see the authority is UNCX and label it "locked = safe", without noticing the lock has already expired.

2. **Split locks are read one by one.** This pool's LP is split across three UNCX locks with different expiry times (18:15 / 21:04 / 00:13 next day). The detector reads each and flags all three as expired.

3. **UNCX revocability is a rug vector.** An UNCX lock owner can withdraw, relock, or transfer. After expiry the deployer can pull the LP. The detector labels each lock `[revocable]`.

The pool could have been flagged before the rug — reading expiry time plus "already past" is what makes the difference, not the presence of a locker.
