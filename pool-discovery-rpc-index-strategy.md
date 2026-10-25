# Pool Discovery and RPC Index Strategy

How the detector finds a token's liquidity pools without scanning the whole
chain. Discovery is the stage that runs before any lock-state parsing, and it
is where the free-RPC vs. indexed-RPC split shows up most sharply. Everything
here is anchored to `src/lpLock.js`.

---

## The one rule: getProgramAccounts + memcmp, never a full-chain scan

Pool discovery is a *targeted* query against each AMM program, filtering by
the token's mint bytes at a known offset. It is never a walk over all accounts
(`src/lpLock.js:13`). A full-chain scan would be both slow and, on the public
RPC tier, refused outright.

The shape of every discovery call is the same:

```
getProgramAccounts(ammProgramId, {
  filters: [
    { memcmp: { offset: <mint field>, bytes: <token mint> } },
    // optionally { dataSize: <exact> } or { memcmp: { offset: 0, bytes: <discriminator> } }
  ],
  dataSlice: { offset: 0, length: <enough for the fields we read> },
})
```

Two variants of that filter set matter, and they map to a real fork in how
reliable discovery is.

---

## Two filter strategies, and when each is right

### 1. `dataSize` + mint `memcmp` — only when the account size is stable

Raydium AMM v4 uses this (`src/lpLock.js:296-304`): `dataSize: 752` plus a mint
`memcmp` at `baseMint` (400) or `quoteMint` (432). This is safe for Raydium
because `LIQUIDITY_STATE_V4` is a fixed 752 bytes with no trailing slack.

The token can appear as either side of the pair, so **both offsets are queried**
(400 and 432), and results are de-duplicated by pool address.

### 2. Discriminator `memcmp`, no `dataSize` — when the size drifts

Two AMMs force the second strategy because their on-chain account size is not
stable enough to filter on:

- **PumpSwap** (`src/lpLock.js:54`): the `Pool` struct serializes to 287 bytes
  (279 payload + 8 discriminator) but the on-chain account measures **300 bytes
  with 13 trailing reserved bytes**. A `dataSize: 287` filter would silently
  drop every real pool. Discovery filters on the 8-byte discriminator at
  offset 0 plus the mint `memcmp` at `base_mint` (43) / `quote_mint` (75).
- **Meteora DAMM v1** (`src/lpLock.js:125`): the pool account ships in **two
  sizes, 944 (old) and 1387 (new)**, with identical core-field offsets. A
  single `dataSize` filter is wrong for one of the two generations, so
  `poolDataSize` is deliberately `null` and discovery uses the discriminator.

The general rule: **filter on the discriminator, not the size, unless the size
is provably fixed.** Reserved bytes and generation bumps are the two ways a
`dataSize` filter lies to you.

---

## Discriminator collisions do not mean ambiguity

DAMM v1 and PumpSwap both name their pool struct `Pool`, so both have the same
Anchor discriminator `sha256("account:Pool")[..8] = f19a6d0411b16dbc`
(`src/lpLock.js:120`). That is *not* a collision in practice: the two programs
have different program ids, and `getProgramAccounts` is already scoped to one
program, so the owner filter disambiguates before the discriminator is ever
compared. The discriminator only has to be unique *within* one program.

---

## The free-RPC wall: PumpSwap and the missing index

PumpSwap has **10M+ accounts**. `getProgramAccounts` with a mint `memcmp`
requires the RPC to maintain an index on `base_mint` / `quote_mint`. Most
public/free endpoints (including Helius free tier) do not, and they reject the
call — the error matches `/too many accounts|10000001|pagination/i`.

The detector treats that rejection as data, not as a crash
(`src/lpLock.js:354-365`): it returns a `poolAddress: null` result with a
`discoveryNote` that reads *"program has 10M+ accounts and this RPC has no
base_mint/quote_mint index (needs an indexed RPC) — marked unknown"*. The note
surfaces in the report's discovery warnings, and the lock verdict for PumpSwap
becomes `UNKNOWN` rather than a guess.

Switching to an indexed RPC (Triton, QuickNode, or Helius paid tiers that
maintain custom indexes) turns the same call into a single precise query — the
discovery code path is identical; only the endpoint's indexing capability
changes the outcome.

---

## Two cost controls that keep discovery cheap

1. **`dataSlice` reads only the prefix.** Raydium slices 496 bytes (enough to
   cover `lpMint` at 464 + 32); PumpSwap slices 235 (past `lp_supply` at 203).
   The RPC returns only the fields the parser needs, not the full account.
2. **Per-AMM isolation.** Discovery runs each AMM's finder through
   `Promise.allSettled` (`src/lpLock.js:254`), so one AMM failing (or being
   refused) does not take down the others. Discovery notes are collected,
   de-duplicated, and appended to the report's warnings.

---

## What this means for "宁缺毋假"

Discovery is the first place the under-list rule is enforced. When a pool
cannot be found — because the RPC lacks an index, or the account size drifted
and the filter no longer matches — the answer is `UNKNOWN`, never a guess, and
never "assume no pool". A missed pool degrades to "could not confirm LP lock",
which is the honest output. A fabricated pool would be a false fact driving a
false verdict, and that is the one failure the detector will not make.
