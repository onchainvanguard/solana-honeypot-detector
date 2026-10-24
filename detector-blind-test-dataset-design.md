# Blind-Test Dataset Design for the Honeypot Detector

How the detector's accuracy is measured. The "宁缺毋假" (under-list, never
false-list) bar is only meaningful if it is *tested* against a labeled set of
accounts where the ground truth is known independently of the detector. This
note records the dataset construction and the question-design lessons that came
out of running those tests.

---

## Why blind-test at all

A honeypot detector fails in two directions:

- **False positive** — flags a normal pool as a honeypot. This is the expensive
  failure: it drives users away from healthy tokens and erodes trust in the tool.
- **False negative** — lets a real honeypot through. This is the dangerous
  failure: the user buys and cannot sell.

The "宁缺毋假" bar prioritizes avoiding false positives — under-list is
preferred to over-list. A blind test is the only honest way to confirm the
detector actually holds that bar, because the test questions are built from a
ground truth the detector never sees.

---

## The three sample classes

Every test set needs all three:

| Class | What it is | Role in the test |
|---|---|---|
| **Positive** (real honeypot) | Known rug / already-locked pools | Must be flagged. Catches false negatives. |
| **Negative** (healthy) | Large, multi-AMM pools with unambiguous locks | Must NOT be flagged. Catches false positives. |
| **Boundary** | Ambiguous: revocable time locks, expired locks, re-authorized mints | The interesting ones. Catches logic cracks. |

The `reports/` directory holds the positive class (e.g. the gold and catfi rugs)
and the negative class (the BONK permanent-lock pools). The boundary class is
built by hand from the lock-state edge cases.

---

## Boundary samples are worth more than the other two combined

Positive and negative samples only prove the detector gets *obvious* cases
right. The boundary samples are where a wrong call hides:

- **Revocable time lock** (UNCX) — "locked" but the owner can pull it before
  expiry. Is that `TIME_LOCKED` or `UNLOCKED`?
- **Cancelable vesting** (Streamflow) — a vesting stream with
  `cancelable_by_sender = 1` is *not* a lock. Flagging it as locked is a false
  "safe".
- **Expired time lock** (`reports/lp-lock-expired.md`) — the timestamp has
  passed. "Locked" is now meaningless.
- **Mint authority re-authorized** — authority was renounced, then the freeze /
  mint capability came back via a Token-2022 extension.

Each boundary sample forces the detector to state *which* three-state label it
assigns and why, and any wrong assignment is a direct pointer to a logic fix.

---

## Three-state labeling

Every sample carries an expected label from the lock model
(`lp-lock-classification.md`):

```
PERMANENT   — burn address / ownerless / program escrow with no unlock
TIME_LOCKED — third-party locker with an expiry, revocability read from the account
UNLOCKED    — authority is a live, non-burned holder
```

A test result is only "pass" if the detector's label matches the expected label.
A near-miss (e.g. `TIME_LOCKED` where the truth is `UNLOCKED` because the lock
already expired) is a **failure**, not a pass — under-labeling a rug is the
dangerous direction.

---

## Two false-positive control gates under test

The dataset also has to exercise the two gates that keep the false-positive rate
down (`detector-whitelist-and-false-positive-control.md`):

1. **Whitelist short-circuit** — stablecoins and well-known pools are answered
   from a pre-vetted list before any layout parsing. The test includes healthy
   large pools to confirm the short-circuit fires and does not mislabel.
2. **Honest `unknown`** — when the RPC tier lacks the index to discover a pool
   (e.g. Helius free tier has no base/quote mint memcmp), the detector must say
   `unknown`, not guess. The test includes index-starved cases to confirm it
   under-reports rather than over-reports.

---

## Double-blind structure

- The **question setter** builds the sample accounts and knows the ground truth.
- The **detector** consumes only chain data (owner, dataSize, layouts) and never
  sees the expected labels.
- Scoring happens only after both sides are frozen.

Keeping the two sides separate is what makes the result a measurement instead of
a self-confirmation.

---

## Lessons that stuck

1. **Boundary beats volume.** Ten boundary samples catch more real bugs than a
   hundred obvious ones.
2. **Under-labeling a rug is a fail.** The bar is asymmetric — false negatives
   are worse than false positives, but both are scored.
3. **Every failure maps to a code change.** A blind-test miss is never waived;
   it produces a fix to a whitelist entry, a revocability read, or the
   `unknown` branch.
4. **`unknown` is a valid, scored answer.** Guessing is the bug; saying
   `unknown` is the correct behavior under index starvation.
