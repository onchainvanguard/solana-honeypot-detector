# LP lock classification across five Solana AMMs

The core question a honeypot detector must answer is: *can the deployer pull
liquidity?* On Solana the answer reduces to one thing — who controls the LP
tokens, and can that party sign a withdrawal. This note documents the
classification the detector uses across five AMMs, the three lock states it
produces, and the three places where a naive implementation gets it wrong.

## The three states

| state | meaning |
|-------|---------|
| `PERMANENT` | LP can never be withdrawn by anyone. Safe (no rug). |
| `TIME_LOCKED` | LP is held by a locker and releases at a known timestamp. Safe *until* expiry, then re-check. |
| `UNLOCKED` | LP is in an ordinary wallet. Withdrawable at any time (rug risk). |

## Two code paths, split by LP representation

The first decision is whether the AMM has a **fungible LP mint**:

- **Fungible `lpMint`** — Raydium v4, PumpSwap, Meteora DAMM v1. Read the mint's
  largest token-account holder, then classify by that holder's `authority`.
- **Position NFT (no `lpMint`)** — Orca Whirlpool, Meteora DLMM. Liquidity is a
  position NFT; classify by the position's `owner` (or its official lock account).

The two paths converge on the same three states but use different evidence.

## Path 1 — fungible lpMint (largest-holder authority)

For a pool with `lpMint`, take the largest holder and walk down this order:

1. **Locker authority → `TIME_LOCKED`.** If the holder's authority is a locker
   vault (UNCX, Streamflow), read the lock account and report the unlock
   timestamp. Distinguish three sub-cases:
   - still active → `TIME_LOCKED` with remaining time,
   - expired but not yet withdrawn → `HIGH: expired, deployer can rug any moment`,
   - expired and already withdrawn → `CRITICAL: deployer pulled liquidity`.
2. **Dead-address authority → `PERMANENT` (burn method A).** Authority is the
   Solana Incinerator `1nc1nerator...` (or the zero address). Tokens are burned;
   nobody can ever withdraw.
3. **Official program escrow → `PERMANENT` (burn method C).** The largest
   holder's `authority` has `owner ==` a program whose escrow has no unlock
   instruction (currently only Meteora DAMM v1 `LockEscrow`).
4. **Ownerless account → `PERMANENT` (burn method B).** Authority resolves to an
   account owned by the System Program with no data, so no one can sign a
   withdrawal. **Only enabled for fungible-lpMint AMMs** (see pitfall 1).
5. **Ordinary wallet → `UNLOCKED`.**

## Path 2 — position NFT (no lpMint)

- **Orca Whirlpool** — a position is permanently locked only through the official
  `LockConfig` account. `LockType` has a single variant (`Permanent = 0`) — there
  is no timed lock in the Orca program. So: `LockConfig` present → `PERMANENT`;
  otherwise classify the position-NFT mint's authority by the three-state walk
  (with ownerless-burn disabled).
- **Meteora DLMM** — `PositionV2` carries a built-in `lock_release_point`
  (offset 7992). Non-zero and in the future → `TIME_LOCKED`; otherwise classify
  the position `owner` (dead address → `PERMANENT`, locker → `TIME_LOCKED`,
  ordinary wallet → `UNLOCKED`).

## The lockers and their revocability

The revocability of a lock is the difference between "safe" and "rug":

- **UNCX** (`GsSCS3v...`) — the lock owner can `withdraw` / `relock` /
  `transfer` before expiry. `revocable = true`. A lock that is still active is
  only as safe as the owner's intent; an expired UNCX lock is an active rug
  window.
- **Streamflow** (`strmRqUCo...`) — a *token lock* is non-cancellable
  (`cancelableBySender = 0`, `cancelableByRecipient = 0`), releasing 100% at
  cliff. But Streamflow also hosts cancellable *vesting* streams
  (`cancelableBySender = 1`); those must not be reported as locks.

## Pitfalls (each one is a real bug we hit)

1. **Ownerless-burn misclassifies ordinary EOA wallets for position NFTs.**
   An EOA wallet's `owner` is also the System Program (`111...`), which is
   exactly the ownerless-burn signature. For position NFTs this would label a
   normal whale wallet as `PERMANENT`. Fix: gate ownerless-burn behind
   `allowOwnerlessBurn`, enabled only for Raydium/PumpSwap fungible lpMint.
2. **Program-escrow must look at the *largest* holder, not "any escrow exists".**
   A pool whose dominant holder is an ordinary wallet but has a small slice in
   the program escrow is *not* permanently locked — the dominant liquidity can
   still be pulled. Only classify `PERMANENT` when the top holder is escrowed.
3. **An expired locker is not "safe".** A lock that has passed its unlock
   timestamp and still holds LP means the deployer can withdraw *right now*.
   The detector reports this as `HIGH`/`CRITICAL`, not as a lock.

## Golden samples

| AMM | sample | expected |
|-----|--------|----------|
| Raydium v4 | BONK pools (128) | `PERMANENT` (dead-address burn) |
| Meteora DAMM v1 | `X6vtmJz...` | `PERMANENT` (LockEscrow, program-escrow) |
| Meteora DAMM v1 | `5yuefgb...` (USDC/SOL) | `UNLOCKED` (top holder is ordinary wallet) |
| Orca Whirlpool | `Esvfxt3j...` (WSOL/USDC) | `UNLOCKED` (no LockConfig) |
| Meteora DLMM | `5rCf1DM...` (WSOL/USDC) | `UNLOCKED` (`lock_release_point = 0`) |

---

_Cross-checked against live mainnet accounts, October 17 2026._
