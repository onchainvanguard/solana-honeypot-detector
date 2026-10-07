/**
 * OnChain Vanguard — Solana SPL Honeypot / Freeze / Backdoor Detector
 *
 * Core detection engine. Reads on-chain state via RPC only (no contract deployment).
 * Every conclusion carries verifiable evidence (RPC-returned fields / account addresses).
 * Where data is unavailable, the verdict is "unknown" — never fabricated.
 *
 * 铁律 (non-negotiable): 宁缺毋假. Every claim ships with verifiable evidence.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { getTransferFeeConfig, getTransferHook, getMintCloseAuthority } from "@solana/spl-token";
import { lookupWhitelist } from "./whitelist.js";
import { detectLpLock } from "./lpLock.js";

/**
 * Token Program IDs
 * - Token (legacy SPL): TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
 * - Token-2022:         TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
 */
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/**
 * Mint account layout (legacy SPL Token + Token-2022 share the 82-byte header)
 *   offset 0-3   : mintAuthorityOption (u32 LE, COption: 0=None, 1=Some)
 *   offset 4-35  : mintAuthority (Pubkey, 32 bytes)
 *   offset 36-43 : supply (u64 LE)
 *   offset 44    : decimals (u8)
 *   offset 45    : isInitialized (u8)
 *   offset 46-49 : freezeAuthorityOption (u32 LE, COption)
 *   offset 50-81 : freezeAuthority (Pubkey, 32 bytes)
 */
const MINT_HEADER = {
  MINT_AUTHORITY_OPTION: 0,
  MINT_AUTHORITY: 4,
  FREEZE_AUTHORITY_OPTION: 46,
  FREEZE_AUTHORITY: 50,
};

/**
 * Token-2022 ExtensionType enum (SPL official, from @solana/spl-token extensionType.js).
 * These values are FIXED by the SPL Token-2022 spec — do not reorder.
 * (PermanentDelegate = 12, TransferHook = 14 — verified against PYUSD on-chain data.)
 */
const EXTENSION_TYPES = {
  0: "Uninitialized",
  1: "TransferFeeConfig",
  2: "TransferFeeAmount",
  3: "MintCloseAuthority",
  4: "ConfidentialTransferMint",
  5: "ConfidentialTransferAccount",
  6: "DefaultAccountState",
  7: "ImmutableOwner",
  8: "MemoTransfer",
  9: "NonTransferable",
  10: "InterestBearingConfig",
  11: "CpiGuard",
  12: "PermanentDelegate",
  13: "NonTransferableAccount",
  14: "TransferHook",
  15: "TransferHookAccount",
  18: "MetadataPointer",
  19: "TokenMetadata",
  20: "GroupPointer",
  21: "TokenGroup",
  22: "GroupMemberPointer",
  23: "TokenGroupMember",
  25: "ScaledUiAmountConfig",
  26: "PausableConfig",
  27: "PausableAccount",
  28: "PermissionedBurn",
};

/**
 * Token-2022 mint layout constants.
 * Base header = 82 bytes (MINT_SIZE). Token-2022 pads mint/account/multisig
 * to a unified 165-byte base (ACCOUNT_SIZE), then appends AccountType (1 byte),
 * then the TLV extension list. Hence TLV starts at 165 + 1 = 166.
 * (Verified: PYUSD mint extensions begin at offset 166.)
 */
const TOKEN_2022_BASE_SIZE = 165; // ACCOUNT_SIZE (unified base for mint/account/multisig)
const ACCOUNT_TYPE_SIZE = 1;
const TOKEN_2022_TLV_START = TOKEN_2022_BASE_SIZE + ACCOUNT_TYPE_SIZE; // 166

/**
 * Parse a mint account's authorities and extensions.
 * @param {Buffer} data - raw account data from getAccountInfo
 * @param {string} owner - the account owner program id
 * @returns {object} parsed mint state
 */
export function parseMint(data, owner) {
  if (!data || data.length === 0) {
    return { error: "EMPTY_ACCOUNT", note: "account has no data (likely not a mint)" };
  }

  const isToken2022 = owner === TOKEN_2022_PROGRAM_ID;
  const isLegacy = owner === TOKEN_PROGRAM_ID;

  if (!isToken2022 && !isLegacy) {
    return {
      error: "NOT_A_TOKEN_MINT",
      note: `account owner is ${owner}, not a known SPL token program`,
    };
  }

  const result = {
    program: isToken2022 ? "Token-2022" : "Token (legacy SPL)",
    programId: owner,
    mintAuthority: null,
    mintAuthorityOption: null,
    freezeAuthority: null,
    freezeAuthorityOption: null,
    extensions: [],
    rawSize: data.length,
  };

  // --- mint authority (offset 0 option, offset 4 pubkey) ---
  const mintAuthOption = data.readUInt32LE(MINT_HEADER.MINT_AUTHORITY_OPTION);
  result.mintAuthorityOption = mintAuthOption;
  if (mintAuthOption === 1) {
    result.mintAuthority = new PublicKey(data.subarray(MINT_HEADER.MINT_AUTHORITY, MINT_HEADER.MINT_AUTHORITY + 32)).toBase58();
  } else {
    // option 0 => authority is null (renounced / revoked)
    result.mintAuthority = null;
  }

  // --- freeze authority (offset 46 option, offset 50 pubkey) ---
  if (data.length >= 82) {
    const freezeAuthOption = data.readUInt32LE(MINT_HEADER.FREEZE_AUTHORITY_OPTION);
    result.freezeAuthorityOption = freezeAuthOption;
    if (freezeAuthOption === 1) {
      result.freezeAuthority = new PublicKey(data.subarray(MINT_HEADER.FREEZE_AUTHORITY, MINT_HEADER.FREEZE_AUTHORITY + 32)).toBase58();
    } else {
      result.freezeAuthority = null;
    }
  } else {
    result.freezeAuthorityOption = null;
    result.freezeAuthority = null;
  }

  // --- token-2022 extensions (TLV list starts at offset 166) ---
  if (isToken2022 && data.length > TOKEN_2022_TLV_START) {
    // Verify the AccountType byte at offset 165 is Mint (=1)
    const accountType = data.readUInt8(TOKEN_2022_BASE_SIZE);
    result.accountType = accountType;
    if (accountType !== 1) {
      result.extensionParseWarning = `AccountType byte at offset ${TOKEN_2022_BASE_SIZE} is ${accountType} (expected 1=Mint)`;
    }
    result.extensions = parseToken2022Extensions(data, TOKEN_2022_TLV_START);

    // Decode extension DETAILS via official spl-token helpers (no hand-rolled offsets).
    // These give us the verifiable sub-fields: transfer fee bps, hook program, close authority.
    const tlvData = data.subarray(TOKEN_2022_TLV_START);
    result.extensionDetails = decodeExtensionDetails(tlvData);
  }

  return result;
}

/**
 * Decode Token-2022 extension sub-fields using the official @solana/spl-token helpers.
 * This is where we read the ACTUAL sell-tax bps (transfer fee), the hook program id,
 * and the mint close authority — all verifiable on-chain values.
 *
 * @param {Buffer} tlvData - the TLV extension list (data.slice(166))
 * @returns {object} decoded extension details
 */
function decodeExtensionDetails(tlvData) {
  const details = {};

  // --- Transfer fee (sell tax) ---
  // olderTransferFee = currently active fee; newerTransferFee = a FUTURE fee that
  // activates at `epoch`. A project can pre-schedule a 100% tax in `newer` — a hidden rug vector.
  const feeCfg = getTransferFeeConfig({ tlvData });
  if (feeCfg) {
    details.transferFee = {
      authority: feeCfg.transferFeeConfigAuthority?.toBase58() ?? null,
      currentBps: feeCfg.olderTransferFee.transferFeeBasisPoints,
      currentMaxFee: feeCfg.olderTransferFee.maximumFee.toString(),
      futureBps: feeCfg.newerTransferFee.transferFeeBasisPoints,
      futureMaxFee: feeCfg.newerTransferFee.maximumFee.toString(),
      futureEpoch: feeCfg.newerTransferFee.epoch.toString(),
    };
  }

  // --- Transfer hook ---
  const hook = getTransferHook({ tlvData });
  if (hook) {
    // A hook pointing at the system program (111...111) means "not enabled".
    const ZERO = "11111111111111111111111111111111";
    details.transferHook = {
      programId: hook.programId.toBase58(),
      enabled: hook.programId.toBase58() !== ZERO,
    };
  }

  // --- Mint close authority ---
  const closeAuth = getMintCloseAuthority({ tlvData });
  if (closeAuth) {
    details.mintCloseAuthority = closeAuth.closeAuthority.toBase58();
  }

  return details;
}

/**
 * Parse Token-2022 extensions from the TLV list.
 * Each extension: type(2 LE) + length(2 LE) + data(length).
 * @param {Buffer} data - full account data
 * @param {number} start - TLV list start offset (166 for Token-2022 mint)
 * @returns {Array<{type: string, typeId: number, length: number, dataOffset: number}>}
 */
function parseToken2022Extensions(data, start) {
  const extensions = [];
  let offset = start;
  while (offset + 4 <= data.length) {
    const typeId = data.readUInt16LE(offset);
    const length = data.readUInt16LE(offset + 2);
    const typeName = EXTENSION_TYPES[typeId] || `Unknown(${typeId})`;
    // A zero-length / type-0 entry signals the end of the TLV list
    if (typeId === 0 && length === 0) break;
    extensions.push({
      type: typeName,
      typeId,
      length,
      dataOffset: offset + 4,
    });
    offset += 4 + length;
    // guard against malformed data
    if (offset > data.length) break;
  }
  return extensions;
}

/**
 * Build the honeypot risk report for a mint.
 * @param {Connection} connection
 * @param {string} mintAddress - base58 mint address
 * @returns {Promise<object>} the verifiable report
 */
export async function detect(connection, mintAddress) {
  const report = {
    input: mintAddress,
    timestamp: new Date().toISOString(),
    chain: "mainnet-beta", // default; override as needed
    whitelist: null, // null = not listed; object = known-compliance entry
    facts: {}, // 事实层：客观、可验证、链上证据
    score: null, // 评分层：主观判断，仅对未命中白名单的未知项目
    unknown: {}, // 未实现/查不到的项，如实标注
  };

  let mintPubkey;
  try {
    mintPubkey = new PublicKey(mintAddress);
  } catch (e) {
    return {
      error: "INVALID_ADDRESS",
      note: `"${mintAddress}" is not a valid base58 Solana address`,
    };
  }

  // Fetch the mint account
  const accountInfo = await connection.getAccountInfo(mintPubkey, "confirmed");

  if (!accountInfo) {
    return {
      error: "ACCOUNT_NOT_FOUND",
      note: `no account found at ${mintAddress} (does this mint exist on ${report.chain}?)`,
    };
  }

  const parsed = parseMint(accountInfo.data, accountInfo.owner.toBase58());
  if (parsed.error) {
    return { ...report, error: parsed.error, note: parsed.note };
  }

  // =========================================================
  // 事实层 (FACTS) — 客观、可验证，永远先出
  // 核心设计：不掺杂任何主观判断，逐条可上浏览器核对。
  // =========================================================
  report.facts = {
    mintAccount: {
      address: mintAddress,
      owner: accountInfo.owner.toBase58(),
      lamports: accountInfo.lamports,
      executable: accountInfo.executable,
    },
    program: parsed.program,
    programId: parsed.programId,
    mintAuthority: parsed.mintAuthority,
    mintAuthorityRenounced: parsed.mintAuthority === null,
    freezeAuthority: parsed.freezeAuthority,
    freezeAuthorityRenounced: parsed.freezeAuthority === null,
    extensions: parsed.extensions, // [{type, typeId, length}] 客观列全
    extensionDetails: parsed.extensionDetails ?? null, // 客观扩展子字段（卖税bps / hook / close authority）
    // 客观的"技术可卖性"：是否被任何机制阻止卖出（freeze/permanent delegate/non-transferable/transfer hook/pausable）
    sellBlockedBy: listSellBlockers(parsed),
    // 客观的卖税数据（转移费 bps）—— 纯事实，不判断是否"恶意"
    sellTax: {
      currentBps: parsed.extensionDetails?.transferFee?.currentBps ?? null,
      currentMaxFee: parsed.extensionDetails?.transferFee?.currentMaxFee ?? null,
      futureBps: parsed.extensionDetails?.transferFee?.futureBps ?? null,
      futureEpoch: parsed.extensionDetails?.transferFee?.futureEpoch ?? null,
      // 无 TransferFeeConfig 扩展 = 无转移费 = 0% 卖税
      noTransferFeeExtension: !parsed.extensionDetails?.transferFee,
    },
  };

  // ===== LP 锁检测（事实层：池子地址 / 锁状态 / LP 代币归属，逐条可查）=====
  // 白名单命中的合规稳定币也跑这个（USDC 的 LP 锁状态本身是客观事实），但结果不评分。
  let lpLockResult;
  try {
    lpLockResult = await detectLpLock(connection, mintAddress);
  } catch (e) {
    lpLockResult = { status: "UNKNOWN", note: `LP lock detection error: ${e.message}` };
  }
  report.facts.lpLock = lpLockResult;

  // =========================================================
  // 白名单判定 (WHITELIST) — 命中即"已知合规项目"
  // 铁律：白名单必须挂可验证依据（发行方官网公示页），宁缺毋假。
  // =========================================================
  const whitelistEntry = lookupWhitelist(mintAddress);
  if (whitelistEntry) {
    report.whitelist = whitelistEntry;
    // 命中白名单：只出事实，不给风险评分（评分层对合规项目不适用）
    return report;
  }

  // =========================================================
  // 评分层 (SCORE) — 主观判断，只对未标注的未知项目做提示
  // =========================================================
  // 评分层加入 LP 锁风险判断
  report.score = {
    canSell: analyzeCanSell(parsed),
    honeypot: analyzeHoneypot(parsed),
    authorities: analyzeAuthorities(parsed),
    backdoors: analyzeBackdoors(parsed),
    lpLock: analyzeLpLockRisk(lpLockResult),
    verdict: aggregateVerdict(parsed, lpLockResult),
  };

  // 未实现的项，如实标注 unknown（宁缺毋假）
  report.unknown = {};

  return report;
}

/**
 * 事实层：客观列出"技术上有哪些机制会阻止卖出"。
 * 不做风险判断，只陈述事实（这个 authority 是否 active、这个 extension 是否存在）。
 */
function listSellBlockers(parsed) {
  const blockers = [];
  if (parsed.freezeAuthority !== null) {
    blockers.push({ mechanism: "active_freeze_authority", authority: parsed.freezeAuthority, fact: "freeze authority is set (can freeze token accounts)" });
  }
  for (const ext of parsed.extensions) {
    if (ext.type === "PermanentDelegate") blockers.push({ mechanism: "permanent_delegate", fact: "permanent delegate extension present (can transfer/burn any holder's tokens)" });
    if (ext.type === "TransferHook") blockers.push({ mechanism: "transfer_hook", fact: "transfer hook extension present (external program runs on every transfer)" });
    if (ext.type === "PausableConfig") blockers.push({ mechanism: "pausable", fact: "pausable config present (transfers can be paused)" });
    if (ext.type === "NonTransferable") blockers.push({ mechanism: "non_transferable", fact: "non-transferable extension present (transfers disabled)" });
  }
  return blockers;
}

/**
 * Check 1: Can the average holder sell?
 */
function analyzeCanSell(parsed) {
  const hasActiveFreeze = parsed.freezeAuthority !== null;
  const hasTransferHook = parsed.extensions.some((e) => e.type === "TransferHook");
  const hasPermanentDelegate = parsed.extensions.some((e) => e.type === "PermanentDelegate");
  const isNonTransferable = parsed.extensions.some((e) => e.type === "NonTransferable");
  const hasPausable = parsed.extensions.some((e) => e.type === "PausableConfig");

  const findings = [];
  if (hasActiveFreeze) findings.push("active freeze authority (can freeze holders' token accounts)");
  if (hasPermanentDelegate) findings.push("permanent delegate (can transfer/burn anyone's tokens)");
  if (hasTransferHook) findings.push("transfer hook (external program runs on every transfer)");
  if (hasPausable) findings.push("pausable config (transfers can be paused at any time)");
  if (isNonTransferable) findings.push("non-transferable extension (transfers disabled — permanent honeypot)");

  const sellable = !hasActiveFreeze && !hasPermanentDelegate && !isNonTransferable && !hasTransferHook && !hasPausable;

  return {
    status: sellable ? "sellable" : "at-risk",
    sellable,
    findings,
    evidence: {
      freezeAuthority: parsed.freezeAuthority,
      transferHook: hasTransferHook,
      permanentDelegate: hasPermanentDelegate,
      nonTransferable: isNonTransferable,
      pausable: hasPausable,
    },
  };
}

/**
 * Check 2: Honeypot indicators
 */
function analyzeHoneypot(parsed) {
  const hasTransferFee = parsed.extensions.some((e) => e.type === "TransferFeeConfig");
  const hasTransferHook = parsed.extensions.some((e) => e.type === "TransferHook");
  const hasPermanentDelegate = parsed.extensions.some((e) => e.type === "PermanentDelegate");
  const isNonTransferable = parsed.extensions.some((e) => e.type === "NonTransferable");
  const hasPausable = parsed.extensions.some((e) => e.type === "PausableConfig");

  const honeypotSignals = [];
  // Danger priority (descending): permanentDelegate > transferHook > pausable > nonTransferable > transferFee
  if (hasPermanentDelegate) honeypotSignals.push("permanent delegate (highest-risk: can seize/burn tokens)");
  if (hasTransferHook) honeypotSignals.push("transfer hook (external program may block/tax sells)");
  if (hasPausable) honeypotSignals.push("pausable (transfers can be paused — sell freeze switch)");
  if (isNonTransferable) honeypotSignals.push("non-transferable (permanent honeypot — tokens can't move)");
  if (hasTransferFee) honeypotSignals.push("transfer fee configured (see sell-tax bps in facts)");

  // 现在能读真实 bps 了：补充客观的卖税数值（但"是否恶意"是评分层判断）
  const fee = parsed.extensionDetails?.transferFee ?? null;

  return {
    status: honeypotSignals.length > 0 ? "suspicious" : "no-obvious-signals",
    signals: honeypotSignals,
    sellTax: analyzeSellTax(fee),
    evidence: {
      transferFeeConfig: hasTransferFee,
      transferHook: hasTransferHook,
      permanentDelegate: hasPermanentDelegate,
      nonTransferable: isNonTransferable,
      pausable: hasPausable,
    },
  };
}

/**
 * 评分层：卖税风险判断。
 * 客观 bps 在事实层（facts.sellTax），这里只做"这个税率对买家意味着什么"的主观提示。
 * 阈值（主观，可调）：
 *   > 10% (1000 bps) → 高危（典型 rug 卖税）
 *   > 5%  (500 bps)  → 中危
 *   未来税率(futureBps) 若远高于当前 → 隐藏 rug 点（预设未来生效的高税）
 */
export function analyzeSellTax(fee) {
  if (!fee) {
    return {
      status: "no-transfer-fee",
      currentPercent: "0%",
      note: "无 TransferFeeConfig 扩展，技术上无转移费（0% 卖税）。",
    };
  }

  const currentBps = fee.currentBps;
  const futureBps = fee.futureBps;
  const currentPercent = (currentBps / 100).toFixed(2) + "%";
  const futurePercent = (futureBps / 100).toFixed(2) + "%";

  let level = "LOW";
  let note = `当前卖税 ${currentPercent}（${currentBps} bps）。`;
  if (currentBps >= 1000) {
    level = "CRITICAL";
    note = `当前卖税 ${currentPercent}（${currentBps} bps）—— 典型 rug 税率，卖出即被抽干。`;
  } else if (currentBps >= 500) {
    level = "HIGH";
    note = `当前卖税 ${currentPercent}（${currentBps} bps）—— 偏高，警惕。`;
  } else if (currentBps > 0) {
    level = "MEDIUM";
    note = `当前卖税 ${currentPercent}（${currentBps} bps）。`;
  }

  // 隐藏 rug 点：预设了未来才生效的更高税率
  if (futureBps > currentBps) {
    level = level === "LOW" ? "MEDIUM" : level;
    note += ` ⚠️ 未来税率预设 ${futurePercent}（epoch ${fee.futureEpoch} 生效），可能是一个隐藏的高税开关。`;
  }

  return {
    status: level,
    currentBps,
    currentPercent,
    futureBps,
    futurePercent,
    futureEpoch: fee.futureEpoch,
    maxFee: fee.currentMaxFee,
    feeAuthority: fee.authority,
    note,
  };
}

/**
 * Check 4: Authorities renounced?
 */
function analyzeAuthorities(parsed) {
  const mintRenounced = parsed.mintAuthority === null;
  const freezeRenounced = parsed.freezeAuthority === null;

  return {
    mintAuthority: parsed.mintAuthority,
    mintRenounced,
    freezeAuthority: parsed.freezeAuthority,
    freezeRenounced,
    // Note: USDC keeps both authorities for compliance — active authority is NOT automatically a rug.
    note: "Active mint/freeze authority is a RISK SIGNAL, not proof of a scam. USDC keeps both for compliance.",
  };
}

/**
 * Check 5: Backdoors
 */
function analyzeBackdoors(parsed) {
  const backdoors = [];
  for (const ext of parsed.extensions) {
    switch (ext.type) {
      case "PermanentDelegate":
        backdoors.push({ type: "PermanentDelegate", risk: "CRITICAL", note: "delegate can transfer/burn any holder's tokens at any time" });
        break;
      case "TransferHook":
        backdoors.push({ type: "TransferHook", risk: "HIGH", note: "external program executes on every transfer — can block/tax/redirect" });
        break;
      case "PausableConfig":
        backdoors.push({ type: "PausableConfig", risk: "HIGH", note: "transfers can be paused at any time (sell freeze switch)" });
        break;
      case "PermissionedBurn":
        backdoors.push({ type: "PermissionedBurn", risk: "HIGH", note: "authorized burner can destroy holders' tokens" });
        break;
      case "NonTransferable":
        backdoors.push({ type: "NonTransferable", risk: "CRITICAL", note: "transfers permanently disabled (irreversible honeypot)" });
        break;
      case "MintCloseAuthority":
        backdoors.push({ type: "MintCloseAuthority", risk: "MEDIUM", note: "holder can close the mint account" });
        break;
      case "DefaultAccountState":
        backdoors.push({ type: "DefaultAccountState", risk: "MEDIUM", note: "new token accounts may default to frozen" });
        break;
      case "TransferFeeConfig":
        backdoors.push({ type: "TransferFeeConfig", risk: "MEDIUM", note: "transfer fee may be raised to 100% (sell tax backdoor)" });
        break;
      default:
        break;
    }
  }

  // Mint authority active = can mint unlimited new supply (dilution backdoor)
  if (parsed.mintAuthority !== null) {
    backdoors.push({ type: "ActiveMintAuthority", risk: "HIGH", note: "holder can mint unlimited supply (dilution / sell-pressure backdoor)" });
  }

  return {
    status: backdoors.length > 0 ? "backdoors-present" : "clean",
    backdoors,
    note: "Mint authority (if active) can mint unlimited tokens — a dilution backdoor even without a 'malicious' extension.",
  };
}

/**
 * 评分层：LP 锁风险判断。
 * 客观事实在 facts.lpLock（池子/锁状态/LP 归属），这里做主观风险提示。
 */
function analyzeLpLockRisk(lpLockResult) {
  if (!lpLockResult) {
    return { status: "UNKNOWN", note: "LP lock not checked" };
  }

  switch (lpLockResult.status) {
    case "RPC_BLOCKED":
      return { status: "UNKNOWN", note: "LP 池搜索被当前 RPC 拦截或失败（免费公共节点常拦 getProgramAccounts）——无法区分「真没池」与「没查成」，按宁缺毋假标记 unknown；换支持该方法的 RPC（如 Helius）可得完整 LP 锁状态。" };
    case "NO_POOL_FOUND":
      return { status: "UNKNOWN", note: "未发现 Raydium AMM v4 池（可能在 Orca/Meteora，或未上流动性）—— 查不到不编，标记 unknown。" };
    case "UNKNOWN":
      return { status: "UNKNOWN", note: lpLockResult.note ?? "LP 锁状态无法确认" };
    default:
      break;
  }

  // 有池子，看每个池子的锁状态
  const results = lpLockResult.results ?? [];
  const anyPermanent = results.some((r) => r.status === "PERMANENT");
  const anyTimeLocked = results.some((r) => r.status === "TIME_LOCKED");
  const anyUnlocked = results.some((r) => r.status === "UNLOCKED");

  if (anyPermanent) {
    return { status: "SAFE", level: "LOW", note: "LP 代币已烧进死地址（永久锁，不可撤）—— 最强安全信号。" };
  }
  if (anyTimeLocked && !anyUnlocked) {
    // 定时锁：精读到期时间，区分"未到期安全 / 已到期未撤（rug 风险）/ 已到期已撤（CRITICAL）"
    const locks = results.flatMap((r) => r.locks ?? []);
    const anyWithdrawn = locks.some((l) => l.withdrawn);
    const anyExpired = locks.some((l) => l.expired);
    const activeLocks = locks.filter((l) => !l.expired);

    if (anyWithdrawn && activeLocks.length === 0) {
      return { status: "TIME_LOCKED", level: "CRITICAL", note: "锁已到期且 LP 已被 deployer 撤走 —— 表面显示锁仓，实际流动性已抽空（rug 已发生）。" };
    }
    if (anyExpired && activeLocks.length === 0) {
      return { status: "TIME_LOCKED", level: "HIGH", note: "锁已到期但 LP 尚未撤走 —— deployer 随时能 rug，属高危窗口。" };
    }
    return { status: "TIME_LOCKED", level: "MEDIUM", note: "LP 已锁进锁仓器（到期时间已精读，未到期）—— 相对安全，但需在到期日复核。" };
  }
  if (anyUnlocked) {
    return { status: "UNLOCKED", level: "HIGH", note: "LP 代币在普通钱包，流动性可随时撤走 —— rug 风险。" };
  }
  return { status: "UNKNOWN", note: "LP 锁状态不明确" };
}

/**
 * Aggregate all checks into a single risk verdict.
 */
function aggregateVerdict(parsed, lpLockResult) {
  let riskScore = 0; // 0-10
  const risks = [];

  const sellBlockers = listSellBlockers(parsed);
  if (sellBlockers.length > 0) {
    riskScore += 4;
    risks.push(`sell-blocked: ${sellBlockers.map((b) => b.mechanism).join(", ")}`);
  }

  const backdoors = analyzeBackdoors(parsed).backdoors;
  const criticalCount = backdoors.filter((b) => b.risk === "CRITICAL").length;
  const highCount = backdoors.filter((b) => b.risk === "HIGH").length;
  riskScore += criticalCount * 3 + highCount * 2;
  if (criticalCount > 0) risks.push(`${criticalCount} CRITICAL backdoor(s)`);
  if (highCount > 0) risks.push(`${highCount} HIGH backdoor(s)`);

  if (parsed.mintAuthority !== null) {
    risks.push("mint authority still active (mint-more backdoor)");
  }

  // LP 锁风险计入总分
  if (lpLockResult) {
    const lpRisk = analyzeLpLockRisk(lpLockResult);
    if (lpRisk.level === "CRITICAL") {
      riskScore += 4;
      risks.push("LP lock expired and liquidity already withdrawn — rug already happened");
    } else if (lpRisk.level === "HIGH") {
      riskScore += 3;
      if (lpRisk.status === "TIME_LOCKED") {
        risks.push("LP lock expired but not yet withdrawn — deployer can rug at any moment");
      } else {
        risks.push("LP unlocked (liquidity can be withdrawn — rug risk)");
      }
    } else if (lpRisk.level === "MEDIUM") {
      riskScore += 1;
      risks.push("LP time-locked (verify unlock time)");
    }
  }

  riskScore = Math.min(riskScore, 10);

  let level;
  if (riskScore >= 8) level = "CRITICAL";
  else if (riskScore >= 5) level = "HIGH";
  else if (riskScore >= 3) level = "MEDIUM";
  else level = "LOW";

  return {
    riskScore,
    level,
    risks,
    summary:
      riskScore === 0
        ? "No sell-block or backdoor detected."
        : `${level} risk (${riskScore}/10): ${risks.join("; ")}`,
  };
}
