# LP Locker Account Layouts and Revocability Semantics (UNCX + Streamflow)

Part of the Solana honeypot detector's LP-lock engine. This note documents how the
detector distinguishes *timed* locks (LP parked in a third-party locker) from
*permanent* locks, by reading each locker's account layout and its revocability flag.

Context: `lp-lock-classification.md` established the three-state model
(PERMANENT / TIME_LOCKED / UNLOCKED) and the two discovery paths (fungible lpMint vs.
position NFT). This note fills in the detail that the three-state model depends on:
**what the locker's own account actually says, and whether the lock can be revoked
before expiry.**

---

## Why "in a locker" is not enough

The detection step is: *who is the authority of the LP token account / position NFT?*
When that authority is a locker program (or its vault authority), the LP is "locked".
But "locked" splits into two very different risk profiles:

- **Permanent lock** — authority is an escrow PDA owned by a program with **no
  unlock instruction**. Once in, the only exits are claim-fee / move. This is the
  strongest signal.
- **Timed lock** — authority is a locker that releases at an expiry timestamp, and
  may or may not be revocable *before* expiry. A timed lock is only as strong as its
  revocability semantics: a revocable timed lock is a rug vector, not protection.

The detector therefore keeps two separate maps:

```
LOCKER_PROGRAMS        -> timed lockers (UNCX, Streamflow)
PERMANENT_LOCK_PROGRAMS -> permanent lockers (Meteora DAMM v1 LockEscrow)
```

The key insight that bit us: **an LP vault's authority points at the locker's
*vault authority* PDA (e.g. UNCX's `BzKinc...`), not at the locker program itself.**
`BzKinc...` is not a real account — it is a PDA derived by the UNCX program. So the
mapping must key on both the program id *and* its known vault-authority addresses,
otherwise a locked pool reads as "unknown".

---

## UNCX Solana LP Locker

- Program: `GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo`
- Source: `uncx-network/raydium-amm-lp-locker` (open source, IDL available)
- Vault authority: `BzKincxjgFQjj4FmhaWrwHES1ekBGN73YesA7JwJJo7X` (PDA, not a real account)

`TokenLock` account, 146 bytes total, Anchor 8-byte discriminator
`49 e4 90 f1 9a 2c 5d ee`, then:

| Field | Offset | Type | Meaning |
|---|---|---|---|
| bump | 8 | u8 | (discriminator + 0) |
| amm_id | 9 | pubkey(32) | which AMM the LP belongs to |
| lp_mint | 41 | pubkey(32) | the LP mint |
| lock_global_id | 73 | u64 | locker global id |
| lock_date | 81 | i64 | lock start timestamp |
| **unlock_date** | **89** | i64 | expiry timestamp (the read the detector cares about) |
| country_code | 97 | u8 | |
| initial_lock_amount | 98 | u64 | |
| **current_locked_amount** | **106** | u64 | remaining locked amount (`0` = already withdrawn) |
| **lock_owner** | **114** | pubkey(32) | who may withdraw/relock/transfer |

**Revocability: `revocable = true`.** The lock owner can actively
withdraw / relock / transfer before `unlock_date`. So a UNCX "lock" only means
"parked until the owner chooses to pull it" — it is a timed lock with an owner
override, **not** a guarantee. The detector reads `current_locked_amount` to detect
the rug case where the amount has already been drained to zero.

## Streamflow

- Program: `strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m`
- Metadata account: 1104 bytes (official js-sdk `layout.ts`, gold-standard verified)

| Field | Offset | Type | Meaning |
|---|---|---|---|
| **end_time** | **33** | u64 | stream end (for a token lock = cliff + 1) |
| mint | 177 | pubkey(32) | token mint |
| escrow_tokens | 209 | pubkey(32) | escrow token account PDA |
| start_time | 409 | u64 | |
| net_amount_deposited | 417 | u64 | |
| period | 425 | u64 | |
| amount_per_period | 433 | u64 | |
| **cliff** | **441** | u64 | token-lock unlock moment |
| cliff_amount | 449 | u64 | |
| **cancelable_by_sender** | **457** | u8 | `1` = sender can cancel (rug risk) |
| cancelable_by_recipient | 458 | u8 | |

**Revocability: `revocable = false` for a token lock.** Both cancel flags read `0`,
so a Streamflow *token lock* cannot be cancelled and releases 100% at expiry.

The trap: Streamflow also runs ordinary **cancelable vesting**
(`cancelable_by_sender = 1`). A generic "it's in Streamflow" answer would conflate
the two. The detector must read the two cancel flags and classify
vesting-with-cancel separately from a true token lock — a token-lock label on a
cancelable vesting is a false "locked".

---

## Detector consumption

1. Read the LP token account / position-NFT authority.
2. If authority ∈ `PERMANENT_LOCK_PROGRAMS` → `PERMANENT` (program escrow, no unlock).
3. If authority ∈ `LOCKER_PROGRAMS` (program id or known vault authority) → timed:
   read the locker's account layout at the offsets above.
   - UNCX: `revocable` always true → treat as `TIME_LOCKED` *with owner override*
     flagged; `current_locked_amount == 0` → already drained, effectively UNLOCKED.
   - Streamflow: check `cancelable_by_sender` / `cancelable_by_recipient`; token lock
     (`0/0`) → `TIME_LOCKED` until `cliff`; cancelable vesting → flag rug risk.
4. Otherwise → largest-holder / owner analysis (the non-locker path).

All offsets above were derived from each locker's official IDL / js-sdk layout and
gold-standard-verified against live mainnet accounts — a wrong offset by even one
byte reads garbage, which is how we confirm the layout.

## Why this matters for honeypot detection

A common rug pattern is to claim "LP locked" as proof of safety. The counter is to
read the locker's own account: a revocable UNCX lock, or a Streamflow vesting with
`cancelable_by_sender = 1`, or a `current_locked_amount` already at zero, is the
same as unlocked. The detector never trusts the *label* "locked" — it trusts the
authority key, the expiry timestamp, and the revocability byte.
