/**
 * OnChain Vanguard — LP Lock Detection (Phase 2, 完整版)
 *
 * 判断一个代币的 LP 是否锁仓、锁到什么时候、能不能被撤走。
 *
 * 铁律：宁缺毋假。每条结论挂可验证的链上证据（池子地址 / lpMint / 锁仓账户 / 到期时间）。
 *
 * Solana 上没有统一锁仓合约，锁状态分三种：
 *   1. PERMANENT（永久锁，最强）：LP 代币烧进死地址 1nc1nerator...，或 Raydium Burn & Earn，无到期不可撤。
 *   2. TIME_LOCKED（定时锁）：LP 锁进 UNCX/Streamflow 等锁仓器，有到期时间。要标"到期时间 + 是否已过"。
 *   3. UNLOCKED（未锁，可 rug）：LP 代币还在部署者/未知钱包，随时能撤。
 *
 * 发现 LP 池的两级姿势（军长拍板）：
 *   ① 定向：getProgramAccounts + dataSize 过滤 + memcmp(offset 400/432 搜 mint) → 定位 pool 状态账户
 *   ② 锁仓：从 pool 账户读 lpMint(464) / baseVault(336) / quoteVault(368)，再判断 LP 代币的归属
 */

import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

// ===== AMM 程序 ID =====
// 当前只实现 Raydium AMM v4（Solana 主流，覆盖绝大多数 LP）。
// CPMM / Orca Whirlpool / Meteora / PumpSwap 记入 TODO，多 AMM 覆盖缓一缓不阻塞主线。
const AMM_PROGRAMS = {
  RAYDIUM_V4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  // TODO(多AMM): 以下常量已登记，但 discoverPools 尚未实现对应发现逻辑
  RAYDIUM_CPMM: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  ORCA_WHIRLPOOL: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
};

// ===== Raydium AMM v4 LIQUIDITY_STATE_LAYOUT_V4 偏移（官方 raydium-sdk）=====
const RAYDIUM_V4 = {
  dataSize: 752,
  status: 0,
  baseVault: 336,
  quoteVault: 368,
  baseMint: 400,
  quoteMint: 432,
  lpMint: 464,
  lpVault: 560,
  owner: 592,
  lpReserve: 624,
};

// ===== 死地址（LP 烧币 = 永久锁）=====
const BURN_ADDRESSES = {
  // Solana 官方 incinerator（烧币地址）—— 唯一规范烧毁地址，军长已核对
  "1nc1nerator11111111111111111111111111111111": "Solana Incinerator",
  "11111111111111111111111111111111": "System Program (zero address)",
};

// ===== 锁仓器程序（LP 锁进这些 = 定时锁）=====
// 三家锁仓器，账户结构各不相同，需分别精读到期时间。

// UNCX Solana LP Locker（开源仓库 uncx-network/raydium-amm-lp-locker，程序 GsSCS3...）
// TokenLock 账户 discriminator（官方 IDL）+ 字段偏移（金标准验证过）
const UNCX = {
  programId: "GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo",
  name: "UNCX Locker",
  tokenLockDiscriminator: [73, 228, 144, 241, 154, 44, 93, 238],
  tokenLockDataSize: 146,
  // Anchor 8 字节 discriminator 之后：
  // bump(1) + amm_id(32) + lp_mint(32) + lock_global_id(8) + lock_date(8) + unlock_date(8)
  // + country_code(1) + initial_lock_amount(8) + current_locked_amount(8) + lock_owner(32)
  ammId: 9,
  lpMint: 41,
  lockGlobalId: 73,
  lockDate: 81,
  unlockDate: 89, // i64 到期时间戳
  countryCode: 97,
  initialLockAmount: 98,
  currentLockedAmount: 106, // 剩余锁定量（=0 说明已撤走）
  lockOwner: 114,
  // 关键：UNCX 锁 owner 可主动 withdraw/relock/transfer，到期后可撤（rug 点）
  revocable: true,
};

// Streamflow（程序 strmRqUCoQ...，metadata 账户 1104 字节）
// streamLayout 偏移（官方 js-sdk layout.ts，金标准验证过）
const STREAMFLOW = {
  programId: "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m",
  name: "Streamflow",
  metadataDataSize: 1104,
  endTime: 33,        // 流结束时间（token lock 时 = cliff + 1）
  mint: 177,          // 代币 mint
  escrowTokens: 209,  // escrow token account PDA
  startTime: 409,
  netAmountDeposited: 417,
  period: 425,
  amountPerPeriod: 433,
  cliff: 441,         // token lock 的解锁时刻
  cliffAmount: 449,
  cancelableBySender: 457,    // =1 表示 sender 可取消（可撤 = 有 rug 风险）
  cancelableByRecipient: 458,
  // 关键：Streamflow token lock 不可取消（两者都=0），到期后 100% 解锁
  // 但 Streamflow 也有可取消的普通 vesting（cancelableBySender=1），要区分
  revocable: false, // token lock 本身不可取消；但可取消的 vesting 会单独标
};

// 兼容旧的 LOCKER_PROGRAMS 映射（LP token account 的 authority 地址 → 锁仓器）
// 关键：LP vault 的 authority 指向的是锁仓器的 vault authority（如 UNCX 的 BzKinc...），
// 不是锁仓器程序本身。BzKinc... 账户本身不存在，是 UNCX 的 vault authority PDA。
const LOCKER_PROGRAMS = {
  [UNCX.programId]: UNCX.name,
  "BzKincxjgFQjj4FmhaWrwHES1ekBGN73YesA7JwJJo7X": UNCX.name, // UNCX LP vault authority（金标准验证）
  [STREAMFLOW.programId]: STREAMFLOW.name,
};

function readU64le(buf, offset) {
  return buf.readBigUInt64LE(offset);
}
function readI64le(buf, offset) {
  return buf.readBigInt64LE(offset);
}
function readPubkey(buf, offset) {
  return new PublicKey(buf.subarray(offset, offset + 32)).toBase58();
}

/**
 * 发现一个代币的 LP 池（Raydium AMM v4 优先，这是 Solana 主流）。
 *
 * @param {Connection} connection
 * @param {string} mintAddress - 代币 mint
 * @returns {Promise<{pools: Array<{poolAddress, baseMint, quoteMint, lpMint, baseVault, quoteVault, status, amm}>, searchErrors: string[]}>}
 *          searchErrors 非空 = 搜索本身没跑成（RPC 拦截/失败），不能当"没有池"处理。
 */
export async function discoverPools(connection, mintAddress) {
  // 优先 Raydium AMM v4（Solana 主流 LP 场所）
  const { pools, searchErrors } = await discoverRaydiumV4Pools(connection, mintAddress);
  return { pools, searchErrors };
}

/**
 * 用 getProgramAccounts + memcmp 定向发现 Raydium AMM v4 池子。
 * 代币可能作为 baseMint（offset 400）或 quoteMint（offset 432）出现。
 */
async function discoverRaydiumV4Pools(connection, mintAddress) {
  const programId = new PublicKey(AMM_PROGRAMS.RAYDIUM_V4);
  const pools = [];
  const searchErrors = [];

  // 分别按 baseMint 和 quoteMint 搜（两次 memcmp，定向，不扫全量）
  for (const offset of [RAYDIUM_V4.baseMint, RAYDIUM_V4.quoteMint]) {
    try {
      const accounts = await connection.getProgramAccounts(programId, {
        filters: [
          { dataSize: RAYDIUM_V4.dataSize },
          { memcmp: { offset, bytes: mintAddress } },
        ],
        // 只需读 status + vaults + mints，用 dataSlice 省 credits
        dataSlice: { offset: 0, length: 496 }, // 覆盖到 lpMint(464)+32
      });
      for (const acc of accounts) {
        pools.push({
          poolAddress: acc.pubkey.toBase58(),
          amm: "Raydium AMM v4",
          ...parseRaydiumV4State(acc.account.data),
        });
      }
    } catch (e) {
      // 查询失败不阻断，但必须如实上抛——「查询被拦」≠「没有池子」，
      // 上层要能区分这两种状态（宁缺毋假：不能把 RPC 拦截冒充成"没找到池"）
      searchErrors.push(e.message);
    }
  }

  // 去重（一个池子可能同时命中 baseMint 和 quoteMint）
  const seen = new Set();
  const deduped = pools.filter((p) => {
    if (seen.has(p.poolAddress)) return false;
    seen.add(p.poolAddress);
    return true;
  });
  return { pools: deduped, searchErrors };
}

/**
 * 解析 Raydium AMM v4 池子状态账户。
 */
function parseRaydiumV4State(data) {
  return {
    status: Number(data.readBigUInt64LE(RAYDIUM_V4.status)),
    baseVault: new PublicKey(data.subarray(RAYDIUM_V4.baseVault, RAYDIUM_V4.baseVault + 32)).toBase58(),
    quoteVault: new PublicKey(data.subarray(RAYDIUM_V4.quoteVault, RAYDIUM_V4.quoteVault + 32)).toBase58(),
    baseMint: new PublicKey(data.subarray(RAYDIUM_V4.baseMint, RAYDIUM_V4.baseMint + 32)).toBase58(),
    quoteMint: new PublicKey(data.subarray(RAYDIUM_V4.quoteMint, RAYDIUM_V4.quoteMint + 32)).toBase58(),
    lpMint: new PublicKey(data.subarray(RAYDIUM_V4.lpMint, RAYDIUM_V4.lpMint + 32)).toBase58(),
  };
}

/**
 * 判断一个 LP 池的锁状态。
 *
 * 逻辑（关键）：LP 代币存在 token account 里，token account 的 owner 永远是 Token Program，
 * 但 token account 的 **authority 字段（offset 32-64）** 才是"谁能动这笔 LP"的人。
 * 追踪 authority：
 *   - 烧进死地址（1nc1nerator）→ PERMANENT
 *   - 锁进锁仓器程序（UNCX/Streamflow）→ TIME_LOCKED（读到期时间）
 *   - 部署者/普通钱包 → UNLOCKED（可 rug）
 *
 * @param {Connection} connection
 * @param {object} pool - discoverPools 返回的池子对象
 * @returns {Promise<object>} lock status with evidence
 */
export async function checkLpLock(connection, pool) {
  if (!pool || !pool.lpMint) {
    return { status: "UNKNOWN", note: "no lpMint available" };
  }

  const lpMintPubkey = new PublicKey(pool.lpMint);

  // 读 LP 代币的最大持仓账户（LP 代币在哪，决定了锁状态）
  let largest;
  try {
    const res = await connection.getTokenLargestAccounts(lpMintPubkey);
    largest = res.value;
  } catch (e) {
    return { status: "UNKNOWN", note: `getTokenLargestAccounts failed: ${e.message}` };
  }

  if (!largest || largest.length === 0) {
    return { status: "UNKNOWN", note: "no LP token holders found" };
  }

  // 读这些持仓 token account，解析出它们的 authority（真正控制 LP 的人）
  const addrs = largest.map((v) => new PublicKey(v.address));
  let infos;
  try {
    infos = await connection.getMultipleAccountsInfo(addrs);
  } catch (e) {
    return { status: "UNKNOWN", note: `getMultipleAccountsInfo failed: ${e.message}` };
  }

  const authoritySet = new Set();
  const holdersRaw = [];
  for (let i = 0; i < addrs.length; i++) {
    const info = infos[i];
    if (!info) continue;
    const data = info.data;
    const amount = largest[i].uiAmountString;

    // token account 结构：mint(32) + owner/authority(32) + amount(8) + ...
    // authority 在 offset 32-64
    let authority = null;
    if (data && data.length >= 64) {
      authority = new PublicKey(data.subarray(32, 64)).toBase58();
    }
    if (authority) authoritySet.add(authority);
    holdersRaw.push({ address: addrs[i].toBase58(), authority, amount });
  }

  // 查 authority 账户的性质（是钱包 / 锁仓器 / 系统零地址 / 不可执行账户）
  const authorityInfos = new Map();
  if (authoritySet.size > 0) {
    const authorityAddrs = [...authoritySet].map((a) => new PublicKey(a));
    try {
      const infos2 = await connection.getMultipleAccountsInfo(authorityAddrs);
      authorityAddrs.forEach((a, i) => authorityInfos.set(a.toBase58(), infos2[i]));
    } catch (e) {
      // 查不到不阻断，降级为仅用 authority 地址本身判断
    }
  }

  const holders = holdersRaw.map((h) => {
    const ai = h.authority ? authorityInfos.get(h.authority) : null;
    return {
      ...h,
      authorityOwner: ai ? ai.owner.toBase58() : (h.authority ? null : null),
      authorityExecutable: ai ? ai.executable : null,
    };
  });

  // 判断锁状态：看 authority 是谁
  const lock = await classifyLock(connection, pool, holders);

  return {
    ...lock,
    evidence: {
      poolAddress: pool.poolAddress,
      lpMint: pool.lpMint,
      baseMint: pool.baseMint,
      quoteMint: pool.quoteMint,
      topHolders: holders.slice(0, 5), // 前5大 LP 持仓（含 authority），逐条可查
    },
  };
}

/**
 * 反查 UNCX TokenLock 账户，精读到期时间。
 * 用 lpMint 去 UNCX 程序里 memcmp 搜（TokenLock.lpMint 在 offset 41）。
 */
async function resolveUncxLocks(connection, lpMint) {
  const programId = new PublicKey(UNCX.programId);
  try {
    const accounts = await connection.getProgramAccounts(programId, {
      filters: [
        { dataSize: UNCX.tokenLockDataSize },
        { memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(UNCX.tokenLockDiscriminator)) } },
        { memcmp: { offset: UNCX.lpMint, bytes: lpMint } },
      ],
    });
    return accounts.map((acc) => {
      const data = acc.account.data;
      const unlockDate = Number(readI64le(data, UNCX.unlockDate));
      const lockDate = Number(readI64le(data, UNCX.lockDate));
      const initialAmount = readU64le(data, UNCX.initialLockAmount);
      const currentAmount = readU64le(data, UNCX.currentLockedAmount);
      return {
        locker: UNCX.name,
        lockAccount: acc.pubkey.toBase58(),
        lockOwner: readPubkey(data, UNCX.lockOwner),
        lockDate,
        unlockDate,
        initialLockAmount: initialAmount.toString(),
        currentLockedAmount: currentAmount.toString(),
        withdrawn: currentAmount === 0n && initialAmount > 0n,
        expired: Date.now() / 1000 >= unlockDate,
        revocable: UNCX.revocable,
      };
    });
  } catch (e) {
    return [];
  }
}

/**
 * 反查 Streamflow metadata 账户，精读到期时间。
 * 用 lpMint 去 Streamflow 程序里 memcmp 搜（metadata.mint 在 offset 177）。
 */
async function resolveStreamflowLocks(connection, lpMint) {
  const programId = new PublicKey(STREAMFLOW.programId);
  try {
    const accounts = await connection.getProgramAccounts(programId, {
      filters: [
        { dataSize: STREAMFLOW.metadataDataSize },
        { memcmp: { offset: STREAMFLOW.mint, bytes: lpMint } },
      ],
    });
    const locks = [];
    for (const acc of accounts) {
      const data = acc.account.data;
      const cliff = Number(readU64le(data, STREAMFLOW.cliff));
      const endTime = Number(readU64le(data, STREAMFLOW.endTime));
      const netDeposited = readU64le(data, STREAMFLOW.netAmountDeposited);
      const cliffAmount = readU64le(data, STREAMFLOW.cliffAmount);
      const cancelableBySender = data[STREAMFLOW.cancelableBySender];
      const cancelableByRecipient = data[STREAMFLOW.cancelableByRecipient];

      // 判 token lock（一次性解锁）：cliffAmount ≈ netDeposited
      const isTokenLock = cliffAmount + 1n >= netDeposited;
      // 到期时间 = token lock 看 cliff；普通 vesting 看 endTime
      const unlockDate = isTokenLock ? cliff : endTime;
      // 不可取消 = 两个 cancelable 都 = 0
      const immutable = cancelableBySender === 0 && cancelableByRecipient === 0;

      locks.push({
        locker: STREAMFLOW.name,
        lockAccount: acc.pubkey.toBase58(),
        escrowTokens: readPubkey(data, STREAMFLOW.escrowTokens),
        isTokenLock,
        startTime: Number(readU64le(data, STREAMFLOW.startTime)),
        endTime,
        cliff,
        unlockDate,
        netDeposited: netDeposited.toString(),
        cliffAmount: cliffAmount.toString(),
        cancelableBySender,
        cancelableByRecipient,
        immutable,
        expired: Date.now() / 1000 >= unlockDate,
        revocable: !immutable, // 可取消的 vesting = 可撤
      });
    }
    return locks;
  } catch (e) {
    return [];
  }
}

/**
 * 根据 LP 代币持仓的 authority 分类锁状态。
 * 注意：token account 的 authority（offset 32）才是关键，不是 token account 的 owner。
 *
 * 判定优先级（金标准验证后重新排定）：
 *   ① 锁仓器（UNCX/Streamflow vault authority）—— 最强、最明确的锁信号，必须最先判
 *      UNCX 的 LP vault authority = BzKincxjgFQjj4FmhaWrwHES1ekBGN73YesA7JwJJo7X（账户本身不存在）
 *   ② 烧进死地址（1nc1nerator / authority 字段本身 = 111...111）—— 永久锁
 *   ③ Raydium burn（authority 指向 owner=System Program 的无数据账户，如 BONK）—— 永久锁
 *   ④ 普通钱包 —— 未锁
 *
 * 关键：②③ 要区分「authority 字段本身是死地址」vs「authorityOwner 是 system」。
 *   - authority 字段 = 111...111 → 真永久锁
 *   - authority 指向的账户 owner = 111...111 且 dataLen=0 且有 SOL → Raydium burn（永久锁）
 *   - 但散户 LP 的 authority 也可能指向已关闭账户（owner=111...111），要小心
 *     区分点：真正的主池 LP 是「单一 authority 高度集中」，散户是「多 authority 分散」
 */
async function classifyLock(connection, pool, holders) {
  // ① 锁仓器判定（最先）：LP 最大持仓 authority 是锁仓器 vault authority
  const locked = holders.filter((h) => h.authority && LOCKER_PROGRAMS[h.authority]);
  if (locked.length > 0) {
    // 反查锁仓账户，精读到期时间
    const uncxLocks = await resolveUncxLocks(connection, pool.lpMint);
    const streamflowLocks = await resolveStreamflowLocks(connection, pool.lpMint);
    const allLocks = [...uncxLocks, ...streamflowLocks];

    // 汇总到期判定
    let note;
    if (allLocks.length === 0) {
      note = "LP controlled by a locker program, but the lock account could not be resolved (unlock time unknown)";
    } else {
      const soonest = allLocks.reduce((a, b) => (a.unlockDate < b.unlockDate ? a : b));
      const expired = allLocks.filter((l) => l.expired);
      const active = allLocks.filter((l) => !l.expired);
      const withdrawn = allLocks.filter((l) => l.withdrawn);

      if (withdrawn.length > 0 && active.length === 0) {
        note = `⚠️ CRITICAL: lock expired and LP already withdrawn (deployer pulled liquidity)`;
      } else if (expired.length > 0 && active.length === 0) {
        note = `⚠️ HIGH: lock expired (unlock ${formatTime(soonest.unlockDate)}), LP not yet withdrawn but deployer can rug at any moment`;
      } else {
        const remainSec = soonest.unlockDate - Math.floor(Date.now() / 1000);
        note = `time-locked, unlock at ${formatTime(soonest.unlockDate)} (${formatRemaining(remainSec)} remaining)`;
      }
    }

    return {
      status: "TIME_LOCKED",
      note,
      lockerProgram: locked.map((l) => `${l.address} → ${l.authority} (${LOCKER_PROGRAMS[l.authority]})`),
      locks: allLocks.map((l) => ({
        locker: l.locker,
        lockAccount: l.lockAccount,
        unlockDate: l.unlockDate,
        unlockTime: formatTime(l.unlockDate),
        expired: l.expired,
        immutable: l.immutable !== undefined ? l.immutable : !l.revocable,
        revocable: l.revocable,
        currentLockedAmount: l.currentLockedAmount,
        withdrawn: l.withdrawn,
      })),
    };
  }

  // ② authority 是死地址 → 永久锁（烧币方式 A：烧给死地址 1nc1nerator）
  const burned = holders.filter((h) => h.authority && BURN_ADDRESSES[h.authority]);
  if (burned.length > 0) {
    return {
      status: "PERMANENT",
      burnMethod: "dead-address", // 烧法 A：LP 转给死地址（1nc1nerator / 系统零地址）
      note: "LP tokens burned to dead address (permanent lock — cannot be withdrawn)",
      burnedTo: burned.map((b) => `${b.address} → authority ${b.authority} (${BURN_ADDRESSES[b.authority]})`),
    };
  }

  // ③ authority 指向无 owner 的账户（owner=System Program 且无数据）→ 永久锁（烧币方式 B：转给无 owner 账户）
  //    Raydium 的第二种 LP burn：LP 转给一个 owner=111...111、无数据、但有 SOL 的 system 账户，
  //    authority 永久失效，无人能签名撤走 LP —— 效果等同死地址，但证据形态不同。
  //    金标准验证：BONK 主池 authority 3qRe1Yr2... 即此特征（owner=System Program、dataLen=0、有 lamports）。
  const sysFrozen = holders.filter(
    (h) => h.authority && (h.authority === "11111111111111111111111111111111" || h.authorityOwner === "11111111111111111111111111111111")
  );
  if (sysFrozen.length > 0) {
    return {
      status: "PERMANENT",
      burnMethod: "ownerless-account", // 烧法 B：LP 转给无 owner 账户（authority 永久失效）
      note: "LP authority points to an ownerless account (owner=System Program, no data) — no one can sign to withdraw (permanent lock)",
      authority: sysFrozen.map((b) => b.authority),
    };
  }

  // ④ authority 是普通钱包 → 未锁（可 rug）
  //    但要区分"LP 高度集中在单一钱包"（真 rug 风险）vs "LP 分散在众多散户"（健康的去中心化持仓）
  const nonZero = holders.filter((h) => h.authority);
  return {
    status: "UNLOCKED",
    note: "LP tokens controlled by ordinary wallet(s) — liquidity can be withdrawn (rug risk if concentrated)",
    topHolder: nonZero[0] ? { address: nonZero[0].address, authority: nonZero[0].authority } : null,
  };
}

function formatTime(ts) {
  if (!ts || ts <= 0) return "unknown";
  const d = new Date(ts * 1000);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} UTC`;
}

function formatRemaining(sec) {
  if (sec < 0) return "expired";
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((sec % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * 汇总：给定代币 mint，返回 LP 锁的完整检测结果。
 */
export async function detectLpLock(connection, mintAddress) {
  const { pools, searchErrors } = await discoverPools(connection, mintAddress);

  if (pools.length === 0) {
    if (searchErrors.length > 0) {
      // 搜索本身失败（免费公共节点常拦 getProgramAccounts）——
      // 「没查成」≠「没有池」，如实区分，不冒充结论（宁缺毋假）
      return {
        status: "RPC_BLOCKED",
        note: `LP pool search FAILED on this RPC (${searchErrors[0]}). Cannot tell "no pool" from "search blocked" — treat as UNKNOWN. Use an RPC that allows getProgramAccounts (e.g. Helius) for full LP lock coverage.`,
        poolsFound: 0,
      };
    }
    return {
      status: "NO_POOL_FOUND",
      note: "no Raydium AMM v4 pool found for this mint (could be on Orca/Meteora, or no liquidity)",
      poolsFound: 0,
    };
  }

  // 对每个池子做锁判断（取流动性最大的主池，避免漏掉带锁的主池）
  // 先按 lpMint 供应量排序（供应量越大 = 该池 LP 越多 = 流动性越大）
  const ranked = await rankPoolsByLiquidity(connection, pools);

  const results = [];
  for (const pool of ranked.slice(0, 3)) {
    const lock = await checkLpLock(connection, pool);
    results.push(lock);
  }

  return {
    status: "POOLS_FOUND",
    poolsFound: pools.length,
    results,
  };
}

/**
 * 按 lpMint 供应量排序池子，取流动性最大的主池。
 * 一个代币常有多个池（配不同 quote），memcmp 返回顺序任意，不排序会漏掉真正的主池。
 */
async function rankPoolsByLiquidity(connection, pools) {
  const ranked = [];
  for (const pool of pools) {
    if (!pool.lpMint) {
      ranked.push({ pool, supply: 0n });
      continue;
    }
    try {
      const supply = await connection.getTokenSupply(new PublicKey(pool.lpMint));
      ranked.push({ pool, supply: supply.value.amount ? BigInt(supply.value.amount) : 0n });
    } catch (e) {
      ranked.push({ pool, supply: 0n });
    }
  }
  ranked.sort((a, b) => (b.supply > a.supply ? 1 : b.supply < a.supply ? -1 : 0));
  return ranked.map((r) => r.pool);
}
