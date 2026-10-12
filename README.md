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

**Status accuracy:** `本轮已完成` means a `task_complete` / `turn_complete` / `turn_aborted` marker was found, **not** that Codex exited. `可能执行中` means a recent uncompleted turn, observed JSONL growth, a recent persisted compaction checkpoint, or a **bounded continuation of previously observed activity** (up to eight minutes of silence, without resetting that timer on each scan). Both are inferences, not a process-level claim. If the evidence is insufficient or stale, the result is `状态未知`. `可能待处理` would require a logged approval/input event, but Codex normally does not persist these transient events to rollouts; this status needs optional Hooks or a live app-server to be reliable. The app cannot reliably identify all running Codex Desktop/VS Code processes or approvals across independent app servers.

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

## 屏幕边缘悬浮窗（方案 C）

启动应用时，主窗口和 **始终置顶的 55×276 px 边缘窄栏**会同时出现。悬浮窗不会接管或控制任何 Codex 会话。

- **绿色运行入口**：显示目前被保守推断为可能执行中的会话及数量。
- **铃铛入口**：新检测到的待处理/完成提醒，未读数量在窄栏上显示；可在面板中逐条标记已读。
- **完成入口**：最近 24 小时发生过结束事件的会话。
- 点击任何任务条目会打开/聚焦主窗口并定位对应会话。展开后的面板显示标题、来源和工作空间信息。
- 点击 C 标识并拖动，可将窗口吸附到屏幕左侧或右侧；展开面板始终朝屏幕内部展开。点击箭头收起到窄栏。
- 悬浮窗底部可静音系统通知或隐藏窄栏。隐藏后从主窗口右上角的「显示悬浮窗」重新开启。
- **Ctrl+K** 仍可在主窗口聚焦搜索；关闭主窗口后悬浮窗仍继续监控，反之亦然。

**提醒行为：** Electron 主进程每约 12 秒扫描一次，主窗口和悬浮窗共享结果，避免双重扫描。只在新观察到的状态变化发生时（例如可能运行中 → 本轮完成、或新出现等待证据）生成未读提醒；启动时不会对历史会话补发。重复轮次可根据持久化结束事件的时间与 turn id 去重。操作系统支持的情况下还会发出 Windows 系统通知；若系统禁用了通知，悬浮窗未读徽标仍有效。静音只关闭系统弹窗，不会丢弃悬浮窗收件箱的事件；静音与未读信息在本次应用运行期间保留，重启后不保留。

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

Unlike a transcript viewer, this application does **not** read entire sessions, render chat content, or maintain a secondary database. Each refresh scans at most 10,000 file names per source and returns metadata from at most the 200 most recently modified rollouts. The first pass reads a 128 KiB head and 192 KiB tail. Recently modified sessions with missing lifecycle evidence get one more bounded read of at most 8 MiB; no unbounded transcript scan is performed. It polls every 12 seconds, without installing any watcher on the target machine.

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
