Solana Honeypot Detector
OnChain Vanguard — Solana SPL 貔貅 / 蜜罐 / 后门检测器
输入一个 SPL 代币 mint 地址，输出一份可验证的链上风险报告。
node src/index.js <TOKEN_MINT_ADDRESS>
Every conclusion ships with a verifiable on-chain evidence. 每一条结论都挂可验证的链上证据（池子地址 / lpMint / 锁仓账户 / 到期时间戳），查不到就写 unknown，绝不编造。
为什么做这个
Solana 上每天诞生海量新代币，绝大多数活不过几天。市面上的"貔貅检测 / rug 检查"工具分两种：
- 套壳工具：套一个 AI 大模型，读几个公开字段（有没有 mint authority、LP 在不在锁仓器里），然后编一段"风险评分"。漏洞在于：只读表层字段，看不懂 Solana 的账户模型细节，大量误判。
- 本工具：直接读链上账户的精确字节偏移，理解 Solana 的账户模型（authority vs owner、TLV 扩展、锁仓账户结构），把每个风险点落到可验证的链上证据。
我们一路踩出来的技术分水岭，就是跟套壳工具的差距证明。
检测能力（五项，全部落地）
#
检测项
说明
1
能不能卖
mint/freeze authority 是否 renounce、是否被 freeze
2
蜜罐信号
买卖税、黑白名单、危险扩展
3
LP 锁
锁没锁、锁到哪天、到期没到期、能不能撤
4
权限弃没弃
mint/freeze authority 是否 null
5
后门
Token-2022: transfer hook / permanent delegate / close authority / pausable 等
危险扩展覆盖（按风险降序）
1. PermanentDelegate (type 12) — 最狠，随时转走/烧掉你的币
2. TransferHook (type 14) — 每次转账跑外部程序，可让卖出失败
3. PausableConfig (type 26) — 随时暂停转账
4. NonTransferable (type 9) — 永久蜜罐，拿到就动不了
5. TransferFeeConfig (type 1) — 卖税可设到 100%（含"未来预设税率"隐藏 rug 点）
产品根基：事实层 + 评分层 分层
层
定义
特点
何时输出
事实层 (FACTS)
客观、可验证的链上数据
不掺杂主观判断，逐条可上浏览器核对
永远先出
白名单 (WHITELIST)
已知合规项目判定
挂发行方官网公示地址，可追溯
命中即只出事实、不评分
评分层 (SCORE)
主观风险提示
仅对未标注的未知项目做提示
仅未命中白名单时
为什么分层：合规稳定币（如 PYUSD）确实带 permanent delegate / transfer hook / active mint authority——这些是 PayPal 的合规用途，不是貔貅。不分层的工具会把主流稳定币全标红，砸招牌。
白名单每个项目都挂发行方官网公示地址（proofUrl），宁缺毋假，宁可少标不可错标。
技术分水岭（我们跟套壳工具的差距证明）
这些都是实测踩出来的坑，每条都对应一个"套壳工具会栽、我们不会"的点：
1. mint / freeze authority 的精确偏移
- mint authority 的 option 在 offset 0，pubkey 在 offset 4（不是 4/8）
- freeze authority 的 option 在 offset 46，pubkey 在 offset 50（不是 50/54）
读错偏移 = 把 renounce 的 authority 读成"还有"，或把"还有"读成"renounce"。我们用 USDC 金标准验证过。
2. Token-2022 的 TLV 起点是 166，不是 82
Token-2022 mint 的 TLV 扩展列表起点是 offset 166（165 字节统一 base + 1 字节 AccountType），不是 82。市面套壳工具的通病就是只读前 82 字节，漏掉 TLV 里的 permanent delegate，把"表面 renounce + TLV 藏 permanent delegate"的恶意盘误判成安全。
3. 扩展枚举值以官方为准
ExtensionType 枚举以 @solana/spl-token 官方为准（PermanentDelegate=12, TransferHook=14），不手写、不猜。
4. 判锁看 authority（offset 32），不看 owner
LP 代币存在 token account 里，token account 的 owner 永远是 Tokenkeg，但 authority 字段（offset 32）才是"谁能动 LP"的人。市面套壳工具栽在"看 owner"上，把"表面锁了其实没锁"的盘误判成安全。
5. Raydium 烧 LP 有 2 种方式
- 方式 A：烧给死地址 1nc1nerator...
- 方式 B：转给「owner=System Program(111...111)、无数据、有 SOL」的无 owner 账户（authority 永久失效）
两种都该判 PERMANENT，但证据形态不同。市面工具只认方式 A，会漏方式 B。BONK 主池就是方式 B，检测器能识别并标出"哪种烧法"。
6. 锁仓器的 vault authority 是"账户不存在"的 PDA
UNCX 的 LP vault authority = BzKincxjgFQjj4FmhaWrwHES1ekBGN73YesA7JwJJo7X，账户本身不存在（是 PDA）。看不懂这个，就把"真锁"误判成"没锁"。判定要先认锁仓器（vault authority），再认死地址。
LP 锁到期时间精读（定时锁不是半吊子）
定时锁的"到期时间 + 是否已过 + 剩余量"已精读落地，覆盖 UNCX 和 Streamflow 两家锁仓器：
锁仓器
程序
账户结构
到期时间字段
UNCX
GsSCS3vPW...
TokenLock（146 字节）
unlock_date offset 89
Streamflow
strmRqUCoQ...
metadata（1104 字节）
cliff offset 441
到期三级判定：
- 🟢 未到期 → MEDIUM「相对安全，到期日复核」
- 🔴 已到期未撤 → HIGH「deployer 随时能 rug」
- ⚠️ 已到期已撤（current_locked_amount=0）→ CRITICAL「rug 已发生」
关键：「锁到期但没撤」是隐藏 rug 点——表面 LP 还锁在锁仓器里，实际 deployer 随时能一键撤走。市面工具只查"LP 在不在锁仓器"，不读到期时间，把这种盘误判成安全。
金标准样本（验证锚点）
样本
mint
用途
USDC
EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
验证权限检测不误报（Circle 合规保留 authority）
PYUSD
2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo
验证 Token-2022 扩展解析 + permanent delegate 检测
BONK
DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
验证 LP 永久锁（烧法 B：无 owner 账户）
AZGFPtx
AZGFPtxBRbnZtXw4hgQF4BuSmWK3EhUg8omdUA9DEL3Y
验证 UNCX 定时锁到期时间精读（未到期，锁到 2035）
FHea4fcm
FHea4fcmfsQYaZV89fRrW7iSX1ngHRzqYZ92TEexnyRX
验证"锁已到期未撤"高危路径（3 个 UNCX Split 锁全过期）
案例报告（真实链上复盘）
案例
内容
GOLD rug pull 复盘
社交工程 rug 的诚实边界：检测器不误报、如实标 unknown
LP 锁到期未撤
"锁到期没撤=随时能 rug"的活案例，早 3 天可检出
BONK 永久锁
两种烧法识别（烧死地址 vs 无 owner 账户）
运行（How to run）
三步即可对一个 SPL 代币跑出报告：
# 1. 安装依赖
npm install

# 2. （可选）设置 RPC 端点 —— 不设也能跑，会 fallback 到 Solana 公共网关
#    生产/高频请自备 RPC（Helius / QuickNode / Alchemy 等），三选一：
#    方式 A：命令行参数
#      node src/index.js <MINT> --rpc "https://your-rpc.com/?api-key=xxx"
#    方式 B：环境变量（可 cp .env.example .env 后填入）
#      export SOLANA_RPC_URL="https://your-rpc.com/?api-key=xxx"

# 3. 跑检测（用任意 SPL mint 地址，例如 USDC）
node src/index.js EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
# 或
npm start -- EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
RPC 端点取值优先级：--rpc 参数 > SOLANA_RPC_URL 环境变量 > 公共 fallback（https://solana-rpc.publicnode.com，无 key，有速率限制）。源码不硬编码任何个人/付费 api-key。
换 RPC 端点（可选）：
node src/index.js <TOKEN_MINT_ADDRESS> --rpc <url>
当前边界（如实标注，不掩饰）
- ⏳ 多 AMM 覆盖：当前只做 Raydium AMM v4，Orca Whirlpool / Meteora / PumpSwap 待扩展
- ⏳ 多池主池选择优化：按 lpMint supply 排序，僵尸池会干扰，待改按 reserve 实际流动性
- ⏳ 合规白名单扩充：后续加 mSOL/jitoSOL 等主流 LST
铁律
宁缺毋假。 每条结论挂可验证的链上证据，查不到就写 unknown，绝不编造。
白名单可追溯。 每个白名单项目挂发行方官网公示地址，不拍脑袋。
事实与评分分离。 客观事实永远先出，主观评分只对未知项目。
OnChain Vanguard — on-chain forensics & risk intelligence.
