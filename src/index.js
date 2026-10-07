/**
 * OnChain Vanguard — Solana Honeypot Detector CLI
 *
 * Usage:
 *   node src/index.js <TOKEN_MINT_ADDRESS> [--rpc <url>] [--chain mainnet-beta|devnet]
 *
 * RPC 端点取值优先级（由高到低）：
 *   1. --rpc <url> 命令行参数
 *   2. SOLANA_RPC_URL 环境变量
 *   3. 公共 fallback（https://solana-rpc.publicnode.com，无 key、公共网关）
 *
 * 说明：不把任何个人/付费 RPC api-key 硬编码进源码。
 * 生产/高频使用请自备 RPC（Helius / QuickNode / Alchemy 等），通过 --rpc 或环境变量传入。
 *
 * Example:
 *   node src/index.js EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 *   node src/index.js <MINT> --rpc "https://your-rpc.com/?api-key=xxx"
 *   SOLANA_RPC_URL="https://your-rpc.com" node src/index.js <MINT>
 */

import { Connection } from "@solana/web3.js";
import { detect } from "./detect.js";

// 公共 fallback：PublicNode 的 Solana 公共网关（无 key、免费、稳定）。
// 适合第一次 clone 后快速试跑。注意：公共网关有速率限制，生产/高频请自备 RPC。
// （曾用 Solana 官方 api.mainnet-beta.solana.com 作 fallback，实测部分网络出口访问不通，
//   换成 PublicNode，宁缺毋假——默认 fallback 必须是"真能通"的。）
const FALLBACK_RPC = "https://solana-rpc.publicnode.com";

function resolveRpc(cliRpc) {
  if (cliRpc) return cliRpc;
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  return FALLBACK_RPC;
}

function parseArgs(argv) {
  const args = { mint: null, rpc: null, chain: "mainnet-beta" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rpc" && argv[i + 1]) {
      args.rpc = argv[i + 1];
      i++;
    } else if (a === "--chain" && argv[i + 1]) {
      args.chain = argv[i + 1];
      i++;
    } else if (!a.startsWith("--") && !args.mint) {
      args.mint = a;
    }
  }
  args.rpc = resolveRpc(args.rpc);
  return args;
}

function renderReport(report) {
  const line = "=".repeat(68);
  const sub = "-".repeat(68);
  console.log(line);
  console.log("OnChain Vanguard — Solana SPL Honeypot Detector");
  console.log(line);

  if (report.error) {
    console.log(`\n[ERROR] ${report.error}`);
    console.log(`        ${report.note}`);
    console.log(line);
    return;
  }

  console.log(`\nToken mint : ${report.input}`);
  console.log(`Chain      : ${report.chain}`);
  console.log(`Time       : ${report.timestamp}`);

  // ================= 事实层 =================
  const f = report.facts;
  console.log(`\n${line}`);
  console.log("FACTS (客观事实层 — 每条可上浏览器核对)");
  console.log(line);

  console.log(`  Program         : ${f.program} (${f.programId})`);
  console.log(`  Mint authority  : ${f.mintAuthority ?? "(renounced / null)"}${f.mintAuthorityRenounced ? " [renounced]" : " [ACTIVE]"}`);
  console.log(`  Freeze authority: ${f.freezeAuthority ?? "(renounced / null)"}${f.freezeAuthorityRenounced ? " [renounced]" : " [ACTIVE]"}`);

  console.log(`\n  Extensions (${f.extensions.length}):`);
  if (f.extensions.length) {
    for (const e of f.extensions) {
      console.log(`    - ${e.type} (type ${e.typeId}, ${e.length} bytes)`);
    }
  } else {
    console.log(`    (none — legacy SPL or no extensions)`);
  }

  console.log(`\n  Sell-blockers (客观: 技术上有哪些机制会阻止卖出):`);
  if (f.sellBlockedBy.length) {
    for (const b of f.sellBlockedBy) {
      console.log(`    - [${b.mechanism}] ${b.fact}${b.authority ? ` (authority: ${b.authority})` : ""}`);
    }
  } else {
    console.log(`    (none — 无任何阻止卖出的机制)`);
  }

  console.log(`\n  卖税 (Sell tax — 客观 bps):`);
  if (f.sellTax.noTransferFeeExtension) {
    console.log(`    - 无 TransferFeeConfig 扩展 → 技术上 0% 转移费`);
  } else {
    console.log(`    - 当前税率: ${(f.sellTax.currentBps / 100).toFixed(2)}% (${f.sellTax.currentBps} bps)`);
    if (f.sellTax.futureBps != null) {
      console.log(`    - 未来预设税率: ${(f.sellTax.futureBps / 100).toFixed(2)}% (epoch ${f.sellTax.futureEpoch} 生效)`);
    }
  }

  if (f.extensionDetails) {
    const d = f.extensionDetails;
    if (d.transferHook?.enabled) console.log(`    - Transfer hook 程序: ${d.transferHook.programId} [启用]`);
    if (d.mintCloseAuthority) console.log(`    - Mint close authority: ${d.mintCloseAuthority}`);
  }

  console.log(`\n  LP 锁 (Liquidity lock — 客观锁状态):`);
  if (f.lpLock) {
    const ll = f.lpLock;
    if (ll.status === "NO_POOL_FOUND") {
      console.log(`    - ${ll.note}`);
    } else if (ll.status === "POOLS_FOUND") {
      console.log(`    - 发现 ${ll.poolsFound} 个 Raydium AMM v4 池:`);
      for (const r of ll.results) {
        const lockIcon = r.status === "PERMANENT" ? "🔒永久锁" : r.status === "TIME_LOCKED" ? "⏰定时锁" : r.status === "UNLOCKED" ? "⚠️未锁" : "❓未知";
        console.log(`    - 池 ${r.evidence?.poolAddress ?? "?"} → ${lockIcon}`);
        if (r.status === "PERMANENT" && r.burnMethod) {
          const methodLabel = r.burnMethod === "dead-address" ? "烧给死地址(1nc1nerator)" : "转给无owner账户(权限永久失效)";
          console.log(`      ├─ 烧法: ${methodLabel}`);
        }
        if (r.note) console.log(`      ${r.note}`);
        if (r.evidence?.lpMint) console.log(`      lpMint: ${r.evidence.lpMint}`);
        // 定时锁：列出每个锁仓账户的到期时间 + 是否已过 + 剩余量
        if (r.status === "TIME_LOCKED" && Array.isArray(r.locks) && r.locks.length) {
          for (const lk of r.locks) {
            const state = lk.withdrawn ? "⚠️已撤走" : lk.expired ? "🔴已到期未撤" : "🟢未到期";
            console.log(`      ├─ ${lk.locker} 锁仓账户 ${lk.lockAccount}`);
            console.log(`      │  到期: ${lk.unlockTime}  [${state}]${lk.immutable === false ? " [可取消]" : " [不可取消]"}`);
            if (lk.currentLockedAmount != null) console.log(`      │  剩余锁定量: ${lk.currentLockedAmount}${lk.withdrawn ? " (已抽空)" : ""}`);
          }
        }
      }
    } else {
      console.log(`    - ${ll.note ?? ll.status}`);
    }
  } else {
    console.log(`    - (未检测)`);
  }

  // ================= 白名单判定 =================
  if (report.whitelist) {
    console.log(`\n${line}`);
    console.log("WHITELIST — 已知合规项目");
    console.log(line);
    console.log(`  ✅ 该项目在合规白名单内，扩展为发行方合规用途，不做风险评分。`);
    console.log(`  Issuer   : ${report.whitelist.issuer}`);
    console.log(`  Symbol   : ${report.whitelist.symbol}`);
    console.log(`  Proof    : ${report.whitelist.proofUrl}`);
    console.log(`  ⚠️ 说明  : 白名单依据 = 发行方官网公示地址（可追溯），非本工具主观认定。`);
    console.log(line);
    return;
  }

  // ================= 评分层（仅未命中白名单） =================
  const s = report.score;
  console.log(`\n${line}`);
  console.log("SCORE (评分层 — 仅对未标注的未知项目做提示)");
  console.log(line);

  console.log(`\n${sub}`);
  console.log("能不能卖 (Can you sell?)");
  console.log(sub);
  const cs = s.canSell;
  console.log(`  Status  : ${cs.status}${cs.sellable ? " ✅" : " ⚠️"}`);
  if (cs.findings.length) cs.findings.forEach((x) => console.log(`    - ${x}`));
  else console.log(`    - 无阻止卖出的机制`);

  console.log(`\n${sub}`);
  console.log("蜜罐信号 (Honeypot signals)");
  console.log(sub);
  const hp = s.honeypot;
  console.log(`  Status  : ${hp.status}`);
  if (hp.signals.length) hp.signals.forEach((x) => console.log(`    - ${x}`));
  else console.log(`    - 无明显蜜罐信号`);

  console.log(`\n${sub}`);
  console.log("卖税风险 (Sell-tax risk)");
  console.log(sub);
  const st = hp.sellTax;
  console.log(`  Status  : ${st.status}`);
  console.log(`  ${st.note}`);

  console.log(`\n${sub}`);
  console.log("LP 锁风险 (LP lock risk)");
  console.log(sub);
  const lp = s.lpLock;
  console.log(`  Status  : ${lp.status}${lp.level ? ` (${lp.level})` : ""}`);
  console.log(`  ${lp.note}`);

  console.log(`\n${sub}`);
  console.log("后门 (Backdoors)");
  console.log(sub);
  const bd = s.backdoors;
  if (bd.backdoors.length) bd.backdoors.forEach((b) => console.log(`  [${b.risk}] ${b.type} — ${b.note}`));
  else console.log(`  无检测到的后门`);

  console.log(`\n${line}`);
  console.log("VERDICT (风险评分)");
  console.log(line);
  const v = s.verdict;
  console.log(`  Risk   : ${v.level} (${v.riskScore}/10)`);
  console.log(`  Summary: ${v.summary}`);
  if (v.risks.length) v.risks.forEach((r) => console.log(`    - ${r}`));

  // ================= 未实现项 =================
  if (report.unknown && Object.keys(report.unknown).length) {
    console.log(`\n${line}`);
    console.log("UNKNOWN (查不到/未实现 — 如实标注，不编造)");
    console.log(line);
    for (const [k, note] of Object.entries(report.unknown)) {
      console.log(`  - ${k}: ${note}`);
    }
  }

  console.log(`\n${line}`);
  console.log("VERIFY YOURSELF");
  console.log(line);
  console.log(`  Mint account: https://solscan.io/token/${report.input}`);
  console.log(`  Owner program: ${f.programId}`);
  console.log(line);

  console.log("\n事实层 = 客观链上数据，可逐条上浏览器核对。");
  console.log("评分层 = 主观提示，仅对未标注项目。白名单命中即只出事实、不评分。");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.mint) {
    console.error("Usage: node src/index.js <TOKEN_MINT_ADDRESS> [--rpc <url>] [--chain mainnet-beta|devnet]");
    console.error("Example: node src/index.js EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    process.exit(1);
  }

  console.log(`Connecting to ${args.rpc} (${args.chain}) ...`);
  const connection = new Connection(args.rpc, "confirmed");

  const report = await detect(connection, args.mint);
  report.chain = args.chain;
  renderReport(report);
}

main().catch((err) => {
  console.error("\n[FATAL]", err.message);
  process.exit(1);
});
