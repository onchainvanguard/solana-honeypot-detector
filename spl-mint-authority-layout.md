# SPL Mint account layout, COption encoding, and the renounce verdict

A honeypot detector's first question about a token is not "is it liquid" — it is
"can the deployer still mint more of it, and can they freeze your wallet?" Both
answers live in a single on-chain account: the SPL **Mint**. This note documents
the 82-byte header layout, the `COption` encoding that decides whether an
authority is *present or renounced*, and the Token-2022 extension tail that the
detector reads to catch sell-taxes and transfer hooks.

## Why the Mint is the first gate

The Mint account holds the token's global state. Three fields decide the rug
surface:

- **`mintAuthority`** — whoever can call `mintTo`. Not renounced ⇒ the deployer
  can mint unlimited supply and dilute holders to zero. Renounced ⇒ supply is
  capped forever.
- **`freezeAuthority`** — whoever can call `freezeAccount`. Not renounced ⇒ the
  deployer can freeze *your* token account and make it unsellable (a classic
  honeypot). Renounced ⇒ holders cannot be frozen.
- **`supply` / `decimals`** — the circulating amount and its decimal place, used
  to sanity-check displayed balances vs. on-chain reality.

## The 82-byte header (shared by legacy SPL and Token-2022)

```
offset  size  field
0       4     mintAuthorityOption   (u32 LE, COption tag)
4       32    mintAuthority         (Pubkey)
36      8     supply                (u64 LE)
44      1     decimals              (u8)
45      1     isInitialized         (u8)
46      4     freezeAuthorityOption (u32 LE, COption tag)
50      32    freezeAuthority       (Pubkey)
```

Total = 82 bytes (`MINT_SIZE`). Both `TokenkegQfe...` (legacy) and
`TokenzQdBN...` (Token-2022) share this header; Token-2022 appends an
extension tail on top.

## COption: how "renounced" is actually encoded

Rust's `COption<Pubkey>` is not a null-check on the pubkey bytes — it is a
tagged union serialized as:

- a `u32` **tag** (little-endian), then
- the 32-byte payload **only when the tag is `Some`**.

So the presence/absence decision is the *tag*, never the pubkey contents:

| tag | meaning | detector verdict |
|-----|---------|------------------|
| `0` | `None` | authority **renounced** (revoked forever, no on-chain way back) |
| `1` | `Some` | authority **active** (the following 32 bytes are the holder) |

Pitfall: reading offset `0` as a 32-byte pubkey is wrong — the first 4 bytes are
the tag. A renounced mint authority has tag `0` at offset 0 and all-zero bytes
at offset 4..35. `parseMint` in `src/detect.js` reads the tag first, then only
decodes the pubkey when `tag === 1`.

## Token-2022 extensions: the 165-byte base + TLV tail

Token-2022 pads the legacy header up to a **unified 165-byte base**
(`ACCOUNT_SIZE`, the same size a token *account* uses), then appends:

1. **AccountType** (1 byte, at offset 165): `0` Uninitialized, `1` Mint,
   `2` Account, `3` Multisig.
2. **TLV extension list** starting at offset 166. Each entry is
   `type:u16 + length:u16 + value:length`.

The detector reads these extensions because several of them are honeypot
mechanisms in disguise:

| ExtensionType | id | honeypot relevance |
|---------------|----|--------------------|
| `TransferFeeConfig` | 1 | a transfer/sell tax in bps — value leaks to the deployer |
| `TransferHook` | 14 | a program called on every transfer — can block or reroute sells |
| `PermanentDelegate` | 12 | an address that can move *any* holder's tokens unilaterally |
| `NonTransferable` | 9 | soul-bound token — buyers can never sell at all |
| `MintCloseAuthority` | 3 | an address that can close the mint and strand supply |
| `PausableConfig` | 26 | an authority that can pause transfers entirely |

(`PermanentDelegate = 12` and `TransferHook = 14` were verified against PYUSD's
live mainnet mint, whose extension list starts at offset 166.)

The detector does not hand-roll these offsets for the sub-fields — it slices the
TLV tail at 166 and decodes via the official `@solana/spl-token` helpers
(`getTransferFeeConfig`, `getTransferHook`, `getMintCloseAuthority`), so the
sell-tax bps and hook program id are verifiable on-chain values, not guesses.

## What the detector reports

`parseMint` reduces the whole thing to two renounced flags:

- `mintAuthorityRenounced = (mintAuthority === null)` → if false, the token can
  be diluted (high severity).
- `freezeAuthorityRenounced = (freezeAuthority === null)` → if false, holders
  can be frozen (high severity).

Both are objective, RPC-returned facts — never fabricated. When the account
owner is neither Token nor Token-2022, the verdict is `NOT_A_TOKEN_MINT`, and
the detector says so rather than guessing.

## Pitfalls

1. **The tag is the truth, not the bytes.** A mint with tag `0` but garbage in
   the pubkey region is still *renounced* — decoding the pubkey anyway produces
   a fake authority that never existed.
2. **`isInitialized` vs. the option tag.** A mint can be initialized yet still
   hold an active authority; initialization and authority-renounce are
   independent.
3. **Token-2022 mint is 165+ bytes, legacy is 82.** Sizing a mint by `82` will
   misread a Token-2022 mint; always branch on the account `owner` program id
   first, then parse.

---

_Cross-checked against live mainnet accounts (incl. PYUSD Token-2022 mint),
October 18 2026._
