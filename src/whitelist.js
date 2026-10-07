/**
 * OnChain Vanguard — 合规白名单 (compliance whitelist)
 *
 * 铁律 (与"宁缺毋假"一脉相承):
 *   白名单里每个项目，不能靠我们拍脑袋说它合规，必须挂"可验证依据"——
 *   发行方官方公开的 mint 地址页（Circle/Tether/PayPal 官网公示地址）。
 *   宁可少标，不可错标。宁可 empty，不可 fabricate。
 *
 * 数据结构（新增项目走同一结构）:
 *   {
 *     mint: "<base58 mint address>",          // 精确匹配的 mint 地址
 *     issuer: "<发行方名称>",                   // 如 Circle / Tether / PayPal
 *     symbol: "<代币符号>",                    // 如 USDC / USDT / PYUSD
 *     proofUrl: "<发行方官网公示 mint 地址的页面 URL>",  // 可验证依据，报告里给链接
 *   }
 *
 * 当前状态：已填 4 条主流稳定币（USDC/USDT/PYUSD/USDG），
 * 每条都挂发行方官网公示地址作 proofUrl，可追溯。
 * 后续扩充（mSOL/jitoSOL 等主流 LST）走同一结构。
 */

export const COMPLIANCE_WHITELIST = [
  {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    issuer: "Circle",
    symbol: "USDC",
    proofUrl: "https://www.circle.com/en/multi-chain-usdc",
  },
  {
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    issuer: "Tether",
    symbol: "USDT",
    proofUrl: "https://tether.to/en/supported-protocols/",
  },
  {
    mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
    issuer: "Paxos（为 PayPal 发行）",
    symbol: "PYUSD",
    proofUrl: "https://www.paxos.com/pyusd/",
  },
  {
    mint: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH",
    issuer: "Paxos",
    symbol: "USDG",
    proofUrl: "https://www.paxos.com/usdg/",
  },
];

/**
 * Look up a mint in the compliance whitelist.
 * @param {string} mintAddress
 * @returns {object|null} the whitelist entry, or null if not listed
 */
export function lookupWhitelist(mintAddress) {
  return COMPLIANCE_WHITELIST.find((e) => e.mint === mintAddress) || null;
}
