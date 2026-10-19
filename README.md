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

主窗口的大小与位置、悬浮窗左/右屏幕边缘、显示器、纵向位置和隐藏状态保存在本机 `resident-state.json`，下次启动恢复。**悬浮窗展开是临时操作：重新显示或重启后默认收起，不恢复旧的展开面板。**显示器移除或分辨率变化时自动调整到可见范围；若 Windows 重新分配显示器编号，也会尝试根据此前显示器的桌面坐标恢复到原屏幕。该文件不包含对话文本、会话日志或 SSH 密钥。

**悬浮窗透明度与位置：** 主窗口右上角「常驻设置」中，可实时拖动「悬浮窗透明度」滑块设置 **40%～100% 不透明度**，数值越低越透明，默认 100%。该设置作用于整个悬浮窗（包括文字、图标），收起和展开共用，隐藏或重启后仍保留。关闭主窗口后，也可从系统托盘的「悬浮窗不透明度」子菜单快速选取预设值。拖动悬浮窗顶部 C 标识即可改变左右停靠侧、所在屏幕和高度。出现屏幕布局变化或无法找到窗口时，可点「重置到主屏幕右侧」，不会重置透明度或任务通知。旧版 `resident-state.json` 不含透明度字段时保持原来的完全不透明外观。

性能策略如下：

- **本地 JSONL 元数据缓存**：文件大小和 mtime 均未变化时复用最近扫描的解析结果，最多保留 220 条小型元数据；不缓存完整日志、工具输出。缓存的执行中、待处理状态仍按原时间阈值过期，不会把停止写入的任务无限视为运行中。会话标题继续实时从 SQLite/索引查询。
- **按连接状态自适应兜底**：Windows / WSL / SSH 的事件通道正常工作时约每 60 秒全量审计一次；事件通道断线、正在重连或仅支持轮询的机器每约 12 秒补漏。任何文件事件仍按原有 400ms 合并及最短 3 秒单源扫描规则更新。
- **后台资源**：关闭主窗口时释放该 BrowserWindow；后台只保留托盘、必要的悬浮窗与监控服务。多次启动会唤醒原实例，不再重复创建监听通道、SSH 连接与系统通知。

这套优化不承诺固定 CPU / 内存占用；实际收益取决于会话数量、事件通道健康度和 SSH 网络状况。首次运行与配置改变时仍需完整扫描。
## VS Code 会话来源字段兼容（2026-10）

除已知的 `session_meta.originator`（如 `codex_vscode`）外，解析器现在还允许在 `originator` 缺失或无法识别时使用 **Codex 自己序列化的确切 `session_meta.source: "vscode"`** 作为 VS Code 来源线索；同理 `"cli"` 可回退为终端类型。Windows 与 WSL/SSH 的 Python 解析器保持一致。如果有明确的 Desktop/CLI originator，它始终优先于回退字段；其他、不明或对象形式的 source 不会臆测为 VS Code。来源识别只是窗口绑定的前置条件，后续仍必须核对源机器输入时间和 Windows 原生前台 HWND/PID/进程实例。

## Windows 前台关联诊断（2026-10）

若某个会话仍无法自动抑制通知或标记已读，可以打开该会话的 Monitor 详情，查看「返回原窗口」旁的状态说明。除了最近一次系统通知判断，程序现在还显示**最近 10 分钟内会话到 Windows 窗口的关联检查原因**：例如来源类型未识别、日志里缺少带时间戳的用户提交、提交超过 45 秒、原生监听晚于本次提交、扫描时钟不一致、提交时前台不是预期的应用、或已成功绑定。所有诊断都只记录短枚举原因，不输出或持久化提示词、标题、窗口标题、命令行和 HWND/PID。

这是一项区分问题层级的本机诊断：如果日志缺少提问/输入时间，不能靠调整 Windows 焦点算法解决；如果原生监听没有产生可靠样本，也不能靠频繁重试 JSONL 解析解决。原生监听失败时仍正常弹出通知，不会悄悄清除未读。

## 已保存窗口绑定的原生核验（2026-10）

此前的前台判断存在一个共同拦截问题：虽然 Monitor 能从 `window-bindings.json` 恢复会话原窗口，但本次启动中所有恢复的会话均标记为 `restored-unverified`，**直到用户重新发送消息**才允许系统通知免弹窗和自动已读。因此 Monitor 更新或重启之后，仍在执行的已有 Codex 任务通常两项功能都无法生效。

现在恢复绑定仅作为「待核验」状态。Windows 原生前台观察器一旦提供 **8 秒内**当前 HWND、PID、进程启动时间和应用类型的完整匹配样本，就可以确认此前已保存窗口属于同一仍活跃的进程，**不必再次输入新消息**。核验成功后沿用原有的单会话/多标签/多聊天判定：单一明确会话可抑制弹窗并自动确认未读，同一 VS Code 窗口绑定多个会话时仅允许证据充分的最新交互会话免弹窗，仍不得通过此推断自动清空未读；未知窗口、窗口或进程已变化、原生观察器掉线时始终正常弹窗且不自动已读。

这里的核验只证明「与原来的窗口属于同一进程实例」，不能证明 VS Code 当前选中了哪个聊天对话。没有持久化窗口绑定、或最近用户输入晚于原生观察器启动但仍未被成功关联的会话，依旧需要可靠的会话关联证据，不能仅凭编辑器在前台就全部静音。

## 打开原 Codex 会话自动标记已读（2026-10）

现有主窗口、悬浮窗的「返回原窗口」和系统通知点击流程维持不变。本轮增加 Windows 原生前台窗口事件驱动的自动已读：当用户用鼠标或 Alt+Tab **实际打开此前已可靠关联的 Codex 会话窗口**，Monitor 自动将该会话当前已存在的所有未读事件标为已读，更新主窗口、悬浮窗和托盘计数。其他会话、数据源采集故障/恢复提醒均不受影响。重复前台事件没有新未读时不触发状态更新，也不会主动读取聊天、审批或改变 Codex 运行状态。

**识别边界：** 沿用严格的 HWND + PID + 进程启动时间与会话绑定，必须有健康的原生监听及近 8 秒的前台证据。多标签终端**必须由当前**的 UIA/MSAA 已选标签与原标签身份相等；同一 VS Code / Desktop 窗口绑定多个会话时，没有精确对话 ID 则不自动标记；历史持久化窗口绑定在被新用户输入确认前也不能自动标记。以上情形仍可使用明确的「标记已读」按钮。

通过系统通知打开原会话后，如果成功聚焦到已验证目标，或系统接受官方 Codex Desktop 会话深链，还会自动确认该会话的其他未读事件。只打开 Monitor 自身的会话详情不代表原 Codex 会话已被查看，因此不自动清空未读。

## 前台 Codex 会话免弹窗（2026-10）

**只抑制当前真正匹配前台窗口的那个 Codex 会话的 Windows 原生通知**。Monitor 的事件收件箱、未读计数、原有事件类型开关、全局静音、正在执行的远程/其他窗口会话均保持不变。来源采集异常与恢复不是某个会话的事件，仍正常通知。

复用现有只读 Windows WinEvent 前台观察器与发送消息时建立的会话→HWND/PID/进程启动时间绑定，无新进程、无截图/窗口标题/提示词读取。前台原生采样必须在 **8 秒**内有效，VS Code/Codex Desktop 只补充最多每 5 秒一次的轻量前台确认；监听中断、进程/窗口身份变化、未曾在当前进程中验证的历史绑定，都**不抑制**通知。

- **单窗口且唯一绑定**：同一会话的原窗口确实在前台时，该会话不弹 OS 通知；其他窗口里的会话仍弹。
- **多标签终端**：必须有原生可辨认的已选标签身份且与会话精确一致才免弹窗，未知标签继续通知。
- **同一 VS Code 窗口内多个已知会话**：仅在用户提交消息时已建立可靠的会话→HWND 绑定、当前仍为相同的前台窗口，并且最新提交距离此刻不超过 60 分钟、且比窗口内其他会话的提交明显更新（超过 2 秒）时，为**最近实际交互的那个会话**抑制系统弹窗。其他绑定到该窗口的会话照常通知。这是带证据的最佳努力，不是直接读取 VS Code 当前选中聊天面板；若近期没有唯一交互线索则照常弹窗。
- **Codex Desktop 多会话或 VS Code 多会话的自动已读**：仍保持严格，无法确认精确选中对话时不会自动标记已读；**弹窗抑制**与**已读确认**的可信门槛不同。尚未建立绑定的会话亦继续正常通知。
- **可核查诊断**：若某个会话仍收到不应弹出的通知，打开 Monitor 中该会话的详情，查看「返回原窗口」旁的状态说明。它会显示最近 15 分钟内最后一次系统弹窗判定原因（例如「未找到原窗口绑定」「最近用户输入匹配」「最近输入证据已过期」「其他会话的输入更新」）；不记录标题、问题正文或窗口命令行，且不对 Codex 执行任何操作。
- **边界**：同一 VS Code 窗口中，用户只靠鼠标切换不同聊天面板、却没有提交新消息时，系统仍无法知道当前选中哪一轮对话；最近交互线索可能与可见聊天面板不同。此时弹窗抑制仅为最佳努力，不得依此清除未读。若需要精确、持续区分多个聊天面板，需要 VS Code 扩展提供可访问的活动对话身份，而不是仅依赖 Windows HWND。

## 按事件类型选择通知（2026-10）

主窗口右上角 **常驻设置 → 需要通知的情况** 可以分别开关六类事件：
「需要回答或确认」「本轮执行失败」「本轮回复结束」「本轮已中断」
「数据源采集异常」「数据源恢复」。首次安装或从旧版本升级默认全部开启，延续旧版行为。
变更立即应用于后台 Monitor，也同步到主窗口、悬浮窗和托盘的未读数量。

**关闭某类通知的含义：** 新事件仍在只读事件收件箱/事件轨迹中记录，但自动标记已读，
不会弹 Windows 系统通知，也不会增加未读数字；关闭时该类型已有未读一并标记已读。
重新开启只通知之后新观察到的事件，不补发此前忽略的事件。原有「系统通知静音」
不变：静音仅禁止系统弹窗，仍保留未读提醒。两个设置彼此独立。
通知规则随既有 `alert-state.json` 原子保存，只保留六个布尔值，不保存原始对话与凭据。

## 失败轮次与数据源故障提醒（2026-10）

- **Codex 执行失败**：只有持久化的 `turn_complete` / `task_complete` 带有非空 `error` 字段，才属于「本轮失败」提醒；用户主动取消的 `turn_aborted` 继续作为「中断」提醒。Windows/WSL/SSH 的日志解析会保留最近至多 32 个失败事件指纹，即使后续轮次已开始也能独立去重，不记录错误内容、工具正文或提示词。子代理失败默认不通知，历史会话首次扫描不补发。
- **来源异常与恢复**：仅对实际采集出错的 Windows/WSL/SSH 数据源计时；监听器暂时处于 `connecting` / `fallback`、但元数据采集仍正常时不认为数据源失联。连续至少两次失败、持续达到 30 秒后才发一次「数据源采集异常」；真正恢复成功采集时仅对已提醒的故障发一次「数据源已恢复」。短暂抖动不产生通知。
- **系统通知交互**：来源提醒的弹窗、主窗口收件箱、事件轨迹和悬浮窗均可使用，点击来源提醒打开该来源范围的 Monitor 看板，**不尝试定位不存在的 Codex 会话**。原生弹窗的标记已读、全局静音和既有任务提醒规则继续沿用。
- **持久化边界**：故障是否已提醒的状态与来源 ID 一起以受限元数据形式保留，重启不会对持续故障反复弹窗；只读、不存储连接错误详情、SSH 凭据或对话内容。删除来源不会伪造恢复提醒。真实 Windows 系统通知和断线操作仍需实机验收。

## 会话中断和断线恢复（2026-10）

- **独立中断事件**：Windows、WSL、SSH 的有限 JSONL 读取区间会保留最多 32 个中断事件指纹。即使中断之后立刻开始新轮次，Monitor 仍能对本轮扫描中新观察到的中断逐一去重提醒。首次扫描不会追发历史中断，旧时间戳/子代理中断不触发系统通知。
- **各来源完成后立即更新**：一个来源读取完成就可派发自身的提醒，不必等待其他 SSH 主机返回或超时；全量完成后仍统一来源顺序和事件通道健康检查。
- **短暂断线**：保留最近 24 小时内该来源最后一次成功采集的会话元数据，并明确标记为过期；执行中、待处理改为未知，异步待回答标记清空，不将旧证据当作当前运行状态。之前确认执行中的会话定位信息继续用于远程恢复后的定向重查。删除来源或超过保留时限后清除旧缓存。
- 以上变更仍然**只读**，不订阅未授权的进程、也不保存消息正文；Windows / Ubuntu CI 验证的是模拟回归，不取代 Windows 上的原生弹窗与多来源实机验收。

## 悬浮窗执行中角标短时闪烁修复（2026-10）

监控悬浮窗的「可能执行中」数字由后端会话状态决定，并非独立轮询进程。在连续执行期间，局部 JSONL 更新/轮换、扫描时序或来源中刚好缺少最新事件，可使一次健康采集的会话临时从「执行中」变成「未知」，从而让角标在 1 和空白之间切换。本轮在后端增加**仅用于显示的短时连续性保护**：

- 上一次采集确实已有「可能执行中」记录、本次来源采集**成功**但只是没有明确状态或暂时没有返回该会话，保留该父会话的「可能执行中 · 静默期延续」**最多 15 秒**，与原 3 秒来源事件扫描间隔配合。再次收到真实活动后才允许开始新的宽限期；连续未知不会续期。
- 任何明确的「本轮完成 / 失败 / 中断 / 待处理」、真实 Desktop 完成事件、子代理，以及 SSH/WSL 来源采集失败或失联，都不能被连续性保护覆盖。失联时原有状态立即变未知，诊断仍显示采集故障。仍遵守此前 8 分钟长静默证据规则，不把没有依据的长时间任务无限标为执行中。
- 最近 200 条窗口与最多 16 个历史执行会话的索引/限额不变；一个成功来源的单次结果临时漏掉此前执行会话时，至多短暂保留 16 个可定位的父会话。页面的状态原因会说明「最近已观察到执行中，但此次采集暂缺明确状态」；不会生成新完成提醒。
- 新增模拟 3 秒状态抖动、15 秒不续期、真实结束即时撤销、来源故障即时撤销、短暂丢失文件/会话、Desktop 原生结束强制优先的回归测试。仍不能凭本地日志推断所有超长静默任务实时存活；真实 Windows 多来源需要按相同会话做实机观察。

## 常驻性能复核：托盘、文件索引和渲染更新（2026-10）

本轮只降低**没有新的实质变化时**的原生调用、CPU 排序和 UI 派生计算，不改变 Codex 会话状态判断或真实通知时效：

- **Windows 托盘菜单**：监控状态、未读提醒和悬浮窗运动不会每次重建原生右键菜单；仅全局静音、悬浮可见性、不透明度和后台常驻选项发生变化时更新菜单。托盘提示文字也只在「可能执行中」「未读」数量变化时重新设置。菜单的快捷操作、全局静音和退出行为保持不变。
- **本地文件索引**：健康监听的增量轮次如果没有文件变更，就完全跳过 `realpath` 和全量排序；少量变更时只按文件路径重新定位排序，单次超过 32 个变更才整体重排。每 60 秒发现遗漏文件、监听故障退回全量扫描和最多 10,000 个候选的边界不变。诊断额外记录 `sortRebuilds`，可用断言确认空扫描及单文件更新不重排历史文件。
- **渲染状态版本**：监控主进程只在来源快照发生替换、全量来源排序完成，或 Desktop 投影状态确实变化时递增 `scanRevision`。提醒已读、按类型开关、静音和观察通道健康变化不会迫使主窗口/悬浮窗重新筛选、排序全部会话；迟到的旧状态不会覆盖已收到的新版扫描。
- **Desktop 证据投影**：没有匹配 Desktop 原生事件、也没有待诊断 Desktop 会话的来源直接复用原始会话对象，不再在每次日志审计时复制无关 CLI/WSL/SSH 会话。
- CI 有确定性回归检查，包括 125 次不变的托盘刷新、空增量扫描与单文件变更不增加全量排序次数、IPC 提醒更新保持会话快照引用、以及有真实 Desktop 证据时仍正常更新状态。未宣称 CI 即是用户 Windows 电脑上的 CPU / 内存实测，实际降幅仍应在同一组多来源运行负载下比较。

## 增量索引、来源时间与性能诊断（2026-10）

- **本地增量索引**：Windows 的 `fs.watch` 健康、且此次为事件触发的单来源刷新时，按受限 `YYYY/MM/DD/*.jsonl` 文件路径更新元数据索引；无需每次重新枚举和 stat 全部历史会话文件。目录变化、路径缺失/异常、超过 60 秒，或手动/周期性全量扫描时仍重新发现全部候选文件。原有每源最多 10,000 个候选、200 条常规会话及最多 16 条已固定会话限制保持不变。通过 `lstat` 和根目录内的 `realpath` 校验拒绝监听路径及父目录的越界符号链接。
- **WSL/SSH 仍使用原有有界远程采集**：远程 watcher 只返回来源发生变化的信号，不回传 JSONL 路径；不会把 Windows 本地文件索引误当成远程也已增量化。
- **来源时钟统一**：UI 使用每个来源的 `capturedAt - ageAtSourceMs` 推导本机时间线，统一排序、近七天过滤、相对时间、最近完成与详情展示；原始采集记录、通知指纹及窗口绑定不被修改。缺乏可靠来源时间的旧记录退回原时间值。
- **性能诊断**：主界面页脚常驻显示批次扫描耗时、本地增量/全量与 stat 次数，悬停可查看各来源耗时、会话数、索引文件数、缓存命中及重新解析量。可用时另外显示最近最多 128 条带有效持久化事件时间戳的“事件到 Monitor 发现”延迟 P95（含样本数）。这**不是 Windows 系统通知实际弹出的精确延迟**，没有有效源时间戳的事件不参与计算。
- CI 覆盖跨机器时钟偏移、局部来源刷新、事件新增/删除、遗漏事件定期重扫、监听断线全量回退、缓存复用、原生中断通知标题和性能指标计算。整机长期性能及真实 Windows GUI 行为仍需实机验证。

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

## Codex App Server 原生事件探索（只读探测原型）

该工具是**独立命令行实验**，不会改变当前 Monitor 的窗口、通知或会话采集行为，也不会调用 Codex 的模型、自动启动 App Server 或接管原有会话。

第一步验证的是真实会话是否位于**同一个已经运行的共享 App Server**：

```powershell
npm install
npm run probe:app-server -- --duration 20 --poll-ms 2000 --max-threads 15
```

默认只尝试连接 `CODEX_HOME/app-server-control/app-server-control.sock`（若未设置 `CODEX_HOME`，使用用户目录的 `.codex`）。服务器不存在或没有打开共享控制套接字时，会显示 `no_existing_control_socket`，**绝不启动一个新 Codex 进程冒充成功**。

也可以明确指定已存在的地址：

```powershell
npm run probe:app-server -- --socket "C:\Users\YourUser\.codex\app-server-control\app-server-control.sock"
npm run probe:app-server -- --ws ws://127.0.0.1:17891/
```

以上端点必须是你已经确认的服务。对于已有 SSH 主机上的共享 Unix 套接字，可先使用本机 OpenSSH 建立**仅回环访问**的转发，然后通过 `--ws ws://127.0.0.1:17891/` 读取；不要把无鉴权的 WebSocket 直接暴露到公网或局域网：

```powershell
# 在单独的 PowerShell 窗口保持转发，替换为真实 SSH 主机别名及 Linux HOME：
ssh -N -L 127.0.0.1:17891:/home/user/.codex/app-server-control/app-server-control.sock my-ssh-host
```

支持 `--duration 0`（只做一次查询）、`--show-ids`（输出完整会话 ID，用于和 Monitor 比对）、`--json`（只包含状态/事件类型的 JSONL 诊断输出）。默认仅显示截短的会话 ID、`activeFlags`、是否子代理及事件类型；**不打印完整对话、目录路径、提问正文、工具输出、访问令牌和推理内容**。

本工具严格将客户端请求限制为 `initialize`、`thread/loaded/list`、`thread/read(includeTurns:false)`，不发送 `thread/resume`、`turn/start`、`thread/unsubscribe` 或任何审批回答。遇到服务端发来的审批/提问请求时只记录其类型，**不会向 Codex 发送回答或批准**。不进行实时会话订阅，因此原型通过周期性只读快照检验 `waitingOnUserInput` / `waitingOnApproval` 等原生状态；收到恰好对本连接可见的事件时记录有限的事件类型。

**如何判断结果：** 显示 `connected` 只说明连接到一个现有 App Server；`loadedCount > 0` 只能说明**这个服务**管理这些会话，并不代表所有 VS Code、Desktop 或独立 CLI 进程均可见。只有通过 `--show-ids` 将已加载会话的真实 ID 与你的 Codex 会话对应起来，才能验证覆盖范围。没有匹配会话时，继续保留 JSONL 监控即可，不必改动正在执行的 Codex。

**分页与指定会话（防止漏检）：** `thread/loaded/list` 以线程 ID 升序分页返回；默认 `--max-threads 15` 选择列表末尾的 15 个 ID（通常是较新创建的会话，**并不等同于最近活动**）。探测器最多扫描 50 页、每页 100 个 ID，并在输出中区分已观察总数、被选会话数和列表是否完整。对于较早创建但仍活跃的会话，应直接从 Monitor 复制完整 thread ID（UUID），运行：

```powershell
npm run probe:app-server -- --duration 20 --thread-id "真实会话UUID" --show-ids
```

`targetLoaded: false` 且 `listComplete: true` 说明**当前连接的 App Server** 未加载目标线程，并非该线程不存在。若列表不完整，不可将未发现的 ID 判定为不在服务内。所有查询保持只读。

**协议版本提醒：** 较早版本 Codex 的 Unix Socket 曾使用无需 HTTP Upgrade 的 WebSocket 帧，而当前源码使用标准 HTTP Upgrade 握手；若套接字存在但连接失败，应先核对实际 CLI 版本及启动方式，不要自动启动新服务或把握手错误当作会话已结束。

运行 `npm run test:probe` 可以在不连接真实账号/会话的前提下，用模拟 App Server 验证 WebSocket/JSON-RPC、状态 flags、批准请求绝不代答等行为。**下一阶段**在独立测试服务上验证 `thread/resume` 的第二客户端订阅、审批请求分发与断线回退后，才考虑可选地接入正式 Monitor。不可用独立进程假装共享所有已有会话。

## Desktop 历史启动状态误判修复（2026-10）

- **补齐原生结束证据**：除了 `[desktop-notifications] show turn-complete`，只读解析器现在也识别带有准确 `conversationId` 与 `turnId` 的 `[desktop-notifications] received turn-complete`。部分 Desktop 版本只记录接收完成，不会记录显示系统通知；两种记录对应同一个真实结束事件，不会重复生成完成提醒。
- **取消超长启动推断**：`turn/start` 请求被接受，仅证明当时启动了轮次，不是实时执行状态。最多在与原有日志活动连续性相同的 **8 分钟无新活动宽限范围内**，才将来源状态未知暂时投影成「可能执行中」；旧启动记录仍保留最多 72 小时以保证新旧事件排序，但不会独立导致长期「执行中」误报。已经有可靠 JSONL 增长证据的任务，仍按原有扫描与活动延续判断，不会凭静默推断任务完成。
- **新用户输入的优先级**：如来源自身的时间年龄和采集起始界限能够证明出现了晚于 Desktop 原生启动的新提交消息，先前启动事件不再把该轮重新判成执行中。适用于跨 SSH/WSL 时钟偏移，且不采用远程系统绝对时间进行比较。
- **当前边界**：没有可信结束事件时，超出宽限后展示「状态未知」，**不是**「本轮完成」。Monitor 仍不接管私有 App Server；只有真实会话结束证据才能发完成通知。

## Codex Desktop 状态追踪边界与修复

Desktop 使用的 App Server 可能运行于**独立 stdio 进程**，现有 Monitor 默认读取的是只读 JSONL 与少量 SQLite 元数据，并没有订阅该 Desktop 进程的实时 JSON-RPC 事件。因此仅凭任务日志，不能承诺 100% 捕获运行中、等待审批或等待用户输入；单独连接新的 App Server 并不能观察 Desktop 私有服务里的活动线程。

已改善的落盘解析：

- 从 `session_meta.originator` 和只读 `state_5.sqlite.threads.originator` 识别 `codex_desktop`（也兼容 `Codex Desktop`），不靠窗口标题或工作目录猜测客户端。
- 兼容分页型 `item_completed.UserMessage`、旧 `event_msg.user_message` 和 `response_item.message(role=user)`；一条新提交的用户消息可以撤销上轮的“已结束”状态，即便新的 turn/start 尚未落盘。
- 根据 `turn_id` 检查新旧轮次归属：**上一轮迟到的结束事件不得终止下一轮**。旧版无 ID 的事件仅在不存在待核对的活动轮次时回退旧策略。
- 对尚未回应的**结构化异步提问**继续发等待提醒，但不再把状态标为“本轮已完成”；无法确认是否仍在执行时显示“未知”。普通助手文本里随口提出的问题不是可靠的机器可判定审批事件，不自动从标点猜测。
- 系统通知使用“**本轮回复已结束**”而非“任务完成”，因为 `task_complete` / `turn_complete` 只说明该 **turn** 结束，不代表长期任务、整段 Desktop 会话已完成。

**2026-10-12 新增 Windows Desktop 应用日志旁路：** 除 JSONL 之外，主监控现在会只读读取 Desktop 自己的应用日志，查找成功的 `[AppServerConnection] response_routed method=turn/start errorCode=null conversationId=<uuid>` 和明确的 `[desktop-notifications] show turn-complete` 事件。扫描同时支持 `%LOCALAPPDATA%\Codex\Logs\YYYY\MM\DD` 和 MSIX 包目录中的 `LocalCache\Local\Codex\Logs`。严格按已有本地 Desktop 会话 UUID 关联，忽略 `Received turn/started|completed for unknown conversation` 等错误日志；不会读取日志内容作为聊天文本，也不会导出其它字段。

当 Desktop 日志确认该会话新的 `turn/start` 成功、且没有后续明确结束证据时，在有限时间窗口内显示“可能执行中”。相反，持久化的本轮结束事件如果更晚，仍优先判定为结束；日志不全时不根据静默倒推出完成。现在改为每 **4 秒**单独读取 Windows Desktop 的有限量日志摘要，以准确 UUID 补充**任意创建来源**（Desktop、VS Code 或 CLI）的已有本地、WSL、SSH 会话；不再因为一次新状态就重新扫描所有远程文件系统。GUI 日志里存在 `turn/start` 才能临时补足执行中的证据，更晚的完成事件会撤销它；来源元数据仍保持原始值，不假装创建来源等于当前执行客户端。Desktop 日志写入变化也会触发本地文件事件检查。远程会话只按准确 UUID 关联，不通过标题或工作目录猜测。会话详情的「状态判断依据」会标明是有匹配事件，还是日志缺失、格式不受支持、会话 ID 不匹配。

**Monitor 重启后的 Desktop 状态回归修复：** Desktop GUI 已明确报告过的会话生命周期信号，会以最小字段集保存到 Electron 用户数据目录的 `desktop-runtime-evidence.json`（最多 200 条，只含 UUID、`turn-start-accepted` 或 `turn-displayed-complete`、事件时间和可选 turn UUID）。此前这部分状态只在内存中，一旦重启 Monitor，Desktop 的 `turn/start` 若已滚出最近 320 KiB 日志尾部，就失去依据。新版本会在重新启动时校验并加载最多 **72 小时**的已保存事件用于生命周期排序；但只有近 **8 分钟**内、没有明确终止证据的启动响应，才会临时补充「可能执行中」。出现更晚的 Desktop 完成记录会覆盖旧开始。若旧 JSONL 结束事件没有有效时间戳，只有在来源文件最后写入时间**可以证明早于新的 Desktop 开始事件**时才判为“可能执行中”；时间来源不可信时仍保留原状态。所有这些记录都是只读观察的派生信息，不包含终端内容、任务文本、文件路径或账户凭证。

**能力边界：** Desktop 的私有 stdio App Server 仍未向 Monitor 开放可靠的只读状态订阅。本功能不保证捕获后台所有会话，更不保证有 `waitingOnApproval` / `waitingOnUserInput` 的完整实时状态，不能据此称“100% 追踪”。如果 Desktop 应用日志不记载某个轮次、从其它客户端发起任务、仅显示云端远程任务或日志与 JSONL 使用不同的会话 ID，当前仍可能未知。未验证前**不调用** `thread/resume`、`turn/start`、审批回答，也不会启动新服务去冒充 Desktop。


### 同时定位 Desktop 执行漏检和 MobaXterm 标签问题

从 Windows 项目根目录运行 **一条命令**（若有持续运行任务，建议在它开始后运行）：

```powershell
npm run diagnose:tracking -- --duration 15
```

该命令和正式监控**共用同一套有边界的日志发现器**：检测普通安装目录、Microsoft Store 包的 `LocalCache`、部分 Roaming 日志目录，输出各类目录是否存在、日志文件数量、最近候选数量及明确的 `discovery.reason`。`no_known_log_root`、`log_filename_not_matched`、`no_recent_log_candidates` 与 `readable_log_files` 表示不同问题；这些统计不包含真实文件路径。随后它会筛除 MobaXterm 的辅助/工具窗口，对真正的主窗口逐个只读采样，报告 `mainCandidates`、`visibleProcessWindows` 和每个候选的 `uiaTabItems`、`msaaGroups`、`msaaSelected`、`msaaDuplicateNames`、`nativeTabLikeChildren`。多个主窗口不会自动挑选一个，更不会向 SSH 会话写入命令。全部输出不包含会话 UUID、SSH 主机名、标签名称、原始日志、命令或对话正文。

如果 Desktop 完成时能通知，但运行时没有活动卡片，可优先核对 `desktop.events.acceptedStart`、`desktop.events.turnCompleteNotice`、`desktop.filesExamined`；如需确认某一个会话是否命中，可额外用 `--thread-id UUID` 仅筛选该会话，仍不会输出 UUID 原值。零计数不代表没有运行：也可能是 Desktop App Server 的私有内存事件未写入本地应用日志。

MobaXterm 标签选择仍要求“已确认唯一身份”。原生选择新增 MSAA 简单子元素兼容、选中与获得焦点组合尝试、标签默认动作后验校验；仅当前后选中标签身份一致时才算成功。若 `identified=false` 或某一主窗口候选 `reason` 为辅助功能未暴露控件，仍需该版本的只读诊断结果来开发精确定位，不使用盲目的 Ctrl+Tab 轮切。

### Codex Desktop 可选只读日志探测

`logs_2.sqlite` 可能包含 Desktop 私有 App Server 的部分请求或运行事件，但格式会随版本变化，而且包含大量敏感诊断信息。**本探测器不会接入正式状态/通知判断，也不会打印日志正文。** 它仅查询 `CODEX_HOME/logs_2.sqlite` 中带有目标 `thread_id` 的最多 500 条近期记录，输出可能出现的事件类型及计数。

```powershell
npm run probe:desktop-logs -- --thread-id "真实会话UUID" --duration 20
```

程序只读打开已存在的 SQLite DB，不修改数据库、创建索引或启动新的 Codex；即使出现 `turn/completed` 或 `waitingOnUserInput` 字样也**只是候选证据**，必须在真实 Desktop 版本上核对进程来源、事件时序和误命中，才能将其作为可靠状态输入。缺少命中不代表没有运行中的任务。高频 TRACE 日志会被自动省略（不打印）。

## Codex Desktop 按会话跳转（官方协议）

Codex 官方 TUI 提供 `codex://threads/<UUID>` 的「在 Desktop 中打开线程」跳转方式。Monitor 的「返回原窗口」、悬浮窗任务点击以及通知点击，对 `clientKind=desktop` 或已被 Desktop 应用日志按 UUID 确认过的会话，优先调用 Electron `shell.openExternal` 交给 Codex Desktop 打开**准确的会话**，无需等待 HWND/PID 自动绑定；普通 VS Code 和终端任务依旧使用之前的原窗口身份校验及持久化关联。

协议打开结果表示已**交给操作系统处理**，而非能够证明 Desktop 已显示该会话。因此结果明确区分 `opened` 和 `focused`，避免承诺已经切换完成。没有安装 Desktop 或系统未注册 `codex://` 时，只有已知有效 HWND 绑定才会回退原窗口；否则向用户提示检查协议关联。仅接受严格 UUID，不打开任意来自扫描数据的链接；不自动启动模型任务，也不篡改 Desktop App Server。

## 持久化原窗口绑定与 MobaXterm 标签定位（实验性）

- 原窗口与会话关联现在写入 Electron 用户数据目录的 `window-bindings.json`（最多 200 条，只保存 `sourceId:threadId`、HWND、PID、进程启动时间、输入事件时间与可选标签 ID，不保存会话正文、登录信息或 SSH 密钥）。写入采用临时文件 + 原子重命名；退出时刷新。已持久化的关联**不需要下一次提问才能恢复**，前提是 Codex/VS Code/MobaXterm 原窗口在 Monitor 重启期间仍然存活。
- 重新启动 Monitor 后会加载已保存的关联，但**不会盲信旧句柄**。用户点击跳转时再次校验 `IsWindow`、拥有者 PID、进程创建时间及目标是否可见。窗口已关闭、客户端已重启、句柄已更换时，不会跳到另一窗口；记录会自动失效，新的输入会重新学习。仅重启 Monitor 能恢复，重启整个 Windows 或目标客户端不保证恢复旧窗口。
- MobaXterm 增加专用 MSAA 可访问性后备：普通 UI Automation 找不到唯一 `TabItem` 时，探测原生的 `ROLE_SYSTEM_PAGETAB`、`STATE_SYSTEM_SELECTED`，并以**窗口作用域内的 SHA-256 截断指纹**区分标签。UIA 和 MSAA 的标签标识不可混用；切换后的确认现在强制复用原来绑定的识别接口。仅当 UIA 已发现唯一标签，但 `SelectionItem.Select()` 无效时，才尝试该标签控件支持的 `InvokePattern`；MSAA 则仅对严格识别的标签尝试其默认切换动作，并重新核验。标签标题只在独立 Windows 原生组件内临时读取以计算指纹，**不回传、不写入原始标题**。只有单一标签组、名称唯一、切换后重新读取确认同一标签时，才报告“定位到原标签”。名称重复、标签被移除或辅助功能接口不暴露标签时仍只返回 MobaXterm 主窗口，不使用易变序号或发送热键。
- **只读探测标签支持性：** 保持一个 MobaXterm 主窗口可见（无需使它获得焦点），从项目根目录执行
  `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\collector\window-tracker.ps1 -Mode inspect-tabs`。
  输出仅包含 `identified`、`count`、`provider`（`uia`/`msaa`/`none`），不输出 SSH 主机名、标签名或终端内容。该探测仅帮助判断现有版本 MobaXterm 是否向 Windows 暴露可选择的标签；**尚未在用户真实桌面上验证，不能保证所有 MobaXterm 版本都可精确跳转。**

## 自动返回原窗口与多标签（Windows 实验版）

主窗口详情里的「返回原窗口」、悬浮窗任务点击和 Windows 原生通知点击，优先返回**原来运行 Codex 的窗口**；无法确认时回到 Monitor 会话详情，不创建新终端、新 Codex 会话，也不调用 resume、审批或用户输入。

**自动绑定，不要求手动操作：**

1. `collector/window-tracker.ps1` 通过 `SetWinEventHook` 观察前台窗口、焦点和选择变化，只返回窗口句柄、进程 ID、进程启动时间、时间戳和有限的客户端类别，不采集窗口标题、键盘输入、命令或屏幕内容。
2. Windows/WSL/SSH 的原有只读 JSONL 扫描只提取客户端 originator 和最近真实用户输入的时间戳（不回传消息正文），结合前台观察记录关联 `sourceId + threadId`。远程扫描根据源机器时钟计算事件年龄，并检查扫描时间区间内是否曾切换其他窗口或标签，避免误认。
3. Windows Terminal、MobaXterm 等终端宿主在**处于前台**时每约 1.1 秒通过 Windows UI Automation 读取可访问的 `TabItem` 选择状态，另利用焦点和选择事件及时更新。不对所有窗口持续遍历，不读取标签标题。只保存当前会话期间的运行时标签标识（RuntimeId），不保存标签序号或标题。
4. 跳转先重新校验 HWND、PID、进程启动时间；若自动关联到唯一稳定的 RuntimeId，再通过 UI Automation `SelectionItemPattern.Select` 选择对应标签并验证。它不发送键盘指令、不会按固定序号盲切，也不会在目标标签消失时创建新标签。

**窗口尺寸保持不变：** 原窗口若处于最大化、普通窗口或非最小化的全屏状态，只调用 `SetForegroundWindow`，绝不再无条件执行 `SW_RESTORE`，因此不会因跳转而取消最大化或改变窗口尺寸。对于已最小化的窗口，才调用 `ShowWindow` 将其显示；如果 Windows 记录了「最小化前为最大化」状态，则恢复到最大化。Windows CI 的 `-Mode verify` 会检查这一状态选择策略，但真实全屏、跨桌面、多显示器的 GUI 行为仍需要实机回归。

**通知点击即已读：** 点击 Windows 系统通知正文、或悬浮窗「提醒收件箱」中的提醒条目时，立即将**该条提醒**标为已读，并继续尝试跳转原窗口；跳转失败、目标标签不可访问都不需要再点 ✓。为避免误清除无关任务，别的会话、之后新产生的提醒仍保持未读。「✓」按钮继续保留，供不想跳转时使用。在主看板直接点击「返回原窗口」不属于通知点击，仍按成功跳转策略确认对应会话的已存在提醒。

**可靠性回归：** 原生 UI Automation 的 RuntimeId 序列化曾产生错误的前导点，导致前台样本校验失败；现已修正并添加 Windows 原生回归。可访问性接口的同步枚举也可能阻塞整个前台事件循环；现改成异步、最多一个并行标签探测，在 UIA 卡住或不可用时仍持续采集可靠的 HWND/PID 证据。PowerShell 原生监听启动失败、意外退出会有限次自动重启；历史已确认的窗口身份仍可在跳转时重新校验。所有这些机制不修改窗口最大化或全屏尺寸。

**重要限制：** Monitor 启动之前的用户输入不能用于自动回溯窗口；旧会话可能需要在原客户端再提交一次新消息。对于多标签宿主，若 UI Automation 不暴露明确选中标签，或者同一窗口出现多个冲突的标签选择记录，最多返回原顶层窗口并保留提醒未读。VS Code 多窗口已有 HWND 级别定位，但扩展的内部对话、集成终端内的多个窗格、MobaXterm 的自绘 SSH 标签和 Windows Terminal 分屏尚不保证精确到每个子页面。不同客户端版本的 UIA 支持仍需要实机验证。

**临时停用：** 在启动应用前设置 `$env:CODEX_MONITOR_DISABLE_AUTO_WINDOW_TRACKING = "1"`，只关闭自动窗口关联，不影响 JSONL、WSL/SSH 监控或通知。Windows UI Automation 组件不可用时会降级为原来的窗口句柄监听；不会因此修改任何 Codex 配置。

**建议实机测试：** 在同一个 Windows Terminal 或 MobaXterm 窗口打开两个标签，在标签 A 提交一条 Codex 消息，切换到 B，再从 Monitor 点击 A 的「返回原窗口」。如果准确回到 A 并确认激活，A 的已有提醒应自动已读；如果只切回窗口、无法确认标签，应保留未读并给出提示。再测试两个不同的 VS Code 窗口，确认能够返回原窗口而不是另一个同进程窗口。CI 仅验证 Windows 原生代码编译及自动关联/去重模拟逻辑，不等于真实 GUI 测试通过。

## VS Code 提问漏检：持久化证据与只读诊断

Codex VS Code 扩展的提问不能全部从磁盘得知。Codex 上游 `rollout/src/policy.rs` 明确将实时 `RequestUserInput`、`RequestPermissions`、执行/文件变更审批等事件视为**不落盘**；只观察 `~/.codex/sessions/*.jsonl` 时不能保证发现这些请求。不要把日志静默、普通疑问句或刚刚发送的模型文本猜成一个可交互的阻塞式提问。

已落盘的结构化提问则继续支持，包括 `response_item.function_call(request_user_input)`，分页型 `event_msg.item_completed.AgentMessage`、传统 `event_msg.agent_message` 以及 `response_item.agent_message`（`delivery:"async"` 和非空 `questions`）；通过 call ID 或消息 ID 去重，用户回复或工具响应后清除。为降低长会话中请求挤出 192 KiB 日志尾部的漏检，最近有写入、仍属执行中或刚结束的 VS Code 会话，会对最多 8 个会话做一次至多 2 MiB 的只读尾部核验；未落盘的请求仍然不可能凭此恢复，WSL/SSH 保留同样的边界。

**若 VS Code 中确实显示了需要回答的提问，但 Monitor 未提醒**，在提问尚未回答时，于相同的 `CODEX_HOME` 环境执行：

```powershell
npm run diagnose:questions -- --thread-id <会话UUID>
```

远程 VS Code/WSL 请在拥有对应 `CODEX_HOME` 的机器上执行，或通过 `--home` 指定一个绝对的 Codex 根目录。命令仅从目标会话的本地 JSONL 读取最多 2 MiB 末尾及有限头部，返回 `pendingBlocking`、`pendingAsync`、`tailClipped` 与各事件计数；**不输出 UUID、会话路径、问题文字、工具参数或聊天内容**。若 `coverage=no-persisted-pending-evidence`，只能说明读取范围内没有可识别的持久化请求，不代表 VS Code 没有提出问题。下一阶段若追求准确覆盖未落盘审批，应验证访问该 VS Code 实例原有的 App Server 实时事件；新起的独立 App Server 无权替代它的实时状态。

## 问题 / 用户输入待回答提醒

Codex Monitor 现在除既有生命周期事件外，还解析**已持久化的提问证据**：

- **阻塞式问题：** 日志里的 `response_item.function_call` 请求 `request_user_input` / `request_permissions`，如果找不到同一 `call_id` 的 `function_call_output`，按「可能待处理」展示；匹配到工具回复、轮次结束或中断后清除。
- **异步问题：** 新版 Codex 写入 `item_completed.AgentMessage`（`delivery: "async"` 且包含 `questions`）时，即使模型仍继续执行或本轮正常结束，也能记录一条**等待回答**提醒。之后出现用户消息会清除待回答标记。
- 提醒包含当前会话标题与可提取的简短问题，仍然只通知新观察到的变化，不补发历史提醒；**子代理默认不产生完成或等待提醒**，仅主会话作为通知目标。
- 这仍是**日志支持范围内的检测**：当 Codex 仅发送没有落盘的 App Server 请求、或者只在普通助手回复里口头提问时，Monitor 仍无法可靠判定它在等待回答。这些情况需要订阅原会话所属 App Server 的实时请求或显式可选 Hooks，不能仅靠文件监听实现。

**直接标记已读：** 原生 Windows 通知增加「✓ 标记已读」按钮，直接调用 Monitor 的提醒确认，不打开收件箱、不回答问题也不触发工具审批。点击通知正文仍会打开对应会话。部分 Windows 开发模式或系统通知策略可能隐藏操作按钮；需在实际 Windows 通知中验证。**不依赖系统按钮的备选方式**：当悬浮窄条铃铛出现未读数字时，铃铛右下角会出现一个小 ✓，直接标记最新一条提醒已读，不必打开收件箱；原收件箱中的逐条 ✓ 继续保留。

## 屏幕边缘悬浮窗（方案 C）

启动应用时，主窗口和 **始终置顶的 55×276 px 边缘窄栏**会同时出现。悬浮窗不会接管或控制任何 Codex 会话。

- **绿色运行入口**：显示目前被保守推断为可能执行中的会话及数量。
- **铃铛入口**：新检测到的待处理/完成提醒，未读数量在窄栏上显示；可在面板中逐条标记已读。
- **完成入口**：最近 24 小时发生过结束事件的会话。
- 点击任务条目优先跳转原 Codex 窗口，无法定位时打开 Monitor 的会话详情。展开后的面板显示标题、来源和工作空间信息。
- 点击 C 标识并拖动，可将窗口吸附到屏幕左侧或右侧；展开面板始终朝屏幕内部展开。**点击悬浮窗外的其他应用/桌面时自动收起面板，保留窄栏、透明度和停靠位置**；也可以点击箭头手动收起。
- 悬浮窗底部可静音系统通知或隐藏窄栏。隐藏后从主窗口右上角的「显示悬浮窗」重新开启。
- **Ctrl+K** 仍可在主窗口聚焦搜索；关闭主窗口后悬浮窗仍继续监控，反之亦然。

**提醒行为：** Electron 主进程统一管理事件触发的扫描和自适应轮询，主窗口和悬浮窗共享结果，避免双重扫描。只在新观察到的状态变化发生时（例如可能运行中 → 本轮完成、或新出现等待证据）生成未读提醒；启动时不会对历史会话补发。重复轮次可根据持久化结束事件的时间与 turn id 去重。操作系统支持的情况下还会发出 Windows 系统通知；若系统禁用了通知，悬浮窗未读徽标仍有效。静音只关闭系统弹窗，不会丢弃悬浮窗收件箱的事件；静音与未读信息在本次应用运行期间保留，重启后不保留。

**子代理默认隐藏：** 根据 Codex `session_meta` 中 `source.subagent`、`thread_source`、`parent_thread_id`（含旧式数据）识别子代理。主看板、全部会话、执行位置统计和悬浮窗默认仅展示主代理；主窗口筛选栏提供「显示子代理」复选框，可随时临时查看，选项保存在本机视图偏好中。子代理仍在底层只读扫描数据中，但默认**不产生完成或等待提醒**，悬浮窗铃铛和计数也不显示子代理。若来源元数据缺失，不凭标题或目录猜测它是子代理，以免误隐藏正常会话。

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

- **全部会话:** single list with Codex session title (when available), full workspace path, source machine, status, and last activity. Subagents are hidden by default; use 「显示子代理」 in the filter bar to include them.
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
