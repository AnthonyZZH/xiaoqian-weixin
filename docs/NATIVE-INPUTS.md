# 图片与聊天文件接入

本次源码同时包含三层能力，验收程度不同：已登记文件可以由原 owner 工具读取；图片的原生绑定与正式模型附件接线已实现，但自动图片开关仍为 false；r10 新文件自动接收仍是离线候选，尚未上线。本文中的开关示例均默认关闭。

## 读取入口与公开目录

| 目录 | 职责 |
|---|---|
| `src/native-image-input.mjs`、`src/driver-native-image-host.mjs` | 有作用域的截图证据、大小限制、SDK 图片 admission、原 Agent 投递 |
| `src/driver-saved-file-host.mjs`、`src/owner-attachment-host.mjs` | 新文件动作账本、共享 registry、原 owner 附件工具与去重 |
| `driver/durable-client.mjs` | 图片/文件共用的原驱动 FIFO；接收过程中不允许普通轮询切走聊天 |
| `compat/vendor/xiaoqian_driver/`、`compat/driver/bridge_rpc.py` | 本次原生图片与文件能力使用的兼容驱动、canonical/read/generation 绑定、原生控件和 Windows 文件身份检查 |
| `compat/adapter/wechat_adapter.py` | 当前原生 UIA 行句柄；截图不序列化整个控件树 |
| `vendor/attachment-ingress/` | 受限目录文件读取、稳定性校验与共享附件登记 |
| `vendor/owner-tools/` | `owner_attachment_read` 和本地 TXT/DOCX/PDF 解析 worker |

沿用 README 部署命令中的 `--driver-rpc <仓库>/compat/driver/bridge_rpc.py` 和 `--adapter-root <仓库>/compat/adapter`。不要把新的 Node 接线接到旧的根目录 Python 驱动上，也不要混用另一版本的 adapter。`legacy/` 的冻结源码未修改。

公开导出保留显式配置的 owner 和群作用域，不使用部署专用昵称、群名或路径。未导出私有运行升级脚本、原型替换入口、运维回滚清单、现场证明或已登录环境。源码字段中的 `verified:true` 只能表示受信宿主已经验证过证据；从配置、聊天或模型中填一个布尔值不能制造证据。

## 图片：截图进入原模型

顺序是同次原生 read → canonical 消息与真实 worker generation → 短期单次能力 → 只包含目标图片的截图 → `ctx.attachments.admitPromptContent` → SDK 返回的 `{type:'image', attachment:...}` → 原来的 owner Agent/provider。`media_id` 或 JSON 中的 base64 文字不算正式图像输入。

截图必须保留同一聊天、owner/private 作用域、窗口实例、行句柄、readId/generation 和当前上下文。头像、周边聊天、输入框与滚动条不进入附件。裁剪不确定、被遮挡、越界、窗口/消息身份改变或发生未知结果时拒绝；未知投递不会自动重试。

表情支持针对实际验证过的 `ChatBubbleReferItemView` / `动画表情` 布局，不因类名中的 Refer 就把所有表情判为混合内容，也不因此放开所有引用/视频/卡片。动态图只保留一次已验证截图中的紧裁剪静态帧，避免两次截屏期间动画变化造成误判。结果明确标注 `sourceKind: static_screenshot`、`animationFramesAnalyzed: false`。这不是下载动图，也不表示已经理解完整动画。

自动图片输入仍须单独授权：

```yaml
mediaAllowStaticCapture: false
vision:
  enabled: false
  inputMode: native_attachment
```

启用还需要受信原生截图 profile 和同次生产 driver read 的真实绑定。取证/测试命名空间的 messageId、readId、PID 或控件句柄不能复制到生产。旧猫图不重放；已经处理、ACK 或被隔离的历史消息不会为了补验收而重新交给模型。原生模式不会注册旧的外部 `wechat_describe_image` worker，不新增第三方视觉 API；模型看图仍可能产生原 provider 的正常调用费用。

## 已登记文件与 PDF

工具只接收登记表中的 `attachmentId`，不接收模型提供的路径。宿主登记、owner 工具与解析器使用同一份 registry；群聊、其他 Agent、已经撤销的 owner 绑定都不能读取。文件正文、名称与解析结果是数据，不能授予工具权限。

一次实际部署中的已登记 PDF 已由真正的 `owner_attachment_read` 读取成功，结果为 **1 页、8 个文档字符**。该记录只证明那份已登记样本的工具链；没有公开文件、正文、个人目录、spool UUID 或运行证明。旧 PDF 的离线回放也已通过，但不能代替新文件原生接收验收。

公开默认 worker 现在支持 TXT、DOCX、PDF。PDF 使用 `requirements-windows.txt` 中固定的 `pypdf`，从 stdin 接收字节，在受限子进程中按页读取，不执行动作、宏、链接或嵌入对象；本入口禁用 OCR，没有远程 OCR/上传回退。依赖缺失、加密、损坏或超限返回明确错误。只有扫描图像而没有文本的 PDF 会报告需要 OCR，不会伪造正文。

```js
owner_attachment_read({attachmentId: '宿主登记的 ID', pageStart: 1, pageCount: 1})
```

PDF 页码从 1 开始，每次最多 10 页；附件入口最大 5 MiB，输出截断和未覆盖页会保留状态。没有要求范围时读取默认页段，不能把截断结果说成完整文档。

## r10：新文件自动接收候选

路径是可信当前消息 → 必要时原生接收一次 → 同一控件上的接收状态变化 → 原生“在文件夹中显示” → 新 Explorer 窗口中唯一选中文件 → 固定账号根目录与窗口实例 → Windows 文件身份/大小/哈希稳定 → 共享 registry → 原 owner 工具和附件描述符。

已接收文件跳过接收操作。未接收文件不使用另存为、下载到其他位置、双击打开文档、文件名搜索或目录扫描。打开文件夹但没有精确选中项、复用旧 Explorer 选择、路径跨账号、重解析点、硬链接、文件仍在写入、身份/哈希改变时都拒绝。

默认关闭：

```yaml
attachments:
  savedFilesEnabled: false
```

将来启用前，由可信宿主提供已确认的 `fileRoot`、`accountId` 和匹配的 `nativeProfile`；profile 绑定实际窗口 HWND、WeChat PID、同一账号根目录与已审查证据，不能使用本仓库的示例值。原生接收、菜单 InvokePattern、同控件完成状态与新 Explorer 精确选择的语义还必须用新样本现场核对。

**r10 仅完成 19 项原定向离线测试（11 Python + 8 Node），未上线。** 仍需一个新的、未接收的非私密 TXT/PDF 以及协调后的有界验收窗口。不得把旧文件已存在、模拟菜单成功、离线 PDF 回放或本次 GitHub 更新写成实机自动接收已通过。

动作前会持久预留；崩溃、超时和不确定结果保持隔离，不会因下一次 read 或重建进程而再接收一次。接收已被证明、后续定位失败的状态别名仍保留，避免破坏 canonical 连续性。解析失败作为有界工具错误报告，不把同名文件当作重试目标。

## 迁移与开关边界

新 host 必须保留经过审查的 `attachments.spoolDirectory`，复用既有登记条目和 UUID。不要同时保留两套 `owner_attachment_read` 闭包指向不同 registry，也不要清空消息、ACK、outbox、unknown、会话或人格状态。启动只把登记描述符作为不可信数据提供给原 owner 工具；加载旧 registry 不会再次接收或自动投递旧消息。

GitHub 源码更新不会改变部署开关、安装 profile、重启服务或操作微信。真正的升级/回滚要由部署方对运行版本和登记表做单独核对；私有操作清单不属于公开仓库。

## 离线验证

安装本仓库 Python 依赖后，使用同一解释器执行：

```powershell
$env:XQ_TEST_PYTHON = 'C:\Path\To\venv\Scripts\python.exe'
node --test tests/native-inputs/*.test.mjs
& $env:XQ_TEST_PYTHON -B -m unittest discover -s tests/native-inputs -p 'test_*.py'
& $env:XQ_TEST_PYTHON -B tests/compat-group-edge.test.py
& $env:XQ_TEST_PYTHON -B tests/test_compat_owner_recovery.py
```

测试使用合成消息、文件、菜单和控件；没有真实 UI/model 请求。PDF 回归生成一页八字符的合成文档，不能与上面的私有实机样本混为一谈。Windows 身份测试在其他系统上显式跳过。需要本地已安装 Harness SDK 的既有原生集成测试，必须先配置对应 SDK；本次笔记本没有该安装，不能声称它已通过。未运行远端 CI，也未运行没有配置的项目 lint/typecheck。
