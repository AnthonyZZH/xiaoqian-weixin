# Windows 交互会话与 SSH

SSH 用于检查文件、传包、运行离线测试和控制已授权的启动流程。Windows 服务通常位于 Session 0，和登录用户的交互桌面隔离；SSH 的会话归属也必须实际检查，不能只看相同用户名或 Administrator 身份。[微软交互服务说明](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services)

## 只读预检

在宿主核对当前 Windows 身份、目标登录会话、微信进程、桥接与 driver 的 PID/启动时间/SessionId。以下查询仅展示进程元数据，具体进程名及 PID来自目标部署，不要扫描或输出完整命令行中的秘密。

```powershell
whoami
query session
Get-Process -Id <HOST_PID>,<DRIVER_PID>,<WECHAT_PID> |
  Select-Object Id,ProcessName,SessionId,StartTime
```

这里的尖括号是参数位置，必须替换后再执行。微信和 UI driver 必须对应经确认的同一可操作交互桌面；不要把历史 Session 编号作为常量。确认窗口身份、登录状态、锁屏状态和 driver 的实际只读窗口诊断。HTTP ready 不能证明 UIA 可以访问目标控件。

## 启动方式

复用已有、已授权的交互登录启动方式或由操作者在该桌面启动。不要在 SSH 中直接 `Start-Process` 后就宣称微信 driver 已正常上线。若现有机制不存在，先给出需要新增的具体任务/服务、身份、参数及持久性，再取得相应授权；部署 skill 不自带创建任务或保存密码的许可。

非必要的后台辅助进程使用隐藏窗口；实际微信登录、二维码或需要操作者完成的交互应明确交给该桌面。不要抢占桌面、批量结束相同进程名或启动第二个控制器来“试试看”。管理员身份也不能替代 Session、窗口身份和前台焦点核验。

## 连接中断与重启

RDP 断开、锁屏、注销、分辨率/DPI 或微信升级都可能改变 UIA 条件；需要重新检查，不一概认为断开就一定可用或不可用。不得为了保持可控而自动关闭锁屏、改系统安全策略或保存新登录秘密。重启前写清现有交互启动机制如何恢复，不能把“进程能启动”当作“桌面已就绪”。
