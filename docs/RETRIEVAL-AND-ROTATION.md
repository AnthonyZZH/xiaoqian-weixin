# 检索预算、仅数字观察与 OFF 轮换入口

本次基于公开 r11 提交 `7e37485319e4c0018502229f6ebefdc5e7cc7d96` 整理已部署组件增量。检索预算与数值观察有部署记录，轮换入口于 2026-11-02 在 `autoEnabled=false` 状态落地。**没有完成真实付费摘要或真实会话切换验收，也没有启用自动轮换。** 离线测试只证明其具体覆盖的接口行为。

## 检索与注入预算

`src/rotation-observer/retrieval-budget.mjs` 提供片段投影、共享预算和摘要注入校验；`retrieval-runtime.mjs` 包装既有 owner 工具定义的 execute/render 与 openHandle。原后端调用、owner/Agent/binding 校验、审计和完整存档接口继续使用原实现，不给群增加图库/私有文件权限。

一个 owner 输入的默认搜索元数据和读取结果共享至多 **5 段、12000 个渲染 JSON UTF-16 单元**；引用、位置与元数据占用预算。初始片段目标长度 2200。默认读取依据显式 query 或当前 owner 文字做本地词法匹配；不命中就返回来源元数据。它不是模型或向量语义检索。穷尽预算不再注入文字。

片段包含原文字符偏移、下一页位置和内容 SHA256。需要更多原文时使用 `more:true`、`offset:next_offset`、`expected_content_sha256:source.content_sha256`。每次显式后续页单独受限并应单独计费；内容改变时拒绝旧引用。完整源文档与精确 archive 回读没有被替换。

新轮换 handoff 在创建 Agent **之前**验证：摘要 text <=4096、序列化摘要 <=8192、其他固定字段合计 <=60000 个字符。超限拒绝，不静默截断人格、任务或引用。完整归档大小和冷启动注入大小是不同约束；1024 token 摘要输出 cap 仍保留。

## 数值观察与公开接线差异

`numeric-sampler-r2.mjs` 只读已有事件元数据与数字 usage。R3 的 `live-projection-r3.mjs` 对 native 已缓存的活跃 canonical fold 做有界分批大小投影，按序号、surface、绑定、模型与校准版本缓存；从既有 collector gateway 已序列化请求与已完成 usage 配对。不新增模型请求、正文文件扫描、响应流旁路或原始正文持久化。

配对比例是同模型经验数据。比较采用完整区间：保留 L >= 轮换 U（含相等）；轮换下界大于保留上界为明确更贵；其余才称区间重叠。单次读取视野包括一次性摘要及冷加载成本，不做多轮摊销，不重复计入缓存损失，不预测未知下一条输入，也不承诺最终会变便宜。shadow 永远不授予自动执行许可。

公开 `numeric-shadow-r3.mjs` 不依赖部署目录内的 verified-pairs、source-caps 或库配置证明文件。可信宿主须显式提供：

- `autoEnabled:false`、绝对 `stateRoot` 和 Python 解释器；状态数字只写入该运行目录。
- 经部署方核对的 `sourceCaps.bounds.archive_bytes_upper`，以及已验证本地库分支的 `libraryPolicy`（预期增量外部 API 费用为字符串 `'0'`、`not_execution_permission:true`）。公开包不替部署方证明库为本地零 API 增量。
- 不必提供历史校准：缺省 pairs 为空，从之后正常请求积累；无同模型完整配对即拒绝数值判断。不得用公开示例伪造真实校准。

宿主从显式已配置会话中选择唯一 owner，不使用部署专用 owner ID。原先写在源码旁的状态改写至 stateRoot；计算器从模块目录加载。原 source-bound 库策略证明和任何真实 usage/身份哈希均未发布。

`calculator/pricing.py` 是该次已确认的历史价卡，verified_on 为 2026-10-31，严格有效期到 2026-11-02 之前；过期返回 `QUOTE_STALE_REVALIDATE_OFFICIAL_SOURCE`，不自动联网刷新。正在修改的价卡未合入。文档不把历史金额表作为当前报价；重新启用前须完成独立价卡核对与验收。

## 轮换执行入口与失败处理

`src/rotation-execution/runtime.mjs` 绑定运行中的宿主配置白名单及当前 owner envelope，不读取 provider 凭证。可信宿主必须显式指定 autoEnabled；本次部署及公开说明均为 false。sourceRoot 指向本仓库根目录，executionRoot 是独立绝对运行目录，numericRoot 指向上述 observer 模块目录（含 calculator）。安装需要已有最终 transport 附着，不在公开默认 patch 中自动加载。

执行路径复用既有 library adapter、原子 rotation-session 端口和独立持久 Python 协调器。只接受当前 canonical trusted owner 纯文字输入；OFF 时不进入快照/存档/摘要/切换路径。启动不改变原 Agent、会话或人格。只有真实输入、版本/绑定稳定、经济判断成立时才可继续到昂贵路径；本次没有开启它。

摘要先规范化 canonical 记录，去除流/账本重复包装，上一份摘要只计一次。实际组装大小在付费发送前检查，最终 wire 再核对模型、输入、guide、1024 cap、无工具及一次物理请求。候选真实冷组装与首次最终 wire 核对 handoff、已绑定输入、版本和冻结预算。执行失败/未知结果不盲目重试；持久回执恢复不能重复付费摘要或 owner 输入。

提交后若出现最终 guard 失败，保留新旧会话及任务，对已提交路由标记 uncertain/quarantine，要求人工核对该回执；不静默回滚或重放。仅进程不再可探测不能冒充停止证明，权限拒绝按未知/仍存活处理。

## 测试与来源

执行入口来源包中的 15 个模块与本地安装 manifest 匹配，入口 hash 与部署记录吻合；检索/观察包中的 7 个模块及历史 calculator 依赖也与来源 manifest 对应。本仓库公开适配是组件级增量，不宣称整个公开仓库与运行实例逐字节相同。文件哈希及公开差异见 [来源清单](RETRIEVAL-ROTATION-SOURCE.json)。部署脚本、回滚、状态证明、聊天、人格、真实 usage、校准种子和私人路径均未发布。

服务器原记录的 26 项离线检查包含安装版 SDK 夹具；本次公开版不带其私有路径或完整 SDK 安装包。公开测试使用合成消息/最终 wire 和最小会话元数据，不冒充 SDK 序列化验收。可执行：

```powershell
$env:XQ_TEST_PYTHON = 'C:\Path\To\python.exe'
node --test src/rotation-observer/*.test.mjs src/rotation-execution/*.test.mjs tests/rotation-interface.test.mjs
```

测试涵盖片段预算/校验和分页/原文保留、handoff 创建前拒绝、OFF 身份与原生 wrapper 保持、数字元数据采样、活跃投影缓存、历史价卡过期拒绝、最终 wire 不匹配在网络前拒绝、重试与提交后隔离边界。未调用真实模型或 UI；远端 CI 与服务器 SDK 原测试未在本次重新运行。文件自动接收仍为 r10 候选，新图片自然识别仍未验收。
