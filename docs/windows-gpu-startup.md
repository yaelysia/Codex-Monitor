# Windows GPU 启动兼容

`GPU process exited unexpectedly: exit_code=-2147483645` / `GPU process isn't usable` 是 Electron/Chromium 子进程启动失败，不等同于 `ws` / `bufferutil` 模块加载错误。退出码本身不能确定是驱动、目录权限、系统更新还是其他问题。本功能提供可保存的应用兼容选择，不声称修复了底层系统原因。

## 配置一次，之后正常启动

先完全退出 Codex Monitor。在项目目录执行：

```powershell
npm run gpu:compat
npm run dev
```

`gpu:compat` **仅关闭 Chromium GPU 进程沙箱，会降低该进程的隔离**，但不关闭渲染进程沙箱、不使用 `--no-sandbox`、不修改系统权限或其他软件。它是受影响机器主动选择的兼容模式，默认不启用。

配置保存于 `%APPDATA%\codex-monitor\startup-gpu.json`，开发模式和正式安装版共用，与 Git 工作目录及临时环境变量分开。命令通过普通 Node.js 写配置，不需要先启动有故障的 Electron。重新打开终端、更新仓库后直接 `npm run dev` 即可；正式安装版也在启动时读取相同选择。

应用启动时会输出 `GPU startup: compat (saved)`，可确认设置确实生效。GPU 子进程异常时另输出一次模式、原因和退出码，不自动降低安全设置、不无限重启。

## 查看、恢复和另一种诊断模式

```powershell
npm run gpu:status
npm run gpu:reset
```

恢复后需完全退出并重启应用。`gpu:reset` 仅将上述 GPU 配置恢复为 `default`，不删除会话、提醒、窗口位置或其他设置。

`npm run gpu:software` 可保存禁用硬件加速的选择，**保留全部沙箱设置**。它与 GPU 沙箱兼容模式是不同诊断方向；软件渲染仍可能启动 GPU 子进程，所以不保证能解决沙箱初始化失败。

原有临时环境变量仍兼容：`CODEX_MONITOR_DISABLE_GPU_SANDBOX=1` 临时优先选择兼容模式，`=0` 临时优先选择默认模式，均不写回配置。命令会提示冲突。移除临时覆盖以使用保存值：

```powershell
Remove-Item Env:CODEX_MONITOR_DISABLE_GPU_SANDBOX -ErrorAction SilentlyContinue
```

## 验证边界

配置测试覆盖保存、重启读取、恢复、损坏配置、平台边界和环境覆盖。开发/生产构建产物测试核验配置在启动生命周期之前应用。Windows CI 另启动隔离的真实 Electron 测试窗口，检查页面加载、渲染截图、Node 隔离及 renderer sandbox；测试不启动 Monitor 的会话扫描，也不接触真实 Codex 数据。

CI 的 Windows 渲染成功不代表已复现或根治特定用户机器的 GPU 崩溃。不要为了这一退出码盲目重置用户目录 ACL、禁用全部沙箱或修改显卡驱动。相关上游报告仅提供调查线索：

- https://github.com/electron/electron/issues/51761
- https://github.com/electron/electron/issues/52098
- https://www.electronjs.org/docs/latest/api/app#appdisablehardwareacceleration
