# 抖音直播 Web 协议研究报告

> 研究时间：2026-09-30 · 环境：Windows 11 · 出口：中国大陆（广东移动）
> 方法：live.douyin.com 页面 JS 逆向（webmssdk / webcast IM SDK chunks）+ 浏览器实测对照 + Node 独立复现。
> 全程请求频率受控（HTTP 请求总数约 60 次、间隔 ≥2s；长轮询采样 3 窗、间隔 2s 低于页面自身的 1.1s）。
> 仅供个人学习研究，请遵守平台条款，勿用于商业或批量抓取。

---

## 0. 结论速览（TL;DR）

| 事项 | 结论 |
| --- | --- |
| 匿名观看弹幕可行吗 | 可行。页面 HTML（SSR）零签名即可拿 room_id 与流地址；im 消息可用 WSS 或 HTTP 长轮询 |
| 弹幕 WSS 端点 | `wss://webcast100-ws-web-{lf,hl}.douyin.com/webcast/im/push/v2/`（服务端会在 im/fetch 响应里下发 `push_server`） |
| WSS `signature` 参数怎么算 | `byted_acrawler.frontierSign({ 'X-MS-STUB': md5("") })['X-Bogus']`（16 字符）。**签名输入不是查询串** |
| 查询串编码 | 官方 SDK 序列化器**不做任何 URL 编码**，裸拼接 `k=v&k2=v2` |
| 游客态需要登录吗 | 不需要。整个游客链路无 `msToken`；`__ac_nonce/__ac_signature` 是 www 主站机制，直播域不涉及 |
| 关键 Cookie | `ttwid`（首访服务端下发）+ `UIFID` + **secsdk 安全 Cookie 组**（`fpk1/fpk2/bd_ticket_guard_*/x-web-secsdk-uid/__security_mc_1_s_sdk_crypt_sdk/csrf_session_id`，由页内 JS 生成） |
| 风控软拒长什么样 | `HTTP 200` + `Content-Length: 0` 空响应体（网关已收到请求但拒绝回数据），或 WSS 握手返回 200 而非 101 |
| 裸 Node 能独立跑通吗 | 房间页 HTML：能。`im/fetch` 长轮询：需要完整浏览器铸造的 Cookie 组，能。**WSS：裸 Node 被拒**，需浏览器上下文（真实 Chrome/Electron 页面）发起，或复用同一浏览器档案铸造的完整凭证组 |
| 仓库既有实现的判定 | 「隐藏页铸造 Cookie + 捕获页面自建 WS URL」的架构是对的；自建 URL 兜底路径的**签名输入写错了**（本次已修） |

---

## 1. 数据通道全景

直播间的数据有三条独立通道，鉴权要求递增：

1. **房间页 HTML（SSR）** —— `GET https://live.douyin.com/<web_rid>`。
   响应 HTML 内嵌 `self.__pace_f.push(...)` 数据块（Next.js 风格 RSC），其中**双重转义的 JSON**（形如 `\\\"roomStore\\\"`）包含：
   - `roomStore.roomInfo.room.id_str`（真实 room_id）、`status`（2=直播中 4=下播）、`title`
   - `stream_url.flv_pull_url` / `hls_pull_url_map`（完整拉流地址，带 `auth_key`）
   - 房间页 HTML 仅需 `ttwid` 即可获取（curl 直接可用），是 **web_rid → room_id → 流地址** 的零签名路径。

2. **`/webcast/room/web/enter/`** —— 客户端进房接口，返回房间全量数据（结构同关注 feed：`data.data[]`）。
   参数模板（页面实测抓取，**无任何签名参数**）：
   ```
   aid=6383&app_name=douyin_web&live_id=1&device_platform=web&language=zh-CN
   &enter_from=web_live&cookie_enabled=true&screen_width=1463&screen_height=915
   &browser_language=zh-CN&browser_platform=Win32&browser_name=<UA名>&browser_version=<UA版>
   &browser_online=true&os_name=Windows&os_version=10
   &web_rid=<web_rid>&room_id_str=<room_id>&enter_source=&is_need_double_stream=false
   &insert_task_id=&live_reason=
   ```
   ⚠️ 该接口现在有**网关级票据校验**（响应头 `Bd-Ticket-Guard-Sign-Res-Static-Sign: 1102` 等）：
   页面上下文（带 `Bd-Ticket-Guard-Client-Cert` 请求头 + 完整安全 Cookie）可通；
   裸 HTTP 客户端（curl/Node，即使带全量 Cookie）被软拒（200 空响应体）。
   纯拉流场景不需要它——HTML 路径可替代。

3. **IM 消息通道**（弹幕/礼物/进场等）—— 二选一或主备：
   - **WSS**：`im/push/v2`（长连接，见 §3）
   - **HTTP 长轮询**：`im/fetch`（~1.1s/次，protobuf 响应，见 §4）
   两者共用同一套 cursor/internal_ext 续传协议与消息封装（§5），且**服务端通过 `fetch_type` 字段指挥客户端升级**：先轮询，响应 `fetch_type=1(Socket)` 时携带 `push_server` 让客户端转 WSS。

---

## 2. 匿名鉴权与 Cookie 机制

### 2.1 Cookie 引导链（游客态，实测）

```
GET https://live.douyin.com/            （无 Cookie）
  ← Set-Cookie: ttwid=1|...|1790722921|...   (HttpOnly, 1年)
  ← Set-Cookie: UIFID_TEMP / UIFID           (10 位随机段+哈希，1年+数年)
  ← 响应头 x-ms-token: ...（页面 JS 会写入 msToken cookie；直播接口并不需要它）
GET https://live.douyin.com/<web_rid>   （带 ttwid）
  ← 200，HTML 含完整房间 SSR 数据
（页面 JS 运行 secsdk 后追加生成）
  fpk1 / fpk2                                （OpenSSL Salted 格式的 AES 指纹串，sdk-glue/webmssdk 生成）
  bd_ticket_guard_client_data                （base64 JSON，含客户端 RSA 公钥，用于票据签名）
  bd_ticket_guard_client_web_domain=2
  x-web-secsdk-uid、__security_mc_1_s_sdk_crypt_sdk、csrf_session_id、passport_csrf_token*
```

要点：
- **`msToken` 在游客直播链路全程不存在**（页面 `document.cookie` 无此键）。`msToken`+`a_bogus/X-Bogus` 签名是 **www.douyin.com 主站接口**（如关注列表 `/aweme/v1/web/*`）的机制，与 live.douyin.com 的 webcast 接口是两套体系。
- `__ac_nonce`/`__ac_signature` 同理是 www 主站的挑战 Cookie，直播域首访直接发 ttwid，不走该挑战。
- 页面加载的安全脚本链：`sdk-glue.js` → `webmssdk.es5.js`（即 `byted_acrawler` 提供者）→ `secsdk-lastest.umd.js` → `security-secsdk/runtime.js`。

### 2.2 各接口的 Cookie/指纹门槛（实测矩阵）

| 请求 | 仅 ttwid | ttwid+UIFID | 全量 Cookie（curl） | 全量 Cookie（Node fetch） | 页面上下文 |
| --- | --- | --- | --- | --- | --- |
| 房间页 HTML | ✅ 200/1.25MB | ✅ | ✅ | ✅ | ✅ |
| `room/web/enter` | ❌ 200 空 | ❌ | ❌ 200 空 | ❌ | ✅ |
| `im/fetch` | ❌ 200 空 | ❌ | ✅ 200/83KB | ✅ 200/100KB | ✅ |
| WSS `im/push/v2` | — | ❌ 200 非 101 | ❌（Node） | ❌（Node） | ✅ 101 |

结论：
- `im/fetch` 的硬门槛是 **secsdk 安全 Cookie 组**（实测 `ttwid+UIFID` 不够，补上 `fpk1/fpk2/bd_ticket_guard_*/x-web-secsdk-uid/__security_mc_1_s_sdk_crypt_sdk/csrf_session_id/passport_csrf_token*` 后立即放行）。这组 Cookie 只能由页内 JS 生成。
- `room/web/enter` 还要求 **`Bd-Ticket-Guard-Client-Cert` 请求头**（页内 secsdk 对请求的动态签名），裸客户端不可行。
- WSS 的门槛是「**同一浏览器档案铸造的完整凭证组**（httpOnly ttwid ↔ 安全 Cookie ↔ user_unique_id 三者一致）+ 浏览器级 TLS」。用「外来源 ttwid + 另一档案的安全 Cookie」这种混合 jar 从 Node 建连仍被拒；同 URL 在页面上下文建连成功。这解释了本仓库「隐藏页铸造 Cookie + 捕获页面自建 WS URL」架构的合理性。

### 2.3 游客态的显示脱敏

游客身份收到的 `ChatMessage`：昵称脱敏（`吴***`）、`msg_id` 常为空、user_id 被掩码（`111111`）。
因此**去重不能依赖 msg_id**，必须用「类型+昵称+内容+短时间窗」兜底（仓库已实现该策略）。

---

## 3. WSS 推送通道（im/push/v2）

### 3.1 连接流程（SDK 逆向还原，`3630/5911/7388` chunks）

1. 客户端先发起一次 `im/fetch`（fetch_rule=1）；
2. 响应 `Response.fetch_type == 1 (Socket)` 时，取出 `Response.push_server`（字段 10/14，如 `wss://webcast100-ws-web-hl.douyin.com/webcast/im/push/v2/`）与 `heartbeat_duration`（秒）；
3. 用下面的参数模板拼 WSS URL 并连接；连接后每 `heartbeat_duration*1000`（默认 10s）发心跳；连续 2 个心跳周期无下行则降级回轮询（`downgradePingCount=2`）。

### 3.2 URL 参数模板（官方 SDK `_getSocketParams`，顺序即序列化顺序）

```
app_name=douyin_web
version_code=180800
webcast_sdk_version=1.0.15      ← Socket 类 V.VERSION（另一拷贝为 0.0.5，两代 SDK 并存）
update_version_code=1.0.15      ← 同上
compress=gzip
aid=6383
live_id=1
did_rule=3
endpoint=live_pc
support_wrds=1
user_unique_id=<19 位设备 id>
im_path=/webcast/im/fetch/
identity=audience
need_persist_msg_count=15
insert_task_id=
live_reason=
room_id=<room_id>
heartbeatDuration=0
cursor=<初始 t-<ts>；重连时带上次 cursor>
internal_ext=<初始空；重连时带上次 internal_ext>
host=https://live.douyin.com
device_platform=web
cookie_enabled=true
screen_width=1920&screen_height=1080
browser_language=zh-CN&browser_platform=Win32&browser_name=Mozilla
browser_version=<UA 描述串（含空格/括号/斜杠，原样拼接）>
browser_online=true
tz_name=Asia/Shanghai
signature=<见 3.3>
```

**序列化**：官方实现是纯字符串拼接 `k=v&k2=v2`，**不做 URL 编码**（`192093` 模块）。
升级请求需要带浏览器同款头：`Cookie`（完整）、`User-Agent`、`Origin: https://live.douyin.com`。Cookie 缺失/不配套时握手被拒（HTTP 200 空响应体而非 101）。

### 3.3 signature 的生成（本次研究的核心产出）

`6009.70d8f970.js` 模块 `692644`（IM SDK 内的签名函数，原样还原）：

```js
let s = (e, t = []) => {                 // e=参数对象, t=param_name 白名单
  let o = "";
  for (let { param_name: i } of t) o += `,${i}=${e[i] ?? ""}`;
  let a = md5(o.substring(1));           // 白名单参数按 k=v 逗号拼接后取 md5
  let l = {};
  return window.byted_acrawler &&
    (l = window.byted_acrawler.frontierSign({ "X-MS-STUB": a })),
    { signature: l["X-Bogus"] ?? "" };
};
```

页面构造 IM 客户端时传的是 `websocket_key: []`（client-entry~1 实测），即**白名单为空**：

```
stub = md5("") = d41d8cd98f00b204e9800998ecf8427e
signature = byted_acrawler.frontierSign({ 'X-MS-STUB': stub })['X-Bogus']
          ≈ "6hRRznwGKRkFJVsQ" （16 字符，含时间戳因子，每次不同）
```

`frontierSign` 由 `webmssdk.es5.js`（1.0.0.53，322KB）提供——脚本头部 `if (!window.byted_acrawler)` 守卫挂载，尾部 webpack UMD 把 API 挂到 `globalThis.byted_acrawler`（`frontierSign/getReferer/init/isWebmssdk/report/setConfig/setTTWebid(V2)`）。内部为 jsvmp 字节码虚拟机（`484e4f4a...` 头的 hexcode），静态反编译不现实；工程做法是无头运行取签名：
- `research/sign_node.mjs` 已验证：最小 window/document 桩 + `vm.runInContext` 即可在 **Node 无头环境**跑通 `frontierSign({X-MS-STUB})`（3ms）。
- 注意取值路径是 `sandbox.byted_acrawler`（UMD 挂 globalThis），不是 `window.byted_acrawler`。

> 常见误判：把整个查询串作为字符串传给 `frontierSign(qs)` —— 那是另一类 URL 签名的用法，产出的 X-Bogus 对 IM WS 无效（本仓库旧版兜底路径正是这个 bug，已修复）。

### 3.4 帧协议

传输帧为 protobuf `PushFrame`（公开字段号，与实测一致）：
`seq_id=1, log_id=2, service=3, method=4, headers=5[{key=1,value=2}], payload_encoding=6, payload_type=7, payload=8`。

- **心跳**：`PushFrame{payload_type:'hb'}`，即字节 `[0x3A, 0x02, 'h', 'b']`（`0x3a02` = 字段7 wire2 len2）。实测服务端接受。SDK 心跳还带自增 `seq_id`，非必须。
- **下行**：`payload_type='msg'`，`payload` 是 **gzip**（payload_encoding 标 `'pb'`，实际以 `1f 8b` 魔数判断）→ 解压得 `Response`。
- **ACK**：`Response.need_ack=1` 时 SDK 会回 `payload_type='ack'` 帧（`transport.ack(frame,response,lastReceiveTime)`）。
  **不回 ack 服务端会重复投递同一批消息**——这是多路由重复弹幕的根源，客户端去重不可省。
- **下行 Response** 字段（im/fetch 响应与 WSS 内层 Response 同构，实测标定）：

| 字段 | 含义 | 实测样例 |
| --- | --- | --- |
| 1 | `messages[]`，每项 `Message{method=1, payload=2}` | `WebcastChatMessage`… |
| 2 | `cursor`（续传游标） | `t-1790723502623_r-7691098877268627196_d-1_u-1_h-7691098868276718362` |
| 3 | `fetch_interval`（建议轮询间隔 ms） | 1000 |
| 4 | `now`（服务器时间 ms） | 1790723502623 |
| 5 | `internal_ext`（续传辅助串） | `internal_src:dim|wss_push_room_id:...|wss_push_did:...|first_req_ms:...` |
| 6 | `fetch_type`（0=Polling 1=Socket 2=PollingWhenSocketConnecting） | 1 |
| 8 | `heartbeat_duration`（秒） | — |
| 9 | `need_ack` | — |
| 10/14 | `push_server`（服务端指派的 WSS 端点） | `wss://webcast100-ws-web-hl.douyin.com/webcast/im/push/v2/` |
| 11 | `live_cursor` | `u-1_d-1` |

> 注：公开资料常写 `internal_ext=6`，实测 6 是 `fetch_type`（varint），`internal_ext` 在 5。
> 仓库旧代码读 6 作为 ext——因 cursor 单独即可续传，该 bug 一直未暴露，已顺手修正。

- 其他 payload_type：`close`（服务端要求断开降级）、`reconnect`、`subscribe_ack`。SDK 建连后还会发 `payload_type='subscribe'` 的 PushFrame（携带 wrds 订阅与 `X-ByteLink-Cursor/InternalExt` 头），基础弹幕场景可不发（实测不发也能持续收到消息）。

---

## 4. HTTP 长轮询通道（im/fetch）—— 无 WSS 的替代路径

```
GET/POST https://live.douyin.com/webcast/im/fetch/?resp_content_type=protobuf&did_rule=3
  &device_id=&app_name=douyin_web&endpoint=live_pc&support_wrds=1
  &user_unique_id=<设备id>&identity=audience&need_persist_msg_count=15
  &insert_task_id=&live_reason=&room_id=<room_id>&version_code=180800
  &last_rtt=<上次耗时，首次0>&live_id=1&aid=6383
  &fetch_rule=1|2            ← 1=初始拉取(带缓冲历史)，2=增量续传
  &cursor=<上次cursor>&internal_ext=<上次internal_ext>
  &device_platform=web&cookie_enabled=true&screen_*=...&browser_*=...&tz_name=Asia/Shanghai
```

- 响应体即 §3.4 的 `Response`（protobuf，无 PushFrame/gzip 外壳），约 1.1s 一次（`fetch_interval` 字段指示）。
- **cursor 单独即可续传**（internal_ext 为空实测可用）。
- SDK 实际用 POST + 请求头 `X-ByteLink-Cursor` / `X-ByteLink-InternalExt` + body=`AllTenantPublishers` protobuf；GET 不带 body 亦可（实测）。
- `fetch_rule=1` 的首拉会返回最近缓冲（`need_persist_msg_count=15` 条级别），一上来就有几十条历史消息。
- **该通道无签名要求**，但要求完整安全 Cookie 组（§2.2）。`research/poll_sample.mjs` 是可用的采样器。

---

## 5. 消息封装与业务消息

`Response.messages[]` 中每项 `Message{ method=1:"WebcastXxxMessage", payload=2:<业务proto字节> }`。
实测 3 窗采样（健身/唱歌/情感聊天房，共 ~2200 条）捕获 24 种：

```
高频：ChatMessage(公屏) MemberMessage(进场) RoomUserSeqMessage(在场用户序)
      RoomStatsMessage(房间统计) LikeMessage/ChatLikeMessage(点赞) InRoomBannerMessage
中频：RoomDataSyncMessage(WRDS 数据同步) FansclubMessage(粉丝团) SocialMessage(关注)
      RanklistHourEntranceMessage(小时榜) RoomStreamAdaptationMessage(清晰度)
      GiftVoteMessage(礼物投票) LiveShoppingMessage(购物) HotChatMessage
低频：RoomMessage RoomIntroMessage GiftSortMessage LinkerContributeMessage(PK贡献)
      ScreenChatMessage HighlightComment LinkmicPlaymodeBMessage BackupSEIMessage
      ResidentGuestMessage LowPcuGuideMessage RoomCommentTopicMessage RoomRankMessage
```

### 5.1 ChatMessage（公屏，已实测标定）

```
ChatMessage{ common=1{method=1, msg_id=2, room_id=3,...}, user=2{id=1, nick_name=3,...}, content=3 }
```
游客态 msg_id 常为空、昵称脱敏 → 去重用「类型+昵称+内容」3s 窗口兜底。

### 5.2 GiftMessage（礼物）

```
GiftMessage{ common=1, gift_id=2, repeat_count=5(实测有值；公开 proto 记 3，疑两代并存), user=7{nick=3}, gift=16(GiftStruct{... 含礼物名 ...}), ... }
```
- 采样期间（北京时间早晨）三个房间均未出现真实付费礼物，字段号未能 100% 实测标定；
  现有实现：连击数取字段 5（兜底 3），礼物名取 GiftStruct 内第一个短中文字符串字段。
- 复现校准工具：`research/dump_gift.cjs <抓包文件>` 打印任意 GiftMessage 的完整字段树；
  或运行 `dy_client.mjs`/`poll_sample.mjs` 时设 `DY_CHAT_DEBUG=1` 输出地毯式勘察日志。
- 想要快速看到礼物：晚间黄金时段在礼物密度高的房间（PK/情感/带货）采样，或用页面侧 `captureRoomWSUrl` 的现成连接观察。

### 5.3 EmojiChatMessage（电台表情聊天）

`{ common=1, emoji_id=2, user=3, emoji_content=4 }`；`emoji_content` 缺省时用 `emoji_id` 占位。

---

## 6. 对本仓库的落地修正（本次提交）

1. `sessions.ts frontierSign()`：签名输入从「查询串字符串」改为 **`{ 'X-MS-STUB': md5("") }`**（§3.3）。旧输入生成的签名对 IM WS 无效，自建 URL 兜底路径等于恒败。
2. `chat.ts buildUrl()`：序列化器从 `URLSearchParams`（会把空格变 `+`）改为官方同款**裸拼接**；参数模板补齐 `identity/insert_task_id/live_reason` 等缺失项对齐页面。
3. `chat.ts handleFrame()`：`internal_ext` 字段号 6 → **5**（6 是 fetch_type）。
4. `chat.ts onGift()`：地毯式调试日志移到 `DY_CHAT_DEBUG=1` 开关后；连击数增加字段 3 兜底。
5. WS_BASE 保持 `webcast100-ws-web-lf`；服务端指派值（实测当前为 `-hl`）可通过 im/fetch 响应字段 10 动态获取（未改代码，避免为主路径引入额外请求）。

## 7. 复现工具（research/ 目录）

| 文件 | 用途 | 用法 |
| --- | --- | --- |
| `sign_node.mjs` | Node 无头运行 webmssdk 生成 frontierSign | `node sign_node.mjs`（内嵌自检） |
| `dy_client.mjs` | 全链路独立客户端：引导→HTML→签名→WSS→解码 | `node --experimental-strip-types dy_client.mjs <web_rid> [秒] [--no-sign]` |
| `poll_sample.mjs` | im/fetch 长轮询采样器（落盘 protobuf） | `DY_COOKIE_FILE=full_cookie.txt node --experimental-strip-types poll_sample.mjs <web_rid> [秒] [间隔ms]` |
| `dump_gift.cjs` | 离线解析抓包，打印 GiftMessage 字段树 | `node dump_gift.cjs samples/batch-000.bin` |
| `ws_header_test.mjs` / `ws_session_test.mjs` | WSS 门槛对照实验 | 见文件头注释 |
| `proto-lite.ts` | 仓库同款 protobuf 极简解码器（软链拷贝） | — |
| `samples/*.bin` | 三窗采样原始数据（~220 批） | 供离线分析 |

## 8. 风控注意事项（研究纪律）

- 一切软拒都表现为「HTTP 200 + 空响应体」或「WS 握手 200」，**不会**显式 403/444（`partition/detail/room` 那类老接口才有 444）。
- 同一 Cookie 档案内请求频率参照真实页面：im/fetch 1.1s/次是正常用户水平；**重试一律指数退避**（仓库 queue.ts 已做）。
- 不要跨档案混用 Cookie（ttwid 与安全 Cookie 必须同源铸造，否则 HTTP 通道都可能被连坐）。
- 房间页 HTML 是无门槛入口，能不动 enter/im-fetch 就不动；能复用长连接就不要反复握手。
