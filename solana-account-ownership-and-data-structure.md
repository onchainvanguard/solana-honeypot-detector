# Solana Account Ownership and Data Structure Primer

Foundational note for the honeypot detector's account-reading layer. Every
layout note in this repo (`spl-mint-authority-layout.md`,
`spl-token-account-layout.md`, the AMM pool layouts) assumes this model. This
note records *why* the detector reads accounts the way it does — the ownership
semantics and the data-structure traps underneath the offsets.

---

## The account is five fields, and three of them are enforced by the runtime

A Solana account is:

```
Account {
    lamports:   u64     // balance, pays rent
    data:       Vec<u8> // program-defined bytes
    owner:      Pubkey  // who may write this account
    executable: bool    // program vs. data account
    rent_epoch: Epoch   // when rent was last collected
}
```

The runtime enforces three things, and only three things:

1. **Only `owner` may write `data`.** A program can only modify accounts whose
   `owner` is its own program id. This is checked by the runtime, not by the
   program.
2. **Only `owner` may deduct lamports** (to pay rent or to move value).
3. **Only the system owner / loader can reassign `owner`** to a different
   program.

Everything else — what the bytes in `data` *mean* — is the program's own
problem. That decoupling is the detector's first lesson.

---

## Owner is enforced; data is not

The trap that matters for detection: **`owner` is a runtime-guaranteed label,
but the contents of `data` are whatever the owning program wrote.** A malicious
program can own an account and fill its `data` with any bytes it likes, at any
size it likes (up to the rent it is willing to pay).

Consequences the detector already relies on:

- `getProgramAccounts(owner, filters)` is **trustworthy as an ownership query**.
  Filtering by `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` returns exactly
  the accounts the Token Program owns. That set cannot be forged.
- Parsing the returned `data` is **not** trustworthy. The bytes are only
  meaningful if you apply the *correct layout for the account type*, and a
  hostile account can be sized to look like a different type.

This is why every layout note ends with "a wrong offset by one byte reads
garbage" — the garbage is the runtime's way of telling you the bytes are not
what your parser assumed.

---

## One owner, many data shapes: the account-type discrimination problem

The Token Program owns **two** data structures under the same owner:

| Account type | data length | How the detector tells them apart |
|---|---|---|
| Mint | 82 bytes | `dataSize: 82` filter, or the authority/decimals fields at fixed offsets |
| Token Account | 165 bytes | `dataSize: 165` filter |

Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) breaks the
fixed-size assumption entirely: its accounts carry a base layout **plus a
trailing TLV extension block**, so the same logical type has *variable* length
(documented in `token2022-honeypot-extensions.md`). A `dataSize`-exact filter
that works for legacy Token Program silently drops Token-2022 accounts.

The lesson generalizes beyond tokens: **account type is a property of the data
layout, not of the owner.** Before reading any field, the detector must first
decide *which* layout to apply, from `dataSize` and/or a leading
discriminator/tag — never from the owner alone.

---

## Rent and account liveness

An account whose `lamports` falls below the rent-exempt minimum is reclaimed by
the runtime and closed. Two detector-facing consequences:

1. **A "locked" account can simply stop existing.** A honeypot that claims
   "LP is locked forever" can have the LP token account closed for rent if the
   team drains it to zero. Reading the lock state must handle
   `account not found`, not crash on it.
2. **`lamports == 0` on an LP vault is itself a signal** — the liquidity has
   been pulled, regardless of what the lock label says.

The detector's account reader therefore treats "account missing" as a first-class
state, mapped to `unknown`/`drained`, not as an error to be swallowed.

---

## `executable` distinguishes program from data

Program accounts have `executable = true`; all data accounts (mints, token
accounts, pools, lockers) have `executable = false`. When the detector walks an
account and needs to know "is this a program I should treat as a locker/authority,
or a data account I should parse", it reads the `executable` flag — it never
guesses from the address. A pubkey that looks like a program id is not proof of
one; the flag is.

---

## What this means for the detector

1. Ownership queries (`getProgramAccounts` by owner) are trusted; layout parsing
   is not. Validate owner before parse, then parse with the type-correct layout.
2. Account type is decided by `dataSize`/discriminator, never by owner alone.
3. Account absence and `lamports == 0` are honeypot signals, not just edge cases.
4. `executable` is the only honest program-vs-data test.

These four rules are the invariant the rest of the layout notes rest on.
