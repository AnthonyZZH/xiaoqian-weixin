# 小千状态

小千的手机状态页显示微信监听和回复状态，以及后台任务的步骤时间线。执行中的步骤会高亮并单独计时，多步并行时可以看到每一步的进度。最近结束的十项任务可以展开查看。

查看码和管理码都能查看任务名称和步骤。管理码还可中断选中的排队或执行中任务，已完成步骤的产物会保留。重新回复和重启按钮根据当前回执和启动器能力启用。

## 启用

沿用[主仓库快速开始](../../README.md#快速开始)中的 Windows 路径变量。用运行小千的 Windows 账户安装状态页依赖。

```powershell
& "$Private\venv\Scripts\python.exe" -m pip install -r "$Repo\tools\mobile-status\requirements.txt"
```

首次生成私有补丁时，在 `render-owner-deployment.mjs` 命令末尾加入 `--mobile-status true --owner-tasks true`。前一个选项加载状态网站的宿主接口，后一个选项启用后台任务引擎。

已有部署可继续使用原来的私有 JSON 补丁。在 `xiaoqian-wechat-native` 的 `config` 中确认 `ownerTasks.enabled` 为 `true`，并在同一 `insert` 数组内、微信桥之后加入以下插件。将示例仓库路径换成本机路径。

```json
{
  "id": "xiaoqian-mobile-control",
  "name": "file:///C:/Apps/xiaoqian-weixin/tools/mobile-status/mobile-host-control.mjs"
}
```

按主仓库说明用该补丁启动 Harness。在同一 Windows 账户的另一个 PowerShell 窗口启动状态页。这里的 `$Private` 和 `$Repo` 仍指向快速开始中的目录。

```powershell
$env:XQ_MOBILE_PATCH = "$Private\wechat.patch.json"
& "$Private\venv\Scripts\python.exe" "$Repo\tools\mobile-status\mobile_status_server.pyw"
```

本机入口为 `http://127.0.0.1:8791/`。手机访问时，将自己的 HTTPS 反向代理指向这个回环地址，并在启动状态页之前把 `XQ_MOBILE_ORIGIN` 设为手机使用的源地址，例如 `https://status.example.com`。若使用非默认 HTTPS 端口，也要写上端口。页面和 API 共用同一个源。

状态页按相同的补丁路径识别正在运行的 Harness。使用自定义入口时，将 `XQ_MOBILE_DSH_BIN` 设为对应 `bin.js` 的绝对路径；需要指定 Node 可执行文件时使用 `XQ_MOBILE_NODE`。

## 查看码和管理码

状态页首次启动会生成两套随机凭据，保存在当前用户的 `%LOCALAPPDATA%\Xiaoqian\MobileStatus`，由 Windows DPAPI 加密。用同一个 Windows 账户在本机终端运行相应命令，再在手机页面输入该码。

```powershell
Push-Location "$Repo\tools\mobile-status"
# 查看码
& "$Private\venv\Scripts\python.exe" -c "from mobile_status_server import viewer_key; print(viewer_key().decode('ascii'))"
# 管理码
& "$Private\venv\Scripts\python.exe" -c "from mobile_status_server import KEY_FILE, viewer_key; print(viewer_key(KEY_FILE.with_name('operator.dpapi')).decode('ascii'))"
Pop-Location
```

凭据也可以作为页面 URL 片段保存，例如 `/#view=<查看码>` 或 `/#manage=<管理码>`。宿主使用普通命令行启动时，重启按钮默认禁用。支持重启的启动器需设置 `XQ_MOBILE_RESTARTABLE=1`、支持 Harness 的正常退出流程，并在收到退出码 75 后启动一个替代实例。
