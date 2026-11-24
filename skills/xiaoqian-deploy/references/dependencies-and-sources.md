# 依赖、来源与版本边界

## 可复核基线

| 组件 | 该流程的历史验证版本 | 来源与限制 |
| --- | --- | --- |
| Node.js | 要求 ≥24；测试 24.22.1 | [Node 官方下载](https://nodejs.org/en/download)。新大版本需要重跑兼容测试 |
| Python | 3.12 | [Python 官方下载](https://www.python.org/downloads/)，使用目标系统的受控环境 |
| Harness | `@deepseek-ai/dsh@0.2.1-rc.4` | [官方代码仓库](https://github.com/deepseek-ai/deepseek-harness)、[npm 包](https://www.npmjs.com/package/@deepseek-ai/dsh) |
| Harness tools | `@deepseek-ai/dsh-tools@0.2.1-rc.4` | [npm 包](https://www.npmjs.com/package/@deepseek-ai/dsh-tools)，与 Harness 同一 rc.4 |
| Windows UI Automation | `uiautomation==2.0.29` | [PyPI 版本](https://pypi.org/project/uiautomation/2.0.29/)、[作者仓库](https://github.com/yinkaisheng/Python-UIAutomation-for-Windows) |
| COM | `comtypes==1.4.17` | [PyPI 版本](https://pypi.org/project/comtypes/1.4.17/) |
| 图片解析 | `Pillow==12.0.0` | [PyPI 版本](https://pypi.org/project/pillow/12.0.0/) |
| PDF 读取 | `pypdf==6.21.4` | 公开版驱动环境按 `requirements-windows.txt` 安装；随包的 PDF 解析依赖和许可证保留在 `vendor/owner-tools/` |
| 主库，可选 | `basic-memory==0.24.1` | [作者仓库](https://github.com/basicmachines-co/basic-memory)、[官方文档](https://docs.basicmemory.com/) |

以上是复现基线，不是最新版本推荐或安全更新承诺。选择不同版本时，核对目标锁文件、来源和 API，记录差异并重跑测试。不要从社区镜像猜测官方包，不执行网页提供的未知安装脚本；npm 页面不可达不意味着安装包已经核验。

rc.4 的 Agent/tool 注册、子任务 activation/query/recovery、会话事件内容及 completed reason 的形状有严格约束。不要用名称相似的端口或返回值替代；按桥接仓库的针对性测试检查实际安装的公共 package metadata 和导出。provider balance shim 如启用，还需要核实官方 provider、精确已安装包版本/源文件摘要及模块解析；缺失时报告不可用，不改写原包或读取凭据。

## 平台边界

Windows 是当前真实微信 UI driver 的适配目标。macOS/Linux 可以运行适用的核心、模拟 driver、脚本和非 UI 测试；遇到 `LIVE_DRIVER_REQUIRES_WINDOWS` 不能绕过为“已支持”。迁移真实微信 UI 必须另写并在目标平台验收适配器。

## 新建公开版运行环境

在用户指定目录中检出主仓提交。以下 PowerShell 变量为配置示例；把源码、宿主和私有目录换成目标机器实际路径。已有匹配版本时复用已安装的依赖。

```powershell
$Repo = 'C:\Apps\xiaoqian-weixin'
$HostRoot = 'C:\Apps\Harness'
$Private = 'C:\AppData\Xiaoqian'
$BasePython = 'C:\Python312\python.exe'
New-Item -ItemType Directory -Force $HostRoot, $Private | Out-Null
& $BasePython -m venv "$Private\venv"
& "$Private\venv\Scripts\python.exe" -m pip install -r "$Repo\requirements-windows.txt"
npm install --prefix "$HostRoot" @deepseek-ai/dsh@0.2.1-rc.4 @deepseek-ai/dsh-tools@0.2.1-rc.4
```

每个安装命令成功后再继续。若选定渠道无法提供 rc.4，使用该部署有权使用的同版本发行包或已有安装，核对两个包的版本和导出。已有私有部署如提供专用安装器，应按其选定提交的锁文件与说明操作。实际加载的发布版本须与运行进程的路径、启动时间及源码摘要对应。

不将旧环境的 PID、Session 编号、路径、主库端点、聊天名或价格策略写成所有部署的默认值。未重现的动画、附件接收、模型子任务或多平台能力要保留为待验收项。
