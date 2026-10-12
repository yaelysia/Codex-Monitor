# Codex Monitor

A lightweight, **read-only** Codex session monitor for Windows. One screen shows sessions, working directories (`cwd`), source machines and the latest observable state across **Windows**, **WSL** and **SSH Linux**.

No Codex modifications, hooks, remote daemon, credentials stored in the application, or transcript uploads.

## What it shows

| Column | Source |
|---|---|
| Session | `session_meta.id` (or filename fallback) |
| Title | `state_5.sqlite` `threads.name/title`, then `session_index.jsonl` rename index, then first user message |
| Workspace | `session_meta.cwd`, overridden by the latest `turn_context.cwd` in the read window |
| Host | Windows, an autodetected WSL distribution, or a configured SSH host |
| Status | The latest lifecycle events in bounded JSONL tail data |
| Last activity | Rollout JSONL file modification time |

**明确结束状态：** `task_complete / turn_complete` 且无错误信息时才算本轮正常完成；`turn_aborted` 标为「本轮已中断」，携带非空错误的结束事件标为「本轮失败」，均不会产生正常完成通知。SSH/WSL 的活动时间判断优先使用执行主机计算的文件年龄，避免 Windows 与远程主机时钟不同步导致执行中错误回退未知。

**Status accuracy:** `本轮已完成` means a successful `task_complete` / `turn_complete` marker, **not** that Codex exited. Aborted or error-bearing terminal events are separate states. `可能执行中` means a recent uncompleted turn, observed JSONL growth, a recent persisted compaction checkpoint, or a **bounded continuation of previously observed activity** (up to eight minutes of silence, without resetting that timer on each scan). Both are inferences, not a process-level claim. If the evidence is insufficient or stale, the result is `状态未知`. `可能待处理` would require a logged approval/input event, but Codex normally does not persist these transient events to rollouts; this status needs optional Hooks or a live app-server to be reliable. The app cannot reliably identify all running Codex Desktop/VS Code processes or approvals across independent app servers.

## Quick start (Windows)

Requirements: Windows 10/11, Node.js 22+ for development; system OpenSSH client for remote hosts; `python3` on WSL and remote Linux for scanning. Codex session data must be accessible under the executing user's `CODEX_HOME`.

```powershell
npm install
npm run dev
```

To package a Windows installer:

```powershell
npm run dist:win
```

The installer is saved under `release/`. **CI runs tests and builds only; it no longer creates installers automatically.** Run `npm run dist:win` locally only when explicitly needed.

### Windows startup crash: GPU process isn't usable

Some Windows installations have a Chromium/Electron GPU subprocess crash at startup
(`exit_code=-2147483645`, `GPU process isn't usable`), as described in
[Electron #51761](https://github.com/electron/electron/issues/51761).
It can be triggered by problematic inherited ACL entries, but the error alone
does not establish the cause.

To test a **GPU-sandbox-only** workaround in PowerShell (not a global Electron
sandbox disable):

```powershell
$env:CODEX_MONITOR_DISABLE_GPU_SANDBOX = "1"
npm run dev
```

This must be set **before launching** Electron. The same environment variable
works with the packaged `Codex Monitor.exe` when started from that shell.
To return to normal behavior, close the app, then run
`Remove-Item Env:CODEX_MONITOR_DISABLE_GPU_SANDBOX` and launch again.

**Security:** This reduces Chromium GPU process isolation. The setting is
opt-in and disabled by default. For a permanent environment fix, inspect the
ACLs of the Electron executable and its parent directories, particularly
inherited, unknown `S-1-15-2-*` entries. Back up permissions and identify
the exact problem before making ACL changes; do not blindly run
`icacls /reset /T` on your user profile or a shared programs directory.


## B + D hybrid interface

The desktop UI combines a workspace browser with a status-first Kanban board:

- **Left:** machine/data-source tree, with individual workspaces under each host (including WSL and SSH). Click a source or an absolute workspace to scope the current board. Full paths, rather than folder basenames, are used for grouping and filtering.
- **Center:** three concise columns for possible active work, pending/unknown evidence, and recently completed turns. The **unknown** and **waiting** statuses keep distinct badges; a log's lack of evidence does not mean an approval is required.
- **Right:** read-only details of the selected session (title, source, full directory, ID, last activity and status evidence). At narrower window widths, details open as a dismissible drawer instead of squeezing cards.
- **Other views:** the entire session table and machine/workspace grouping remain in the side navigation. Search, state filters, the seven-day toggle, refresh and data-source configuration work across views.
- **Performance:** card columns initially render eight sessions apiece, with explicit “show more” controls, so hundreds of historical sessions do not overload the board.
- **Keyboard:** Ctrl+K focuses search; Esc dismisses the details drawer.

This is a UI-only change: the scan interval, metadata-only collection, existing WSL/SSH adapters, and conservative status inference are unchanged. No Windows installer is built automatically; the CI pipeline only runs tests and a non-packaging build.

## 最近助手回复预览

主窗口任意视图中**点击会话**后，右侧详情栏将按需读取该会话最后一条已持久化的助手回复，显示约 420 字符的末尾节选。包括旧式 `event_msg.agent_message`、`response_item.message`、新版 `item_completed.AgentMessage` 和结束事件中的 `last_agent_message` 回退。不会读取或展示 `reasoning`、工具输出、压缩摘要及用户消息。

- **Windows、WSL、SSH** 均可读取，远程采集脚本只返回截短文本；主窗口与悬浮窗的会话元数据扫描仍然不读取正文。
- 只读取当前选中会话，每次最多尝试末尾 256 KiB / 4 MiB，避免为数百条历史会话传输完整对话。
- 会话文件更新时间变化时会自动更新当前选中的预览，也可点「刷新」重新读取。未找到文本、权限问题或远程失败会直接提示，不伪造内容。
- 只显示**已保存到 JSONL 的助手回复**；正在生成但还没有落盘的文字不会被实时流式展示。预览可能属于此前一轮，而非正在执行的这轮。
- IPC 只能通过已扫描会话 ID 选择目标，文件地址始终限制在对应机器的 `CODEX_HOME/sessions` 下，读取过程不修改 Codex 数据。

## 常驻体验与性能优化

Codex Monitor 已支持 Windows 系统托盘和单实例后台运行：关闭主窗口默认只是关闭该界面以释放 UI 资源，**监控、事件通道、悬浮窗与通知继续运行**。托盘可重新打开主窗口、切换悬浮窗、静音系统弹窗或选择「完全退出」停止监控。主窗口右上角「常驻设置」可取消后台运行，或在**正式打包的 Windows 版本**中选择开机自动启动；开发模式不会修改开机项。开机启动默认关闭。

主窗口的大小与位置、悬浮窗左/右屏幕边缘、显示器、纵向位置、展开和隐藏状态会保存在本机 `resident-state.json`，下次启动恢复。显示器移除或分辨率变化时自动调整到可见范围；若 Windows 重新分配显示器编号，也会尝试根据此前显示器的桌面坐标恢复到原屏幕。该文件不包含对话文本、会话日志或 SSH 密钥。

**悬浮窗透明度与位置：** 主窗口右上角「常驻设置」中，可实时拖动「悬浮窗透明度」滑块设置 **40%～100% 不透明度**，数值越低越透明，默认 100%。该设置作用于整个悬浮窗（包括文字、图标），收起和展开共用，隐藏或重启后仍保留。关闭主窗口后，也可从系统托盘的「悬浮窗不透明度」子菜单快速选取预设值。拖动悬浮窗顶部 C 标识即可改变左右停靠侧、所在屏幕和高度。出现屏幕布局变化或无法找到窗口时，可点「重置到主屏幕右侧」，不会重置透明度或任务通知。旧版 `resident-state.json` 不含透明度字段时保持原来的完全不透明外观。

性能策略如下：

- **本地 JSONL 元数据缓存**：文件大小和 mtime 均未变化时复用最近扫描的解析结果，最多保留 220 条小型元数据；不缓存完整日志、工具输出。缓存的执行中、待处理状态仍按原时间阈值过期，不会把停止写入的任务无限视为运行中。会话标题继续实时从 SQLite/索引查询。
- **按连接状态自适应兜底**：Windows / WSL / SSH 的事件通道正常工作时约每 60 秒全量审计一次；事件通道断线、正在重连或仅支持轮询的机器每约 12 秒补漏。任何文件事件仍按原有 400ms 合并及最短 3 秒单源扫描规则更新。
- **后台资源**：关闭主窗口时释放该 BrowserWindow；后台只保留托盘、必要的悬浮窗与监控服务。多次启动会唤醒原实例，不再重复创建监听通道、SSH 连接与系统通知。

这套优化不承诺固定 CPU / 内存占用；实际收益取决于会话数量、事件通道健康度和 SSH 网络状况。首次运行与配置改变时仍需完整扫描。
## 事件驱动通知（第一阶段）

Codex Monitor 现在采用 **事件触发的单源扫描 + 轮询兜底**：事件通道正常时约每 60 秒执行一次全量审计，不可用的数据源仍每约 12 秒补漏，继续共用现有状态机和通知去重逻辑：

- **Windows 本地：** 使用 Node.js 的递归 `fs.watch` 监听 `CODEX_HOME/sessions` 下新增或变化的 JSONL。
- **WSL / SSH Linux：** 通过现有 Python 3 与 OpenSSH 临时启动 `collector/watch.py`，调用 Linux `inotify` 等待磁盘事件；只发送 `ready` / `change` / `heartbeat` 三种小型 JSONL 信号，不传输会话内容、文件路径、密钥。
- **按来源刷新：** 一台服务器有变动，只重新采集该服务器的会话元数据。相同来源的事件 400ms 合并、最低 3 秒扫描间隔；不会因为每次文件追加而同时启动多个扫描。
- **补漏 / 恢复：** 事件通道短暂断开时会指数退避自动重连（最多 60 秒）；日志读取失败、平台不支持 `inotify` 或触发目录监听上限时仍保留 12 秒全量轮询。事件发生在扫描过程中也会排队补做一次扫描。
- **健康指示：** 主窗口左侧机器名称旁的小点显示文件事件通道状态：绿色为正在监听，暖色为连接中，灰色为仅轮询；将鼠标停留在数据源上可以查看文字说明。这里的“监听中”不代表 Codex 运行状态已由 App Server 实时确认。

远程监听需要保持一条独立的 SSH/WSL 命令连接，**不在远程安装软件、服务或 Hook**，退出 Monitor 时终止进程。如需临时禁用新监听、只保留旧轮询，可在启动前设置：

```powershell
$env:CODEX_MONITOR_DISABLE_EVENT_WATCHERS = "1"
npm run dev
```

**准确性边界：** 本阶段监听的是 *日志文件变化事件*，不是 Codex 尚未持久化的审批/提问、推理或 App Server 原生事件。它通常能比定时扫描更快发现新落盘的完成标记，但无法保证毫秒级通知，也无法检测所有客户端的等待提问事件。下一阶段才考虑对可用 Codex App Server 进行可选的原生事件订阅。

## 屏幕边缘悬浮窗（方案 C）

启动应用时，主窗口和 **始终置顶的 55×276 px 边缘窄栏**会同时出现。悬浮窗不会接管或控制任何 Codex 会话。

- **绿色运行入口**：显示目前被保守推断为可能执行中的会话及数量。
- **铃铛入口**：新检测到的待处理/完成提醒，未读数量在窄栏上显示；可在面板中逐条标记已读。
- **完成入口**：最近 24 小时发生过结束事件的会话。
- 点击任何任务条目会打开/聚焦主窗口并定位对应会话。展开后的面板显示标题、来源和工作空间信息。
- 点击 C 标识并拖动，可将窗口吸附到屏幕左侧或右侧；展开面板始终朝屏幕内部展开。点击箭头收起到窄栏。
- 悬浮窗底部可静音系统通知或隐藏窄栏。隐藏后从主窗口右上角的「显示悬浮窗」重新开启。
- **Ctrl+K** 仍可在主窗口聚焦搜索；关闭主窗口后悬浮窗仍继续监控，反之亦然。

**提醒行为：** Electron 主进程统一管理事件触发的扫描和自适应轮询，主窗口和悬浮窗共享结果，避免双重扫描。只在新观察到的状态变化发生时（例如可能运行中 → 本轮完成、或新出现等待证据）生成未读提醒；启动时不会对历史会话补发。重复轮次可根据持久化结束事件的时间与 turn id 去重。操作系统支持的情况下还会发出 Windows 系统通知；若系统禁用了通知，悬浮窗未读徽标仍有效。静音只关闭系统弹窗，不会丢弃悬浮窗收件箱的事件；静音与未读信息在本次应用运行期间保留，重启后不保留。

**子代理通知规则：** 根据 Codex 的 `session_meta` 中 `source.subagent`、`thread_source`、`parent_thread_id`（含旧式数据）识别子代理。它们仍出现在主窗口会话列表和分组页，并有「子代理」标签；默认不会产生“本轮完成”系统通知或铃铛未读提醒，悬浮窗的「最近完成」也只列出主任务。主代理自己的 Turn 完成仍正常通知；子代理的等待操作仍保留原有提醒行为。若来源元数据缺失，不能凭标题或路径猜测它是子代理。

**跨主机完成通知：** 远程服务器的日志 mtime 可能与 Windows 时钟不一致。通知系统优先依据相邻成功扫描观察到的任务结束状态或新结束事件标识；新发现会话、网络恢复后的任务使用源机器自行计算的 `ageAtSourceMs` 检查新鲜程度。SSH/WSL/Windows 共用同一事件去重逻辑；首次扫描不通知历史会话，断线很久后也不会批量弹出旧提醒。已完成的会话继续执行新轮次时，只要持久化了新的结束事件标识，也会再次提醒。

**准确性边界：** 「完成」是本轮完成，不代表整个 Codex 进程结束。等待提问/审批的部分事件在 Codex 中属于不持久化的实时事件，因此只靠 JSONL 无法在所有 Desktop、VS Code、CLI 会话上可靠检测；未检测到并不代表不在等待。若未来需要准确提醒全部审批/提问，需选择性增加 Hooks 或接入现有 App Server。这里不会把无日志更新的任务误判为待处理。

**开发验证**（Windows PowerShell）：

```powershell
git switch feat/session-monitor-mvp
git pull --ff-only
$env:CODEX_MONITOR_DISABLE_GPU_SANDBOX = "1"  # 仅在已确认 GPU 沙箱兼容故障时启用
npm run dev
```

**构建策略：** CI 只运行验证与普通前端构建，**不会自动生成 Windows 安装包**。

## Views

- **全部会话:** single list with Codex session title (when available), full workspace path, source machine, status, and last activity.
- **按执行位置分组:** source machine (Windows / each WSL distro / each configured SSH host) → absolute `cwd` → sessions in that directory. Active locations expand automatically; others can be expanded individually. Identical directory names on different machines are kept separate.
- Search matches titles, absolute workspace paths, machine labels, and session IDs in both views. Status filters and the recent-seven-days filter apply to both views.

Titles are read only from local Codex metadata. SQLite's `name` (explicit title) wins over the legacy rename index, then SQLite `title`, then the first user prompt. Local Windows uses built-in `node:sqlite` when available; remote Linux and WSL use Python's standard-library SQLite reader. If those metadata sources are absent or incompatible, the UI shows an unnamed session rather than inventing a title. Only bounded metadata/short prompts are returned.

## Configure sources

- **Local Windows:** Automatically reads `%CODEX_HOME%/sessions` when the Electron process inherits `CODEX_HOME`; otherwise `%USERPROFILE%/.codex/sessions`. Override in **数据源设置** if needed.
- **WSL:** Automatically discovers running or registered WSL distributions with `wsl.exe --list --quiet` and scans each user's `$CODEX_HOME/sessions` using `wsl.exe -d <distro> -- python3 -`. Docker Desktop internal distros (`docker-desktop` / `docker-desktop-data`) are skipped. A custom root can be set per distro. If a distro isn't accessible or doesn't contain Codex sessions, its error is shown without hiding other sources.
- **SSH:** Add an OpenSSH host alias or `user@host` under **数据源设置**. The app calls the Windows system `ssh` executable, so SSH config options such as `IdentityFile`, `ProxyJump`, and non-default `Port` work as they do in your terminal. **Before adding a host, run `ssh <alias>` once to confirm the known-host fingerprint and key authentication**; interactive passwords are not supported. You may override remote `CODEX_HOME` if noninteractive SSH doesn't inherit it.

Codex Desktop remote SSH and a separately launched SSH CLI using the **same Linux user and `CODEX_HOME`** are read from the **same SSH source**, not duplicated. Configure that remote host only once.

Settings are stored only in Electron's local `userData` directory. SSH keys/passwords are never persisted by Codex Monitor; authentication is delegated to OpenSSH. The remote Python script is transmitted via the encrypted SSH channel and only returns session metadata.

## Design

```text
Electron main process
 ├─ local.ts                 Windows file system adapter (bounded head/tail)
 ├─ collector.ts             SSH & WSL transport and source aggregation
 ├─ config.ts                Validated persistent settings
 └─ rollout.ts               Pure status / metadata parser
collector/scan.py            Dependency-free Linux/WSL scanner
src/renderer/                React + Vite desktop dashboard
src/shared/types.ts          IPC contract and source/session DTOs
```

Unlike a transcript viewer, this application does **not** read entire sessions, render chat content, or maintain a secondary database. Each refresh scans at most 10,000 file names per source and returns metadata from at most the 200 most recently modified rollouts. The first pass reads a 128 KiB head and 192 KiB tail. Recently modified sessions with missing lifecycle evidence get one more bounded read of at most 8 MiB; no unbounded transcript scan is performed. It polls every 12 seconds as a fallback and uses temporary, read-only filesystem event watchers while the application runs. No background service is installed on the target machine.

## Verify

```powershell
npm run typecheck
npm test
python -m unittest discover -s tests -p 'test_*.py'
npm run build
```

Tests exercise lifecycle event aliases, stale activity, malformed/truncated JSONL, CWD extraction and the Windows / Python scanning implementations.

## Limitations (MVP)

- Statuses are evidence-based **inferences**, not definitive external process states. To obtain authoritative `running / waiting` state, a later version would need integrations with each existing Codex app-server or opt-in Hooks.
- Rollouts must live in `<CODEX_HOME>/sessions/YYYY/MM/DD/*.jsonl`; the scanner searches under `sessions` recursively, not archived sessions or arbitrary drives.
- Large tool outputs can push the latest turn start beyond the short tail; fresh unknown sessions get a bounded 8 MiB retry. File growth observed across scans is a separate, tentative activity signal.
- Context compaction may run for minutes without new persisted records. The monitor now recognizes *completed* compaction checkpoints (`compacted`, legacy `context_compacted` and completed compaction items) if present. While a previously observed active session remains silent, it temporarily preserves `可能执行中` **for at most eight minutes since the last positive evidence**, with an explicit explanation; after that it falls back to `状态未知`.
- Compaction's **live start** events are not generally in the persistent rollout: the monitor cannot certify that a session is currently compacting, nor guarantee a non-unknown status when it starts observing in the middle of a long silent compaction. For exact live state a supported App Server or opt-in Hooks would be needed.
- WSL requires a discoverable distro and Linux user home; the noninteractive `python3` command must be available in that distro.
- The table displays up to 200 newest sessions per source (default UI restricts display to last seven days; toggle off for older sessions). No session data is sent to a cloud service.
