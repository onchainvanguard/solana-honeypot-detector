# Detection Logic — 5 modules (text spec)

> The reference spec for `src/detect.js`. Pure RPC reads via `@solana/web3.js` + `@solana/spl-token`. No contract deployment.

## 1. Can you sell? (transfer fee / tax)

- Read the Token-2022 `TransferFeeConfig` extension (decode via official `getTransferFeeConfig`).
- Extract `transferFeeBasisPoints` (bps). Also check for a "future scheduled tax rate" (currently 0% but a high rate that activates at a future epoch).
- Thresholds: `≥10%` → CRITICAL, `≥5%` → HIGH, `>0` → MEDIUM.

## 2. Honeypot? (sell restrictions)

- Check `TransferHook` / `TransferHookAccount` extensions — is there a hook program that can intercept / block sells?
- Combined with whether `freezeAuthority` is still active (freeze can lock holders' assets = honeypot).

## 3. LP locked? (liquidity lock)

- Discover Raydium AMM v4 pool: `getProgramAccounts` + `dataSize=752` + `memcmp` (targeted search by mint, not full scan).
- Read the LP largest-holder token account's `authority` (offset 32).
- Three-tier verdict: **permanent** (burned to dead address / owner-less account) · **timed** (UNCX/Streamflow locker → then read exact unlock timestamp) · **unlocked** (ordinary wallet).

## 4. Authorities renounced? (mint / freeze)

- Read mint account `mintAuthorityOption` (offset 0) and `freezeAuthorityOption` (offset 46) — renounced or not.
- For Token-2022, also scan TLV for `PermanentDelegate` (extension type 12, from offset 166).

## 5. Backdoors? (dangerous extensions)

- Iterate Token-2022 TLV extension list; identify dangerous extensions: `PermanentDelegate` (can mint/burn at will), `TransferHook` (can intercept transfers), `InterestBearingConfig`, etc. List each one.

---

## Whitelist (facts-only, no score)

`src/whitelist.js` holds entries with four fields: `mint / issuer / symbol / proofUrl` (proofUrl → issuer's official mint-address page, traceable). Hit → facts only, `score = null`.
