# Anchor discriminators and account-type confusion

The 8-byte prefix on a Solana account is both the fastest way to identify a
struct and, when a program skips checking it, the fastest way to get owned.

## The 8-byte prefix

Anchor reserves the first 8 bytes of an account for a discriminator derived
from the struct name:

```
sha256("account:" + StructName)[..8]
```

The namespace matters: accounts use `"account:"`, instructions use `"global:"`.
A note that says account discriminators come from `"global:"` has the two
namespaces mixed up.

Values verified against mainnet account data:

| struct | program | discriminator (hex) |
|---|---|---|
| `Pool` | PumpSwap (`pAMMBay6…`) | `f19a6d0411b16dbc` |
| `Pool` | Meteora DAMM v1 (`Eo7WjKq…`) | `f19a6d0411b16dbc` |
| `LockEscrow` | Meteora DAMM v1 | `be6a7906c8b6154b` |
| `LbPair` | Meteora DLMM (`LBUZKhRx…`) | `210b3162b565b10d` |
| `Whirlpool` | Orca (`whirLbMii…`) | `3f95d10ce1806309` |
| `Position` | Orca | `aabc8fe47a40f7d0` |
| `LockConfig` | Orca | `6a2fee9f7c0ca0c0` |

Note that DLMM lays out its accounts with bytemuck `repr(C)` (fixed offsets,
direct memory cast) rather than Anchor's borsh, yet its discriminator still
follows the `"account:"` scheme — `sha256("account:LbPair")[..8]` equals the
on-chain `210b3162b565b10d`.

## It binds to the struct NAME, not to the program

The discriminator is a function of the struct name only. Two different programs
can both call a struct `Pool`, and both get `f19a6d0411b16dbc` — PumpSwap's
`Pool` and Meteora DAMM v1's `Pool` are byte-identical. The discriminator alone
cannot tell them apart; the account owner (program ID) is the other half of the
identity.

## Account-type confusion

Three concrete surfaces:

1. **Missing check (the classic).** An instruction accepts an account but never
   verifies its prefix. The attacker passes a differently-typed account with a
   compatible layout, and the program reads attacker-controlled bytes as if
   they were the expected struct. This is the "vault_stake missing check" class
   from the Day-7 blind test.

2. **Same-name collision across programs.** The PumpSwap / DAMM-v1 `Pool` case.
   A parser that matches on the discriminator only will mis-parse a pool from
   the wrong program. Pair discriminator + owner everywhere.

3. **Prefix spoofing.** The prefix is only 8 bytes. If an attacker can get a
   writable account to begin with the target 8 bytes — via a crafted PDA with
   the right bump, or an uninitialized account the program never re-derives —
   they can hand the program a fake "correct" account type.

## Defense

- Check the discriminator on every account in every instruction. Anchor's
  `Account<Struct>` does this automatically; hand-rolled layouts must do it
  manually, before any field is read.
- At parse time and across programs, verify `owner == expected program ID` in
  addition to the discriminator.
- Never use a discriminator alone to decide authority or asset identity.

## Honeypot-detector note

Pool discovery uses `getProgramAccounts` memcmp on the discriminator. Because
the discriminator collides across programs (the `Pool` case above), every
discovery call is scoped to exactly one program ID and never matches on the
discriminator globally.
