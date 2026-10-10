# Solana Account Layout & Discriminator Notes

Notes on how Solana account data is laid out in memory and why the first 8 bytes
matter, written from building and decoding programs without an IDL framework.

## The 8-byte discriminator

Anchor-derived programs reserve the first 8 bytes of an account for a
discriminator that names the account's struct. It is the first 8 bytes of
`sha256("global:<AccountName>")`. Two structs cannot collide because their names
differ, so their discriminators differ.

A no-framework program must write this prefix itself. The convention is the same:
a fixed 8-byte constant identifying the struct, followed by the packed fields.

## Type sizes (little-endian)

| Type | Bytes |
|---|---|
| u8 / i8 / bool | 1 |
| u16 / i16 | 2 |
| u32 / i32 / f32 | 4 |
| u64 / i64 / f64 | 8 |
| u128 / i128 | 16 |
| Pubkey | 32 |
| [u8; N] | N |

All integers are little-endian and a `bool` is a single byte (0 or 1). The
runtime inserts no padding: every byte is under program control, which is also
how layout bugs get in.

## Offsets are absolute

An account's data starts at byte 0 with the discriminator, so the first struct
field begins at offset 8 and all offsets are measured from byte 0.

Example — a minimal staking program's vault state:

```
offset  size  field
0       8     discriminator
8       32    owner        (Pubkey)
40      2     fee_bps      (u16)
42      8     total_staked (u64)
```

Total account size: 50 bytes. Its stake record:

```
offset  size  field
0       8     discriminator
8       32    user         (Pubkey)
40      8     amount       (u64)
```

Total: 48 bytes. The stake record's `user` field and the vault's `owner` field
both sit at offset 8 of their own accounts — a coincidence of layout that a
careless program turns into a real vulnerability when it trusts a field on one
account to authorize actions on another.

## Reading and writing without an IDL

Decode by reading fixed-width slices at known offsets, never by searching for a
value. Reading by value is how a wrong offset silently returns garbage that
still looks plausible.

To write a field, overwrite exactly its slice and serialize the account back.
Keep the discriminator intact so the program (or an explorer) can re-identify
the account after mutation.

## Two gotchas that cost real time

1. A freshly derived PDA has zero data bytes. You cannot write a field until the
   account's data space exists, so the first write must be preceded by a
   `create_account` CPI with the PDA signing via `invoke_signed`. This is the
   difference between "the account is derived" and "the account is initialized."

2. A miscalculated offset does not panic on its own; it reads or writes the
   adjacent field. The only reliable cross-check is decoding a live account and
   asserting the result matches a known truth (a mint Pubkey, a known balance, a
   fee you just set). If a decoded Pubkey looks plausible but wrong, the offset
   is off.

## Same technique, two directions

The offset table used to decode third-party AMM accounts (see
`amm-account-offsets.md`) is the same discipline applied in reverse: read the
official IDL, sum field sizes in declaration order, then verify against a live
account. Writing a program's own layout and reading a third-party program's
layout are one skill.
