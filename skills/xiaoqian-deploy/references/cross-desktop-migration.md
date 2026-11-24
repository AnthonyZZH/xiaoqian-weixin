# 跨桌面身份与非重放基线恢复门槛

适用于换主机、换登录桌面、重建微信窗口，或任何无法证明 UI 行身份仍属于同一 desktop epoch 的恢复。普通同桌面代码升级也要核对该条件，不能仅凭相同机器或用户名字判定身份连续。

## 已知风险

`uia-row-v2` 的消息 source key 可能包含 UIA RuntimeId，legacy alias 也可能随之变化。同一段已处理的可见内容在新桌面获得新 ID 后，复制旧账本未必能识别它。若账本仍是相同 identityVersion 且 `bootstrapped=true`，只在版本变化或未初始化时触发的保护会被绕过。

对历史 `31d6009` 行为的隔离反例已显示这种待接收路径；这说明 skill 必须阻止无恢复机制的切换，不表示已经修复该 release，也不预测每台机器实际会产生什么 RuntimeId。主流程不修改 core、不实现一个猜测的“清空后重建”修复。

## resume 前的必需条件

1. 找到目标 release 明确支持的 desktop-epoch/身份 reconciliation 或经审核的非重放基线恢复机制，核实它如何区分旧可见历史和确实未处理的新工作。
2. 按该机制在隔离恢复副本操作；保持旧 ACK、dedup、unknown、原生 Session 与成功事实。恢复必须能暂停、记录来源并解释分类，不能只是把所有可见行标为已读/已 ACK。
3. 对**实际目标版本的接收决策路径**运行以下合成验收，随后在 paused 状态检查实际恢复环境。仅校验文件、只 mock 一个“安全”返回值、或另写一个理想模型均不足以证明目标 core 安全。
4. 方法缺失、证据不完整或任何反例失败：保持 paused，报告迁移阻塞，交由目标实现提供安全恢复方法。不要自动修生产代码、改身份版本号、清账本/bootstrapped、删历史或注入旧消息。

## 必做合成验收：相同 v2，变化的 RuntimeId

在目标版本的隔离测试环境准备最小合成账本，不使用真实聊天、模型、微信或私有数据：

- 已恢复一条处理过的可见消息及其旧 ID/alias；`identityVersion=uia-row-v2`、`bootstrapped=true`；保留 ACK/dedup、一个 unknown 发送及原生 Session 标识。
- 新快照的聊天/角色/发送者/可见内容与旧消息相同，RuntimeId 及相应 ID/legacy alias 改成新桌面值；identityVersion 不变。
- 经目标版本支持的恢复机制调用真实读取/接收决策方法。用捕获桩代替外部 ingest、native followup、模型与发送边界，发生调用即记录失败，不能接入真实副作用。
- 必须观察到旧可见消息不会成为新可处理消息，`ingest=0`、`native followup=0`、`output/send=0`；账本、unknown 和原生 Session 保留。只有“没有真正发送”不够，因为旧消息可能已经被送进模型路径。
- 再加入一条不能确认为旧历史的新 pending 行；机制必须保留或隔离以供审核，不能为通过第一项而全屏静默 ACK。重复恢复及中断/重启也不能释放旧历史或丢失 unknown。

记录目标 commit、所用支持机制、合成输入与私有测试证据位置、接收决策计数和状态前后比较。不要把这些实际运行记录或目标机器路径放进公共 skill 仓库。结果与普通清单验证分开报告；测试当前目标失败时，这是有效阻塞证据，不是把断言改为通过的理由。

## 明确不构成迁移成功的证据

SHA256/字节数一致、SQLite 能打开、HTTP ready、driver-ready、旧 ID 仍在数据库、相同 identityVersion、`bootstrapped=true`、或 mock 测试通过，都不能单独证明新桌面不会重放历史。没有上述目标版本验收，就不能宣称自动或无缝迁移。
