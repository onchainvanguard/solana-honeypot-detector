# Whitelist short-circuit and false-positive control in a honeypot detector

A honeypot detector that naively flags every active `freezeAuthority` will
misreport the entire stablecoin surface. USDC, USDT, PYUSD and USDG all carry a
live freeze authority — it is how Circle/Tether/Paxos freeze sanctioned or
stolen addresses, a compliance feature rather than a rug vector. This note
documents how the detector keeps that signal from turning into false positives,
and the RPC economics that force the decision to be made *before* the LP-lock
scan.

## Why a naive "freeze = honeypot" rule fails

The detector's mint report treats an active `freezeAuthority` as a sell-blocker:
the holder's token account can be frozen, so they cannot always sell. That is
true for a random memecoin and false-for-the-reason-that-matters for a
compliant stablecoin:

- Circle's USDC freeze authority is the on-chain mechanism behind sanctioned-
  address freezes. It is *expected* to be live; its absence would be the
  anomaly.
- A stablecoin also has hundreds of live pools (Raydium / Orca / Meteora /
  PumpSwap). Scanning them all to answer "is the LP locked" is correct work for
  a launch-day token, and pure RPC waste for USDC.

The detector therefore does not *judge* the freeze authority in isolation. It
short-circuits on identity first.

## The whitelist: identity, not sentiment

`src/whitelist.js` holds a small compliance list. Each entry is a fact with a
verifiable reference, never a subjective call:

```
{
  mint:     "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // exact-match mint
  issuer:   "Circle",
  symbol:   "USDC",
  proofUrl: "https://www.circle.com/en/multi-chain-usdc",     // issuer's official mint-address page
}
```

Three rules govern the list:

1. **Exact mint match.** Lookup is `mint === mintAddress`, never a symbol or
   substring match. A fake "USDC" with a different mint does not match.
2. **Every entry carries a proof URL** — the issuer's own mint-address page. The
   reference is shown in the report so the listing is auditable, not asserted.
3. **Under-list over mis-list.** The header comment states the policy plainly:
   prefer an empty list to a fabricated one. A token that is not listed simply
   gets the full scan; nothing is waved through on a guess.

## Where the short-circuit fires

The whitelist check runs **before** the LP-lock scan, in `detect.js`:

```
const whitelistEntry = lookupWhitelist(mintAddress);
if (whitelistEntry) {
  report.whitelist = whitelistEntry;
  report.facts.lpLock = {
    status: "WHITELISTED",
    note: "compliance-whitelisted token — LP lock scan skipped, not risk-scored.",
  };
  return report;   // facts only, no score
}
```

Three things happen on a hit, all deliberate:

- **Pass-through, not "safe".** The report says `WHITELISTED`, not `SAFE`. The
  detector does not vouch for a token; it declines to spend a risk score on a
  known-compliance identity.
- **No score.** Scoring (`canSell` / `honeypot` / `backdoors` / `lpLock`) applies
  only to unknown projects. A whitelist hit returns facts and stops.
- **No LP scan.** The hundreds of USDC pools are never enumerated. This is the
  RPC win: the compliance path dropped from ~3 minutes to ~0.9 seconds in local
  testing, because the dominant cost was the multi-AMM pool discovery, not the
  mint parse.

## The ordering is the point

The short-circuit has to come *first*. If the mint parse and freeze-authority
analysis ran before the whitelist check, the detector would have already
assembled a `freeze authority is set` sell-blocker for USDC and only then
discovered the token is whitelisted — forcing a contradictory report. Putting
identity first means the freeze-authority logic never sees a compliant token,
so the two signals cannot collide.

## Why this matters for grant-grade detection

A detector that reports false positives on the largest stablecoins is not a
security product; it is noise. The whitelist is not a special-case hack — it is
the acknowledgement that *identity* and *behavior* are different questions.
Compliance tokens are identified, then exempted from behavioral scoring; unknown
tokens get the full freeze/delegate/hook/LP-lock analysis. Keeping those two
paths separate is what lets the behavioral rules stay aggressive without
misreporting USDC.

---

_Cross-checked against the detector source (`whitelist.js`, `detect.js`),
October 20 2026._
