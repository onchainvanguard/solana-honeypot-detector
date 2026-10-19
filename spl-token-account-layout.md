# SPL Token Account layout and the LP-holder authority question

The LP-lock verdict ("can the deployer pull liquidity?") reduces to a single
on-chain read: who holds the LP tokens, and can that party sign a withdrawal.
LP tokens live in **SPL Token Accounts**, so this note documents the 165-byte
account layout — and which of its fields are honeypot-relevant and which are a
trap if you read them naively.

## The 165-byte layout

```
offset  size  field
0       32    mint                  (Pubkey of the token)
32      32    owner                 (Pubkey = the *authority*, whoever can move this balance)
64      8     amount                (u64 LE, the balance)
72      4     delegateOption        (u32 LE, COption tag)
76      32    delegate              (Pubkey, when delegateOption = Some)
108     1     state                 (u8: 0 Uninitialized, 1 Initialized, 2 Frozen)
109     4     isNativeOption        (u32 LE, COption tag)
113     8     isNative              (u64 LE)
121     8     delegatedAmount       (u64 LE)
129     4     closeAuthorityOption  (u32 LE, COption tag)
133     32    closeAuthority        (Pubkey)
```

Total = 165 bytes (`ACCOUNT_SIZE`). Token-2022 reuses this same 165-byte base
for mint/account/multisig, then appends `AccountType` (1 byte) + a TLV tail.

## owner@32 is the authority, not the account's program owner

This is the field that answers "who can move this balance", and it is the single
most important byte range in LP-lock detection. Two distinct things share the
word "owner" and must not be confused:

- **The account's program owner** — reported by `getAccountInfo().owner`, always
  the Token Program (`TokenkegQfe...` or `TokenzQdBN...`). This only says "this
  is a token account", never *who* controls it.
- **`owner@32` in the data** — the authority (holder). This is the address that
  can sign a `transfer`/`burn`. For an LP position this is the deployer, a
  locker vault, a dead address, or an ordinary whale wallet.

`src/lpLock.js` reads `owner@32` for the largest LP holder and classifies the
lock state from that authority (ordinary wallet → `UNLOCKED`, locker → 
`TIME_LOCKED`, dead address / program escrow → `PERMANENT`).

## amount@64 is the balance

`readTokenAmount` in `lpLock.js` reads `data.readBigUInt64LE(64)` to get the raw
LP balance (a `u64`, read as `BigInt` to avoid JS precision loss above 2^53).
This is how the detector ranks holders ("largest holder") before classifying the
top authority — the lock verdict only ever looks at the *dominant* position, so
a small escrowed slice does not mask a dominant withdrawable one.

## The honeypot-relevant fields most detectors skip

Three fields beyond `owner`/`amount` are active honeypot mechanisms and should
not be ignored:

- **`delegate@76`** — a delegated address that can move the balance *without the
  owner signing*. A token whose accounts carry a live delegate can be drained
  even when the nominal authority looks clean. `delegateOption@72` is the COption
  tag; check the tag before trusting the pubkey.
- **`state@108`** — `2` means **Frozen**. A frozen account cannot be transferred
  out of: the holder can receive but not sell. This is the on-chain signature of
  a freeze honeypot, and it ties directly to the Mint's `freezeAuthority`.
- **`closeAuthority@133`** — an address that can close the account and reclaim
  its rent, or (for Token-2022, `MintCloseAuthority`) close the mint itself and
  strand supply.

## COption again: tag before payload

`delegateOption`, `isNativeOption`, and `closeAuthorityOption` are all the same
tagged union as the Mint header's authorities: a `u32` tag (`0` = `None`,
`1` = `Some`) followed by the payload only when `Some`. Reading the payload
without checking the tag produces a phantom delegate/close-authority that was
never set — the same class of bug as the Mint's authority decode.

## Pitfalls

1. **`owner@32` is the holder, not the program.** Classifying "is this account
   owned by the deployer" by `getAccountInfo().owner` always returns the Token
   Program and is meaningless — read `owner@32`.
2. **`amount` is a `u64`; use `BigInt`, not `Number`.** LP balances routinely
   exceed 2^53, where `Number` silently loses precision and the "largest holder"
   ranking goes wrong.
3. **`delegate` bypasses the authority.** A clean `owner@32` plus a live
   `delegate@76` still means the balance can move; the lock classifier must treat
   a delegated account as not-owner-controlled.

---

_Cross-checked against live mainnet token accounts, October 19 2026._
