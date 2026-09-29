# dy-live · 抖音关注直播桌面版

基于 **Electron + React + TypeScript** 的桌面应用（Windows / macOS），用于查看你抖音「关注」中**正在直播**的主播，并在应用内以**游客（未登录）身份**观看直播。支持视频直播、个人音频直播（电台）、语音厅等多种直播形态，未知类型有明确兜底提示。

> 仅供个人学习与研究使用，请遵守抖音平台相关条款，勿用于商业或批量抓取用途。

## 功能

- **扫码登录**：内嵌页面使用抖音 App 扫码登录，凭证仅保存在本机（Electron 会话目录），不上传任何服务器。
- **关注直播列表**：聚合「关注」中正在直播的主播；滚动到底部才加载下一页（懒加载）；默认每 5 分钟自动刷新（可设 3/5/10/15 分钟，带随机抖动），刷新覆盖已加载页数。
- **游客态观看**：右侧加载直播画面与声音。直播流请求走独立的**未登录会话**（独立 Cookie 分区），与你的账号完全隔离。
- **多直播类型**：FLV / HLS 流自动选择（FLV 优先低延迟）；纯音频流（电台、语音厅）自动切换为音频界面（封面 + 律动动画）；未知类型出现「暂不支持」兜底提示 + 可在浏览器打开 + 诊断信息。
- **下播处理**：检测到下播后，画面**定格在最后一帧并模糊**，显示「直播已结束」；若主播随后重新开播，会自动重连。
- **播放控制**：底部控制栏含 播放/暂停、刷新、音量、在浏览器打开、**窗口最大化**、**全屏**；快捷键：`空格/K` 播放暂停、`F` 全屏、`M` 静音。
- **本地持久化**：登录态 Cookie、设置（刷新间隔/音量）、列表缓存、窗口位置均保存在本地，重启即恢复。
- **风控友好**：所有请求经过串行队列节流 + 失败指数退避（详见下文），单房间状态轮询 60s 一次。

## 快速开始

```bash
# Node >= 18（推荐 20+）
npm install        # 已配置 npmmirror 的 Electron 镜像，国内网络可用
npm run dev        # 开发模式（热更新）
```

生产构建与打包：

```bash
npm run typecheck  # 类型检查
npm run build      # 产出 out/
npm run smoke      # 构建后无头冒烟启动（验证装配，4 秒自动退出）
npm run dist:win   # Windows 安装包（release/ 目录，NSIS）
npm run dist:mac   # macOS dmg（建议在 macOS 机器上执行）
```

> 自定义图标：放置 `build/icon.ico`（Windows）与 `build/icon.icns`（macOS）后重新打包。

## 使用说明

1. 启动后进入登录页：点击页面内右上角「登录」，用抖音 App 扫码（如出现滑块验证请在页面内完成）。
2. 登录成功后自动进入主界面，左侧为正在直播的关注列表（含封面、标题、观看人数）。
3. 点击任意主播，右侧以游客身份加载直播：视频直播直接显示画面；音频/语音厅显示音频界面。
4. 列表滚动到底自动加载更多；顶部按钮可手动刷新（30 秒内限一次）；齿轮菜单可调整自动刷新间隔或退出登录。

## 架构

```
src/
├─ main/                     # Electron 主进程
│  ├─ index.ts               # 入口：装配各服务、单实例、冒烟模式
│  ├─ windows.ts             # 主窗口（位置持久化、CSP、webview 白名单）
│  ├─ store.ts               # 本地 JSON 持久化（原子写 + 防抖）
│  ├─ ipc.ts                 # IPC 注册（含设置白名单校验、外链白名单）
│  └─ douyin/
│     ├─ sessions.ts         # 会话管理：登录态隐藏页(www) + 游客隐藏页(live)、登录检测、页面内 fetch
│     ├─ api.ts              # 抖音接口适配（★ 字段变更时改这里）
│     ├─ queue.ts            # 串行节流队列 + 指数退避
│     ├─ liveList.ts         # 列表分页/合并/自动刷新调度
│     └─ roomWatcher.ts      # 活跃房间 60s 轮询（下播检测/人数/流续期）
├─ preload/index.ts          # contextBridge 安全桥
├─ renderer/                 # React 界面
│  └─ src/
│     ├─ App.tsx             # 登录态路由 + 主布局（列表状态管理）
│     ├─ lib/player.ts       # 播放引擎（mpegts.js FLV / hls.js HLS，卡顿看护、延迟追赶）
│     └─ components/         # LoginGate / Sidebar / PlayerPane / Icons
└─ shared/                   # 主/渲染共享类型与 IPC 通道定义
```

### 关键设计

| 需求 | 实现 |
| --- | --- |
| 登录后的列表接口签名（a_bogus） | 隐藏 BrowserWindow 加载 `www.douyin.com`，在**页面上下文**内调用其自带签名函数 `window._webmsxyw` 后 `fetch`，环境/指纹/Cookie 与真实浏览器一致 |
| 游客态加载直播 | 独立 `guest` 会话分区的隐藏页加载 `live.douyin.com`（获取 ttwid 等），在页面内请求 `webcast/room/web/enter` 拿流地址，全程不带登录 Cookie；播放器直连 CDN 拉流 |
| 流地址提取 | 对 `stream_url` 做通用扫描（任意层级中的 `.flv`/`.m3u8`/带 `wsSecret` 的地址），按 FLV 优先、高清优先排序，兼容语音厅/音频等不同返回结构 |
| 下播定格模糊 | 房间状态轮询 + 播放器 EOF 双通道检测；确认下播后 `video.pause()` 定格最后一帧，CSS `blur` + 覆盖「直播已结束」 |
| 类型兜底 | 拿不到流地址/未知状态 → 明确错误码 + 诊断信息 + 浏览器打开入口；音频流运行时用 `videoWidth===0` 自动识别 |

## 风控策略（请求频率）

| 请求 | 频率上限 |
| --- | --- |
| 列表页接口（`follow/live/list`） | 串行队列，相邻请求间隔 ≥3s + 抖动；自动刷新默认 5 分钟一次；单轮刷新最多 5 页 |
| 房间进入/状态（`webcast/room/web/enter`） | 串行队列，间隔 ≥2s + 抖动；仅对**当前观看的 1 个房间**每 60s 轮询 |
| 失败退避 | 连续失败按 1/2/4…分钟指数退避（上限 5 分钟），期间暂停自动刷新并在界面提示 |
| UA / 指纹 | 移除 UA 中的 Electron/App 痕迹；隐藏窗口禁加载媒体与字体 |

## 常见问题

- **登录页打不开/验证滑块**：webview 内完成滑块即可；网络慢时页面会自动重载一次。
- **列表为空但确认有人在直播**：多为接口字段/签名变更，见下方「接口维护」。
- **某个直播间提示「暂不支持」**：属于新直播形态的兜底提示，可点「浏览器打开」查看；欢迎把「诊断信息」内容反馈到适配层。
- **播放卡顿**：控制栏点「刷新」会重新进房并换流（FLV 失败自动降级 HLS）。

## 接口维护（抖音改版时）

所有抖音端点与解析集中在 `src/main/douyin/api.ts`：

- 列表端点：`/aweme/v1/web/follow/live/list/`（`fetchFollowLivePage`，返回字段解析在 `normalizeLiveEntry`）
- 进房端点：`live.douyin.com/webcast/room/web/enter/`（`guestRoomEnter`，流提取在 `extractStreams`）
- 签名依赖页面内 `window._webmsxyw`（`sessions.ts` 的 `__pageFetch`）；若失效，可考虑接入社区维护的 a_bogus 实现。

数据存储位置（卸载/重置时删除即可）：

- `Win: %APPDATA%/dy-live/`，`mac: ~/Library/Application Support/dy-live/`（含 `store.json` 与登录 Cookie）
