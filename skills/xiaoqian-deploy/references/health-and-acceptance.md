# 健康检查与验收证据

## 离线层：不触碰账号

使用目标源码的测试入口和已安装的锁定依赖，检查源码语法、包清单、fake driver、状态 schema、原生 rc.4 mock 端口以及 owner/group 反例。不要调用真实模型或模拟“送达成功”。记录测试运行环境和覆盖范围；跳过或缺失依赖要明确报告。

对媒体验证原始字节与审核状态，不把截图当作原文件。长任务测试若只 mock activation/query/recovery，只能说明契约；不能声称模型已跑完任务。官方余额 shim 的源码测试不等于认证传输或真实余额查询已验证。

公开主仓在 checkout 根目录提供下列离线入口。使用 [依赖说明](dependencies-and-sources.md) 的变量。若 npm 不在 PATH，可通过已安装 Node 随附的 npm CLI 运行相同命令。

```powershell
Set-Location $Repo
$env:XQ_TEST_PYTHON = "$Private\venv\Scripts\python.exe"
$env:XQ_COMPAT_RPC_PATH = "$Repo\compat\driver\bridge_rpc.py"
$env:XQ_NATIVE_PACKAGE_ROOT = "$HostRoot/node_modules/@deepseek-ai/"
$env:XQ_TEST_NATIVE_ROOT = $env:XQ_NATIVE_PACKAGE_ROOT
$env:DSH_PACKAGE_ROOT = $env:XQ_NATIVE_PACKAGE_ROOT
npm run check
npm test
```

`tests/package-distribution.test.mjs` 实际解包、导入插件并让兼容 RPC 完成模拟握手。报告实际通过、失败、跳过数；如要区分既有问题和新回归，在相同运行时及 SDK 设置下对照升级前提交。

## paused 宿主层：准备 resume

检查实际进程的启动时间/路径与 release commit 一致、原生插件已加载、单控制器、driver 在正确交互 Session、目标窗口诊断可用，且无进行中的发送或未处理 unknown 被错误重放。健康 URL 取自当前部署，不扫描或开放新端口；ready 与 driver-ready 分别记录。

身份/桌面恢复是独立的强制检查：[跨桌面恢复验收](cross-desktop-migration.md) 要求在隔离环境恢复 `uia-row-v2`、`bootstrapped=true` 的账本，保持旧可见内容不变而更换 RuntimeId/alias，确认没有 ingest、native followup 或输出，并保留原 ACK/dedup/unknown/Session。真实目标版本不支持安全恢复或反例失败时，不能 resume；“相同版本”“备份一致”“driver-ready”均不能放行。

核对 scope：

- 只有受信绑定的唯一 owner 私聊注册 owner 工具；精确 native Agent/current binding 和撤权检查仍生效；
- 群和其他私聊的工具集合不含 owner shell、文件、主库和管理工具；错误 Agent 调用被拒绝；
- 群内容、网页、附件和旧聊天记录不能提供 owner 身份或新发送许可；
- paused、身份变更和 disposal 会撤销对应工具/输出；主库和私库不会因相似名称串库。

在不产生外部副作用的范围检查主库可读/索引就绪、媒体记录及原文件可查询、features/persona 恢复、会话和 ACK/dedup/unknown 账本保留。不要用“文件数量大于零”代替正确库和正确聊天范围。核验时保留私有内容在宿主内，仅报告必要的通过/失败元数据。

## 实际账号层：仅按明确授权执行

区分只读 UI 观察、单条已授权收发、附件文件卡下载、接收端动画播放、长任务模型执行和自然主动唤醒。这些不是部署默认 smoke test；涉及发送、模型费用或桌面交互时遵守本次明确范围。未授权项标成待验收。

发送前确认准确目标与内容；前置失败是未尝试，点击后无法确认是 unknown，不能自动重试。输入框清空或适配器返回成功不等于接收端送达。保留用户草稿、焦点/窗口身份变化及不确定结果，不能为让测试通过清空草稿或历史。

主动唤醒验证先看现有 master/sleep/mute/group timer 状态，再观察自然事件；不要改时间、清睡眠或追赶 missed events。只有该功能真实运行的证据才能标为通过。

## 交付记录

向用户报告目标和实际加载提交、运行/配置/备份路径、paused/resumed 状态、driver Session 核验、三层证据各自结果、未完成验收及回退点。公开版本只保留参数化操作说明，不上传该实际记录、截图、真实 PID、聊天名、personas、主机地址或数据摘要清单。
