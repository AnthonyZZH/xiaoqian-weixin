# r11：群文字接话策略先于取图

本次是已受控启用 r11 的可公开源码增量，基于公开提交 `dabd2956873cb40dfdbd762eedce73a30ad84f63`。它保留 r10 文件接收候选和显式 owner 配置，只同步图片路由与原生裁剪增量。发布源码不会修改任何正在运行的服务。

## 部署状态与验收边界

受控部署于 2026-11-01 启用已验证 owner 私聊与一个现有配置群的自动看图，原 Agent、provider、会话、人格和群策略保持原绑定。这里的“启用”指接线和开关已核对，**尚无新图片自然识别验收**；不重放旧图片，也没有用真实模型付费探针代替自然验收。公开模板的 `vision.enabled` 与 `mediaAllowStaticCapture` 仍默认 false。

已登记 PDF 曾通过实际 `owner_attachment_read` 读取：1 页、8 个文档字符。它不证明新文件接收流程通过；r10 自动收文件仍是 19 项离线测试覆盖的未上线候选，需新的未接收样本验收。本次没有合入后续尚在修改的部署候选。

## 图片链路与群隔离

1. 原生 read 生成当前消息和可信 canonical/read/generation 绑定。
2. 群消息先调用既有、同步、仅文字/元数据的接话策略。gate=false 时零证据获取、零截图、零 SDK admission、零模型图像输入；不先看图再决定接话。
3. gate=true 为该批次和消息对象颁发不可序列化、一次性 WeakMap 票据，绑定群、会话、话题 epoch 与短 TTL。只有唯一配置群和已验证 owner 可以进入图片路径。
4. 取证与截屏重新核对当前窗口、消息、精确边界；裁掉头像、发送者头和周围聊天。缺少或重复发送者头、混合内容、不确定边界、窗口/代际变化均拒绝。
5. 裁剪像素作为正式 Harness image attachment，经原 SDK admission 返回 image 引用，交回原 Agent/provider。SDK 等待后和入队前再次核对话题与绑定；失效票据不重试。

表情允许分析可信布局下的当前静态帧；不下载原图，不声明理解完整动画。正文与图片内容都是不可信材料，不能通过提示词改变群接话、主动性、owner 文件或 shell 权限。

## 公开启动接线

`src/scoped-group-images.mjs` 提供可信宿主启动函数 `installScopedGroupImages({bridge, attachments, groupId, decideTopic, topicIdleMs})`。`decideTopic(state, normalizedMessage, now)` 必须是部署已有的同步文字策略，返回 `{allow, reason, topicId, invalidate?}`，并维护其既有 `groupTopic` 状态；不要用模型返回值或图片识别结果代替它。公开测试中的简化提及词策略只是合成夹具。

函数仅接受未启动子进程、core/driver 均暂停的可信启动阶段，且原 owner 图片输入已授权和创建。它验证恰好一个 owner、一个已配置非 owner 群，在 driver hello 中声明唯一群 ID，安装文字预判与受限图片路由，并返回恢复原接线的 disposer。它不会暂停、重启、更新 profile、扫描历史或调用模型；调用方继续使用原启动流程启动驱动。没有在默认 `createBridge` 中偷偷启用图片，也没有增加对外模型工具。

同一消息对象、同一批次指纹与同一话题票据必须持续匹配；不能把独立取证命名空间的 ID 当作生产 canonical。部署必须提供同次原生读取校准出的可信 profile；公开仓库不包含任何实际 profile、账户/群标识、人格、聊天、真实截图、证明包或热更新脚本。

## 来源与验证

本地部署记录中的七个原生文件 SHA256 与激活记录一致；应用 core、图片输入、driver 和 gate 模块的路径、版本及激活前源文件时间已核对。这是组件级来源证据，不宣称整仓库与生产逐字节相同。公开适配保留已有显式 owner 规则及 r10 文件逻辑，把部署专用群策略替换为必须注入的既有策略接口，把私有热更新改为启动接线；未导出任何私有校准常量。可公开文件和校验清单见 [来源清单](NATIVE-IMAGES-R11-SOURCE.json)。

独立离线测试使用合成消息和像素，覆盖 gate=false 的四个零调用、文字接话后单图恰好一次、原 Agent 保持、其他群/暂停群拒绝、SDK 等待中话题变化和 owner 无重放。Python 测试覆盖群发送者头排除、缺失/重复/变化头拒绝与原生消息绑定。测试不操作真实 UI，不调用真实模型，不等于自然图片识别验收。

运行方法见 [图片与文件说明](NATIVE-INPUTS.md#离线验证)。远端 CI 与安装版 Harness SDK 集成测试未在本次通过；笔记本无对应 SDK 安装路径。依赖和定向回归结果见来源清单。
