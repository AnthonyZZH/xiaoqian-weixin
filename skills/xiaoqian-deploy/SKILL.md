---
name: xiaoqian-deploy
description: 帮助在已授权的 Windows 交互桌面部署、升级或回退小千微信桥接器，核对已部署版本、迁移会话与收发状态，或在隔离环境验证发行包。
---

# 小千部署

公开源码和本技能的维护入口在 [小千主仓](https://github.com/AnthonyZZH/xiaoqian-weixin)。普通部署从主仓选定提交。若用户要恢复已有私有部署，使用其授权的源码、备份和启动方式，核对真实目录布局。旧 `wechat`、`server-deploy` 仓库已停用，不作为安装依赖。

## 按本次任务选择步骤

- **首次安装。** 在独立 checkout 核对 `package.json`、`requirements-windows.txt` 和 `tools/render-owner-deployment.mjs`。用 [依赖与来源](references/dependencies-and-sources.md) 准备运行时，按 [配置与数据](references/configuration-and-data.md) 生成单一主人私聊的暂停配置。公开版默认路径是 `compat/adapter` 和 `compat/driver/bridge_rpc.py`。
- **核对现有部署。** 从 [Windows 会话](references/windows-session.md) 核对微信、Harness 和驱动的会话与运行路径，再用 [健康与验收](references/health-and-acceptance.md) 比对版本、身份和收发证据。仅核查时使用只读步骤。
- **升级或回退。** 按 [一致性备份](references/backup-and-restore.md) 保存会话绑定、收发账本、unknown 状态、任务记录、媒体原件和已使用的库。按 [切换与回退](references/rollout-and-rollback.md) 在原有交互会话完成切换，同一微信桌面只运行一个控制器。
- **跨桌面迁移。** Windows 的 UIA 身份可能随窗口重建而改变。恢复的旧消息和新待处理消息须通过 [跨桌面验收](references/cross-desktop-migration.md) 区分；证据不足时保持暂停。仅需核对文件时，使用 [清单校验脚本](scripts/verify_manifest.py)，清单格式见备份说明。

依据用户已授权的范围进行切换、真实收发或模型测试。交付时给出实际加载的代码版本、对应配置及回退位置，并说明验证覆盖了离线测试、运行宿主或真实账号的哪些环节。私有凭据、聊天内容、人格正文及运行数据保留在目标部署。
