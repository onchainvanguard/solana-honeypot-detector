# Token-2022 extensions as honeypot mechanisms

Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) is not just "SPL
Token with more fields" — it is a distinct program whose extensions encode a
class of *premeditated* sell-blockers that a honeypot detector must enumerate
explicitly. This note documents the TLV extension list, the extensions that
matter for the "can the holder sell" question, and the danger ordering the
detector applies.

## The extension list: TLV after a 165-byte base

A Token-2022 mint is a 165-byte base (the legacy 82-byte header padded out,
with an `AccountType` byte at 165) followed by a TLV list starting at offset
166. Each entry is:

```
type:u16  length:u16  data:length
```

A zero-length, type-0 entry terminates the list. The detector walks this list
in `parseToken2022Extensions`, recording `{type, typeId, length, dataOffset}`
for every entry. The `typeId` maps to the SPL `ExtensionType` enum — fixed by
the spec, not reordered (verified against PYUSD's live mint: `PermanentDelegate
= 12`, `TransferHook = 14`).

## The sell-blocker extensions, in danger order

The detector's `analyzeHoneypot` ranks the signals by how directly each
extension can stop a holder from exiting:

1. **`PermanentDelegate` (12) — highest risk.** An address that can transfer or
   burn *any* holder's tokens unilaterally, with no holder signature. This is a
   built-in backdoor: the holder "owns" tokens the delegate can seize at will.
2. **`TransferHook` (14) — external program runs on every transfer.** A hook
   program is invoked on each transfer and can reject it, tax it, or reroute it.
   `getTransferHook` reports the hook program id; the sentinel `111...111` means
   "not enabled". A hook pointing anywhere else is a programmable sell gate.
3. **`PausableConfig` (26) — a sell-freeze switch.** An authority that can pause
   transfers entirely, freezing every holder out of the market at once.
4. **`NonTransferable` (9) — permanent honeypot.** Soul-bound tokens: transfers
   are disabled outright. Buyers can never sell. This is the extension that
   turns a "honeypot" from a risk into a certainty.
5. **`TransferFeeConfig` (1) — sell tax, including a hidden future tax.** The
   `olderTransferFee` is the currently active fee; `newerTransferFee` is a
   *future* fee that activates at a recorded `epoch`. A project can pre-schedule
   a 100% tax in `newer` — invisible until the epoch boundary hits — which is a
   hidden rug vector distinct from the current-rate signal. `decodeExtensionDetails`
   surfaces all three sub-fields (authority, both fee tiers, activation epoch).

## Two more that strand value

- **`MintCloseAuthority` (3)** — an address that can close the mint, stranding
  the outstanding supply. `getMintCloseAuthority` returns the authority.
- **`DefaultAccountState` (6)** — new token accounts are created pre-frozen,
  forcing an extra thaw step before a holder can move anything.

## Legacy vs. Token-2022: two independent mechanisms

The `freezeAuthority` the detector reads from the 82-byte header is *not* the
same thing as these extensions, and both must be checked:

- **`freezeAuthority`** (offset 46 option / 50 pubkey) is the legacy per-account
  freeze. Active ⇒ the authority can freeze any holder's token account. It is a
  compliance feature for stablecoins and a rug feature for launch-day tokens.
- **Token-2022 extensions** are an *additional* layer. A mint can carry a
  `PermanentDelegate` or `TransferHook` even with its `freezeAuthority`
  renounced. The detector reads both, in `listSellBlockers` (facts) and
  `analyzeCanSell` (judgment).

## What the detector reports

The sell verdict is objective before it is judgmental:

- `listSellBlockers` emits **facts** — which mechanisms are present, with no
  "malicious" label. `active_freeze_authority` / `permanent_delegate` /
  `transfer_hook` / `pausable` / `non_transferable`, each a fact.
- `analyzeCanSell` reduces to `sellable` = none of the five blockers is present.
  Any one of them flips the token to `at-risk`.
- `analyzeHoneypot` orders the signals by danger (`permanentDelegate` first,
  `transferFee` last) and folds the sell-tax bps in from the parsed extension
  details.

## Pitfalls

1. **The TLV terminator is `type=0,length=0`.** Reading past it into the account
   padding produces phantom extensions. `parseToken2022Extensions` stops on the
   terminator and guards against overrun.
2. **`newerTransferFee` is the hidden rug, not the current rate.** A token whose
   current fee reads 0% can still have a 100% fee armed for the next epoch. The
   future tier must be reported separately, not folded into "current tax".
3. **A `TransferHook` at `111...111` is "off".** Reporting "has a transfer hook"
   for the sentinel address is a false positive; check the program id against
   the zero address before flagging.

---

_Cross-checked against the detector source (`detect.js` extension parsing) and
PYUSD's live Token-2022 mint, October 21 2026._
