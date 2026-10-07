# Solana Honeypot Detector

An open-source Solana token risk scanner. Input a SPL / Token-2022 mint address, get a verifiable report on whether it's safe to buy.

**Every conclusion ships with verifiable on-chain evidence. If a field can't be read, we write "unknown" — never fabricated.**

---

## What it checks (5 detection modules)

| # | Check | Question it answers |
|---|---|---|
| 1 | Sell-ability | Can you actually sell? (transfer fee / tax) |
| 2 | Honeypot | Are sells blocked? (transfer hook / freeze authority) |
| 3 | LP lock | Is liquidity locked, and is the lock still valid? |
| 4 | Authorities | Are mint / freeze authorities renounced? |
| 5 | Backdoors | Any hidden Token-2022 extensions (permanent delegate, etc.)? |

---

## Report structure: facts first, scoring second

The report is split into layers, by design:

- **FACTS** — objective on-chain data, always shown first.
- **WHITELIST** — known compliant projects (USDC, USDT, PYUSD, USDG) hit here → facts only, `score = null`. Whitelist entries carry a `proofUrl` pointing to the issuer's official mint-address page (traceable, verifiable).
- **SCORE** — subjective risk hint, only for unknown (non-whitelisted) projects.
- **UNKNOWN** — fields not yet implemented are honestly marked, never guessed.

**Philosophy:** "a technical backdoor exists" ≠ "this token is a honeypot." USDC has an active mint authority (Circle mints), PYUSD has a permanent delegate (PayPal compliance freeze). Those are legitimate powers, not scams. So we separate *facts* (objective, verifiable) from *scoring* (subjective judgment) and never score whitelisted projects.

---

## 6 technical "watersheds" (where naive scanners get it wrong)

These are the six places most simple indexers fail — and where this tool goes deeper:

1. **Exact authority offsets.** `mintAuthority` option is at offset 0 (not 4); `freezeAuthority` at offset 46 (not 50). Wrong offset → wrong "renounced" verdict.
2. **TLV start = 166, not 82.** Token-2022 extension data starts at 165-byte base + 1-byte `AccountType`. Scanners that read only the first 82 bytes miss `permanentDelegate` and other backdoors hidden in the TLV.
3. **Extension enums from the official source.** Use `@solana/spl-token` `ExtensionType` — never hand-write enum values (`PermanentDelegate=12`, `TransferHook=3`, …).
4. **Judge lock by `authority`, not `owner`.** A token account's `owner` is always the Token Program; what actually decides "who can pull LP" is the `authority` field (offset 32).
5. **Two ways to burn LP.** (a) burn to the dead address `1nc1nerator…` / `111…111`, or (b) transfer to an owner-less account (authority permanently void). Both = PERMANENT, but we label the evidence separately. Naive tools only recognize (a).
6. **Locker vault authority is a "non-existent" PDA.** UNCX / Streamflow vaults point authority at a PDA whose account doesn't exist. Tools that can't read this mislabel real locks as "unlocked."

---

## Golden-standard samples (used for validation)

| Token | Mint | Role |
|---|---|---|
| USDC (Circle) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | compliant control, must NOT false-flag |
| PYUSD (Paxos/PayPal) | `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | Token-2022 with permanentDelegate (legit) |
| USDG (Paxos) | `2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH` | Token-2022 second control |
| BONK | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` | burned LP via owner-less account |

---

## Case reports

See `reports/`:

- `reports/gold-rug-2026.md` — social-engineering rug; detector honestly reports a clean contract.
- `reports/lp-lock-expired.md` — LP locks all expired but not withdrawn → HIGH.
- `reports/bonk-permanent-lock.md` — both burn methods identified, LOW 0/10.

---

## Known limitations (honest, in-progress)

- LP pool discovery currently covers **Raydium AMM v4** only. Meteora / Orca / PumpSwap TODO.
- Social-engineering rugs (stolen accounts, coordinated exits) need **funds-flow tracking** + multi-AMM coverage — TODO.
- Timed-lock "exact unlock + whether already past" is read for UNCX / Streamflow; other lockers TODO.

---

## Run

TypeScript + `@solana/web3.js` + `@solana/spl-token`. Pure RPC reads — no contract deployment required.

```bash
npm install
node src/index.js <MINT_ADDRESS>
```

RPC endpoint is configurable (Helius free tier, mainnet).
