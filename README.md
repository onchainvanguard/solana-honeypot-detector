# Solana Honeypot Detector

On-chain risk scanner for Solana tokens. Given a token mint, it checks the
liquidity pools and authority configuration that most commonly signal a
honeypot or rug-pull, and produces a risk score.

## What it checks

- Liquidity lock status across Raydium, Orca, Meteora, and PumpSwap pools
- Mint and freeze authority (whether the team can mint more or freeze holders)
- Token-2022 extensions that can block or tax a sell (transfer fee, transfer
  hook, permanent delegate, pausable, non-transferable)

## Architecture

Three layers, separated so verdicts stay auditable:

- FACTS — raw on-chain reads only (pool state, token accounts, authorities)
- WHITELIST — known-good tokens (USDC, USDT, PYUSD, ...) are released before scoring
- SCORE — the verdict, computed from facts, never mixed with data collection

The whitelist is what keeps it from flagging compliant stablecoins.

## Usage

Set SOLANA_RPC_URL to your RPC endpoint, then:

```
SOLANA_RPC_URL=... node src/index.js <TOKEN_MINT>
```

Output is a risk score and a short report listing each fact that drove the verdict.

## Status

Verified against USDC, PYUSD, and BONK. BONK: 128 Raydium pools, all locked,
verdict LOW (0/10). Compliant stablecoins score zero false positives.
