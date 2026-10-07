# Solana Honeypot Detector

OnChain Vanguard — honeypot / freeze / backdoor detection for Solana SPL tokens.

Input a token mint address, get a report where every claim is backed by verifiable on-chain evidence: pool addresses, lpMint, locker accounts, unlock timestamps. When a value can't be fetched, the report says `unknown` — it never guesses.

```bash
node src/index.js <TOKEN_MINT_ADDRESS>
```

## Why

Most "rug check" tools read a few public fields and hand them to an LLM for a risk score. On Solana that approach misfires often, because the dangerous details live in raw account bytes:

- Mint/freeze authority offsets are easy to misread (option at byte 0, pubkey at byte 4 — not 4/8).
- Token-2022 extensions live past offset 166, so tools parsing only the 82-byte base layout miss them entirely — including a permanent delegate hidden behind a "renounced" surface.
- LP custody is recorded in the token account's *authority* field (offset 32), not its owner (which is always the Token Program).

This tool reads those bytes directly and reports what is there. Nothing more, nothing less.

## Usage

```bash
# 1. install
npm install

# 2. run (works without config — falls back to the public Solana RPC)
node src/index.js EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

RPC endpoint priority: `--rpc` flag > `SOLANA_RPC_URL` env var > public fallback (`https://solana-rpc.publicnode.com`, rate-limited).

```bash
node src/index.js <MINT> --rpc "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY"
```

No API keys are hardcoded in the source. Copy `.env.example` to `.env` for a persistent local config (gitignored).

## What it checks

| # | Check             | What it reads                                                                                          |
| - | ----------------- | ------------------------------------------------------------------------------------------------------ |
| 1 | Can holders sell? | mint/freeze authority state, freeze / pausable / non-transferable flags                                |
| 2 | Honeypot signals  | transfer fees (including scheduled future rates), transfer hooks, permanent delegate                   |
| 3 | LP lock           | Raydium AMM v4 pool discovery, burn vs. time-lock vs. unlocked, unlock timestamps                      |
| 4 | Authorities       | mint/freeze authority renounced or active                                                              |
| 5 | Backdoors         | Token-2022 extensions: transfer hook / permanent delegate / pausable / non-transferable / transfer fee |

Token-2022 extensions covered, by risk: `PermanentDelegate` (12), `TransferHook` (14), `PausableConfig` (26), `NonTransferable` (9), `TransferFeeConfig` (1).

## Facts vs. scores

Every report separates verifiable facts from subjective judgment:

- **Facts** — raw on-chain values (authorities, extension list, sell-tax bps, LP vault custody, unlock timestamps). Always printed, always checkable in a block explorer.
- **Whitelist** — known-compliant tokens (USDC, PYUSD) matched by mint address, each entry carrying a public proof URL from the issuer. Whitelisted tokens get facts only, no score.
- **Score** — heuristic risk score (0–10) for tokens not on the whitelist.

The separation exists for a concrete reason: PYUSD carries permanent delegate, a transfer hook and an active mint authority — all for PayPal's compliance needs. A flat scorer flags every major stablecoin as dangerous. Ours doesn't.

## LP lock detection

Pool discovery targets Raydium AMM v4 (the dominant Solana LP venue) via `getProgramAccounts` with `memcmp` filters on base/quote mint offsets — no full-program scans.

Permanent-lock recognition covers both burn forms on Raydium:

- burn to the incinerator (`1nc1nerator...`), and
- transfer to a dataless account owned by the System Program, which permanently disables the authority.

Most tools only detect the first form. BONK's main pool is the second.

Time-locked LP is parsed at byte level for two lockers:

| Locker     | Program         | Account           | Unlock field              |
| ---------- | --------------- | ----------------- | ------------------------- |
| UNCX       | `GsSCS3vPW...`  | TokenLock (146 B) | `unlock_date` @ offset 89 |
| Streamflow | `strmRqUCoQ...` | metadata (1104 B) | `cliff` @ offset 441      |

Three states, each with a different risk:

- unexpired — re-check at the unlock date
- expired but not withdrawn — HIGH: the deployer can pull liquidity at any time
- expired and withdrawn (`current_locked_amount = 0`) — CRITICAL: the rug already happened

The middle state is the interesting one: the LP still *shows* as locked in most dashboards while being one transaction away from gone.

## Implementation notes

Details verified against live mainnet accounts, where generic tools get it wrong:

1. Mint authority: option at byte 0, pubkey at byte 4. Freeze authority: option at 46, pubkey at 50. Verified with USDC.
2. Token-2022 TLV list starts at offset 166 (165-byte unified base + 1-byte AccountType), not 82.
3. Extension type IDs follow the official `@solana/spl-token` `ExtensionType` enum — no hand-maintained tables.
4. LP custody is read from the token account authority field (offset 32), not the owner field.
5. Locker vault authorities are PDAs; the accounts don't exist on-chain. UNCX's LP vault authority (`BzKinc...`) is a program-derived address — misreading this flags a locked pool as unlocked.

## Test anchors

Each golden sample pins one detection path:

| Token    | Mint                                           | Verifies                                                    |
| -------- | ---------------------------------------------- | ----------------------------------------------------------- |
| USDC     | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | no false positive on compliant authorities                  |
| PYUSD    | `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | Token-2022 extension parsing, permanent delegate            |
| BONK     | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` | permanent LP lock via burn type B                           |
| AZGFPtx  | `AZGFPtxBRbnZtXw4hgQF4BuSmWK3EhUg8omdUA9DEL3Y` | UNCX unlock-date parsing (locked until 2035)                |
| FHea4fcm | `FHea4fcmfsQYaZV89fRrW7iSX1ngHRzqYZ92TEexnyRX` | expired-but-not-withdrawn path (3 expired UNCX Split locks) |

## Case studies

- [GOLD rug pull](reports/gold-rug-2026.md) — a social-engineering rug; the tool reports what it knows and marks the rest unknown instead of over-flagging.
- [LP lock expired, not withdrawn](reports/lp-lock-expired.md) — detectable three days before the rug.
- [BONK permanent lock](reports/bonk-permanent-lock.md) — burn type B identification.

## Known limitations

- Pool discovery covers Raydium AMM v4 only. Orca Whirlpool, Meteora and PumpSwap are not covered yet.
- Main-pool selection sorts by lpMint supply; zombie pools can interfere. Ranking by actual reserves is planned.
- Free public RPCs usually block `getProgramAccounts`, which pool discovery needs. In that case the tool reports `RPC_BLOCKED` / unknown — it does not report "no pool found". Use an RPC that allows the method (e.g. Helius free tier) for full LP coverage.
- The whitelist is intentionally small (USDC, PYUSD today; mSOL, jitoSOL and other LSTs planned). A wrong whitelist entry is worse than a short one.

## License

MIT

---

OnChain Vanguard — on-chain forensics & risk intelligence.
