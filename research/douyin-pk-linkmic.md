# 抖音直播 PK/连麦「区分双方」机制研究报告

> 研究时间：2026-09-30 下午 · 环境：Windows 11 · 方法：网页实测（应用内浏览器打开连麦中房间）+ webpack 模块源码提取 + im/fetch 长轮询采样（5 分钟窗，2s 间隔，与 §8 研究纪律一致）。
> 样本房间：聊天分区连麦房间「老17」（web_rid 407162801048 / room_id 7691217470422371112，2w+ 在线，1 位嘉宾连麦中）。
> 仅供个人学习研究，请遵守平台条款。

---

## 0. 结论速览（TL;DR）

用户观察：「网页端能区分连麦双方，点击对方画面可跳转对应主播」。

| 问题 | 结论 |
| --- | --- |
| 双方画面是几路流？ | **合成后单路流**（WebRTC MediaStream，单 video track；本例 480x846@20fps）。不是每人一路轨 |
| 网页怎么知道每个人的区域？ | **流内 SEI**。播放器 SDK 解析 H.264 SEI（自定义 payload_type=100），内容是 UTF-8 JSON：`grids/mix_grids` 给出每个参与者的**归一化矩形 `{uid_str,x,y,w,h}`** |
| 网页怎么知道对方是谁？ | 三路合流：SEI 的 `uid_str`（连麦通道内部标识 `1_<hash>`）+ **`getPKList` HTTP 接口**（按 anchor_id 返回 `linkmic_id_str → sec_uid/昵称/头像` 映射）+ IM 连麦消息族（`LinkMicMethod` 等，生命周期/分数/身份） |
| 灰边哪来的？ | SEI 里明确写着：`canvas:{width:360,height:640,background:"#1F212C"}` —— 合成器画布就是 9:16，内容条按 grids 定位，灰边是**画布底色** |
| 网页如何利用空间（我们上一轮像素检测做的事） | PKSEIPlugin 用 SEI 矩形直接算视频元素的缩放/裁剪（`scale = min(clientH/videoH*videoW*scale/ clientW, 1)`），**不猜像素** |
| 兜底通道 | IM `BackupSEIMessage`（SEI 的 IM 备份）+ SSR 初始状态里同时有 `imLinkMicSeats` 与 `seiLinkMicSeats` 两套席位 |

---

## 1. 证据链与关键源码

### 1.1 播放器架构：WebRTC 单路合成流

实测连麦房间的 `<video>` 元素：

```
srcObject: MediaStream（非 MSE，无 appendBuffer）
  ├─ audio track（MediaStreamAudioDestinationNode —— 音频经 WebAudio 图转发）
  └─ video track ×1（480x846@20fps，合成流）
```

注意：**PC 网页当前走 WebRTC（`__aiolink__` = AIO Link Hub），FLV/HLS 路径仍存在**（SSR 下发 `flv_pull_url`，移动端/降级用）。两条路径的 SEI 机制相同。

### 1.2 SEI 插件：`PKSEIPlugin`（chunk `chunks/PKSEIPlugin.76e5060d.js`）

核心逻辑（还原）：

```js
player.on(EVENTS.SEI, (n) => {
  if (n.code !== 100) return                    // 只认自定义 SEI payload_type=100
  const text = new TextDecoder().decode(n.content)
  const v = KR(text)                            // 见 1.3
  if (v?.app_data) {
    const app = JSON.parse(v.app_data)          // app_data 本身是 JSON 字符串
    const crop = v?.live_crop                   // DOUBLE 时的裁剪带 {crop_y,crop_h,stride_h}
    if ([TG.DOUBLE, TG.MULTI].includes(app.ver)) {
      const layout = parseLayout(app, crop)     // → {channelId, ver, grids, isFocusMode, ...}
      if (changed) setPKAppData(layout)         // 写入 pkStore
    }
  }
})
```

布局解析（模块 123487 `q_`/`aK`，还原要点）：

- `ver=DOUBLE(2)`：`grids` 截取为 1 项（对方矩形），渲染时在 `left:0` **注入本房主播**（假设本方占左半）；有 `live_crop` 时用 `crop_y/stride_h`、`crop_h/stride_h` 覆盖 y/h。
- `ver=MULTI(6)`：≥4 人视为九宫格/十二宫格（`p.length===9 ? 3 : 2` 列），scale = `1/(gridH*列数)`；`anchor_interact_info.focus_id` 非零时为聚焦模式（FOCUS 优先排 `focus_id` 的 grid）。
- `mock_game_uid` 特判游戏连麦（gameClip/cameraClip 分段）。
- 输出的每个 grid：`{linkmicUid, muted, x, y, w, h}`（归一化 0..1）。

视频元素适配（模块 123487 `c`）：`scale = min(clientH/videoH * videoW * layoutScale / clientW, 1)` —— 用 SEI 矩形反推视频该放大多少才能让内容带充满容器（与我们 ContentCropper 的像素检测目标一致，但它有精确元数据）。

### 1.3 SEI 文本解析（模块 69703 `KR`）

```js
let s = t => {
  let e = t.indexOf("{")
  if (-1 === e) return
  let o = t.lastIndexOf("}") + 1
  try { return JSON.parse(t.substring(e, o)) } catch { return s(t.substring(e + 1)) }
}
```

SEI 内容是**包裹着 JSON 的文本**（可能带前后缀），从首个 `{` 到最后一个 `}` 截取解析，失败则跳过一个 `{` 重试。

### 1.4 真实 SEI 报文（实测捕获，2026-09-30 16:11，房间「老17」）

```json
{
  "app_data": "{
    \"mix_grids\": [
      {\"x\":0,   \"y\":0.19, \"w\":0.5, \"h\":0.40625, \"p\":0, \"type\":1,
       \"uid_str\":\"1_148818f7a74748ab00a6b712865587af\", \"talk_volume\":46, \"mute_audio\":0},
      {\"x\":0.5, \"y\":0.19, \"w\":0.5, \"h\":0.40625, \"p\":1, \"type\":1,
       \"uid_str\":\"1_54bf6e929d877c053579a233838405ba\", \"mute_audio\":1}
    ],
    \"grids\": [ {\"x\":0.5,\"y\":0.19,\"w\":0.5,\"h\":0.40625,\"p\":1,
                  \"uid_str\":\"1_54bf6e929d877c053579a233838405ba\",\"mute_audio\":1} ],
    \"anchor_interact_info\": {\"scale_type\":0,\"owner_index\":0,\"align_mode\":4,
                               \"is_horizontal\":0,\"layout_type\":0,\"ui_layout\":1,\"focus_id\":\"0\"},
    \"channel_id\": \"7691236225698190390\",
    \"ver\": 2,
    \"canvas\": {\"width\":360,\"height\":640,\"background\":\"#1F212C\"},
    \"vendor\": \"byte\",
    \"timestamp\": 1790756709719
  }",
  "sei_index": 194902
}
```

字段解读：

| 字段 | 含义 |
| --- | --- |
| `ver` | 2=DOUBLE（双人 PK）6=MULTI（多人） |
| `mix_grids` | 完整合成布局（所有人矩形，归一化）；`p`=位次 |
| `grids` | **本观看视角关心的 grid**（DOUBLE 时=对方矩形；PKSEIPlugin 据此 + 本方注入还原双人布局） |
| `uid_str` | 连麦通道内部用户标识 `1_<32位hex>`（不是抖音 uid；身份要经 1.5 映射） |
| `talk_volume` | 该路实时说话音量（SEI 随关键帧持续更新） |
| `mute_audio` | 该路是否被闭麦 |
| `canvas` | 合成器画布尺寸与**底色**（9:16，`#1F212C` 就是灰边颜色） |
| `channel_id` | 连麦频道 id（与 SSR `linker_map` 中的值一致） |
| `anchor_interact_info` | 横竖屏/布局类型（EQUAL/FOCUS/ZOOM）、聚焦 id |
| `live_crop` | （DOUBLE 且视频分辨率≠画布时）内容带的裁剪区 `{crop_y,crop_h,stride_h}` |

### 1.5 身份映射与点击跳转

- **`getPKList({anchor_id})` HTTP 接口**：返回 `user[]`，每项含 `linkmic_id_str`（= SEI `uid_str`）、`id_str`/`webcast_uid`/`sec_uid`/`nickname`/`avatar_thumb`/`follow_info`。PKViewPlugin 把 grid 的 `linkmicUid` 对到这些用户，渲染头像/昵称/分数/关注按钮，点击即按 `sec_uid` 跳转或关注（埋点字段 `sec_to_user_id`）。
- **IM 消息族**（5 分钟采样实测命中）：`LinkMicMethod`(880)、`WebcastLinkMicMethod`(191)、`WebcastLinkMicArmiesMethod`(18，战队贡献)、`WebcastBattleStatusMessage`(2)、`WebcastLinkerContributeMessage`(18)、`WebcastLinkmicPlayModeUpdateScoreMessage`(10)、`WebcastAnchorLinkmicSilenceMessage`(4)、`WebcastLinkMicBattleMethod`(1)、`WebcastBattleTeamTaskMessage`(288)、`WebcastProfitInteractionScoreMessage`(285)。消息类型枚举（模块 378470 `aN`）：QUIT=4 / RESTART=201 / UPDATE=202 / END=205。
- SSR 初始状态佐证双通道：`linkmicStore` 同时存在 `imLinkMicSeats`（IM 席位）与 `seiLinkMicSeats`（SEI 席位），另有 `newSeiContent`/`seiDiffKey`。

### 1.6 播放器 SDK 的 SEI 提取（`new-player-merged.b2a3b908.js`）

- FLV 路径：demuxer 遍历 AVC NALU，`case 6`（SEI）→ `removeEPB`（去防竞争字节）→ `parseSEI`（读 payload_type，type 5 时附带提取 16 字节 UUID）→ emit `SEI` 事件 `{code: payload_type, content: payload, dts, time, uuid}`。
- HLS 路径：`seiSamples` 同样收集后在 `streamparsed` 时 emit。
- 上层（埋点/业务插件）统一 `if (e.code === 100)` 过滤出抖音业务 SEI。

### 1.7 常量枚举（模块 378470，实测提取）

```
TG  (app_data.ver)      DOUBLE=2, MULTI=6
Xk  (layout_type)       EQUAL=0, FOCUS=1, ZOOM=2
g_  (is_horizontal)     VERTICAL=0, LANDSCAPE=1
aN (battle msg type)    QUIT=4, RESTART=201, UPDATE=202, END=205
qY (胜负)               WIN=1, LOSE=2, DRAW=3
WL (PK 玩法)            NORMAL=0, VOTE=1, C_ENLARGE=6
```

---

## 2. 对本仓库的落地选项

1. **智能取景升级为 SEI 驱动（✅ 已实施）**：`src/renderer/src/lib/flvSei.ts` 在 fetch 层 tee 播放器的 FLV 响应（mpegts.js 的 IO 在主线程），旁路增量解析 AVC SEI(payload_type=100) → JSON → `mix_grids` 包围盒，交给 `contentCrop.ts` 直接缩放；SEI 15s 新鲜期内为权威来源，超时/缺失（HLS 源、H.265、画布纵横比与视频不符）回退原像素检测。单元测试 `research/sei_parser_test.mjs`（真实报文合成 FLV + 任意 chunk 切分）。注意 WebRTC 路径（当前 PC 网页主路径）SEI 在 SRTP 里拿不到，但本应用走 FLV/HLS 拉流，恰好在可解析的位置。
2. **点击对方画面跳转对应直播间（未实施）**：SEI `uid_str` + `getPKList`（需在页面上下文调用，受 Bd-Ticket-Guard 门槛约束，见主报告 §2.2）或 IM `LinkMicMethod`（内含用户信息）做映射；UI 在对方矩形上放热区，点击打开 `live.douyin.com/<对方 web_rid>`（web_rid 需再查；或退而求其次跳 sec_uid 主页）。
3. **PK 分数条/状态**：IM `WebcastLinkMicArmiesMethod`/`WebcastBattleStatusMessage` 可支撑，但字段需另行标定（复用 `dump_gift.cjs` 思路）。

## 3. 复现工具（本次新增，research/ 目录）

| 文件 | 用途 |
| --- | --- |
| `extract_ssr.mjs` / `extract_ssr2.mjs` / `extract_ssr3.mjs` | 房间页 SSR 反转义提取：roomStore 概览 / linkmicStore 全文 / 真实 roomInfo |
| `findkeys.mjs` | 反转义文本关键字定位（上下文打印） |
| `getflv.mjs` | 提取 `flv_pull_url` 各清晰度地址 |
| `probe_pk.mjs` | 批量探测房间是否在连麦/PK（linker_map/in_pk/seats） |
| `chunks/`（.gitignore 内） | 第三方版权脚本，不入库；`PKSEIPlugin.76e5060d.js`、`PKViewPlugin.0df9351d.js`、`new-player-merged.b2a3b908.js` 可从 `lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/webcast/douyin_live/` 重新下载 |

## 4. 方法备忘

- 找连麦/PK 房：首页分类 `/categorynew/4_101`（聊天）→ 提取卡片 web_rid → `probe_pk.mjs` 批量探测 SSR `linker_map` 非空。
- 提取 webpack 模块源码（无需下载全部 chunk）：页面上下文
  `webpackChunkdouyin_live_v2.push([[Math.random()],{},(r)=>{req=r}])` 后 `req.m[<模块id>].toString()`。
- 活捉 SEI 明文：页面上下文临时包裹 `TextDecoder.prototype.decode`，过滤含 `app_data`/`grids` 的短串（SEI 随关键帧 ~1-2s 一条）。
- 注意：curl 直拉 `flv_pull_url` 被边缘节点空响应拒绝（疑似客户端指纹/会话校验），浏览器/应用内播放器正常——SEI 研究走页面侧。
