# Phase 0 Spike 记录

记录 spike 阶段对候选数据源的探查结论，作为 `route-test.js` 实现的契约依据。

## 候选评估矩阵

| 候选 | 状态 | 决定性问题 |
|------|------|-----------|
| `api.leo.moe` / `leo.bdysite.com` | 废弃 | `leo.moe` 主域无 DNS 记录；`api.leo.moe` 解析到 Cloudflare 但回源 525；`leo.bdysite.com` 主域和 api 子域均无 DNS 记录。读 [`nxtrace/NTrace-core ipgeo/leo.go`](https://github.com/nxtrace/NTrace-core/blob/main/ipgeo/leo.go) 进一步确认：leo.moe 协议是 **WebSocket**，Surge `$httpClient` 不支持，**协议层不兼容**。且 leo.moe 是 IP 富化服务（输入 IP 返回 ASN/地理/router），不是 traceroute 服务。 |
| `itdog.cn` | 排除 | 入口页加载 `/frame/js/pages/icmp_tracert.js`（62KB），用 `jsjiami.com.v7` 重度混淆所有字符串。代码里出现 `new WebSocket` 和 `task_id` 等关键词，确认协议是 WebSocket 推 hop。混淆 + WebSocket + 反爬，三重排除。 |
| `ping.pe` | **采用** | 协议为纯 HTTP 轮询，未混淆。包含真三网民用 vantage（CN_102/112 电信、CN_105/113 联通、CN_104/115 移动）。详见下方契约。 |
| `bgp.tools` | 备选 | API 可用但只提供 ASN/AS-Path 查询，不做 hop trace；三网识别精度受限。 |
| `api.ipapi.is` | 备选（IP 富化） | 纯 JSON IP 信息接口，可作 fallback 取 ASN/ISP。 |

## ping.pe 协议契约

四步流程，全部使用相同 User-Agent（`taskStartToken` 内嵌 UA 哈希）。

### Step 1 — 引导页

```
GET https://ping.pe/<TARGET_IP>
```

返回 ~10 KB HTML 含内联 `<script>document.cookie="antiflood=<value>;...";</script>`。提取该 cookie 值。

实测 `antiflood=5948f41e068ccdaf8db1c9a19fab32a0`，跨多次请求**稳定**。但脚本仍按动态值处理以防上游变更。

### Step 2 — 完整页 + token

```
GET https://ping.pe/<TARGET_IP>?browsercheck=ok
Cookie: antiflood=<value>
```

返回 ~520 KB 完整 MTR 页。从中提取 `var taskStartToken = "<token>"`。

Token 是 `<base64-json>,.<hmac>` 形式：

```json
{"v":2,"page_kind":"ping_v6","query":"1.1.1.1","origin":"https://ping.pe",
 "ip":"5.34.223.38","ua":"86be89a6fb1619b4b68b867fe9bd25ac5f2840cb",
 "exp":1777288436,"nonce":"OgaDGm41e_zfi-fj"}
```

字段：`query`（被测 IP）、`origin`（必须 https://ping.pe）、`ip`（请求方 IP，整流程必须保持同一出口 IP）、`ua`（UA 的 SHA1，整流程必须保持同一 UA）、`exp`（约 14 分钟有效期）。

### Step 3 — 启动任务

```
POST https://ping.pe/ajax_startTask_v1.php
Content-Type: application/x-www-form-urlencoded
Origin: https://ping.pe
Referer: https://ping.pe/<TARGET_IP>
Cookie: antiflood=<value>

query=<TARGET_IP>&interval_s=5&dense_mode=0&start_token=<token>
```

成功响应：

```json
{
  "ok": true,
  "command": "ping",
  "query": "1.1.1.1",
  "data": {
    "stream_id": "6395859768141047580",
    "stream_id_mtr": "5819316667316190144",
    "interval_s": 5,
    "interval_s_mtr": 14,
    "interval_s_mtr_js_poll": 6,
    "pinger_count": 148,
    "ipv6_mode": 0
  }
}
```

失败 `{"ok":false,"error":"Invalid start token"}`：通常因 UA 不一致或 token 过期。

### Step 4 — 轮询 MTR 结果

```
GET https://ping.pe/ajax_getPingResults_v2.php?stream_id=<stream_id_mtr>
Cookie: antiflood=<value>
Referer: https://ping.pe/<TARGET_IP>
```

每次返回结构：

```json
{
  "state": {
    "outstandingNodeCount": 1,
    "outstandingNodes": { "CN_930": { "ip": "...", "location": "...", "provider": "..." } }
  },
  "data": [
    { "node_id": "CN_102", "timestamp_ms": 1777287622564,
      "result": <object>, "result_text": "<HTML 多行 MTR 报告>" }
  ]
}
```

`result_text` 是带 `<a>` 链接和 `<span>` 的多行字符串，每行：

```
<idx>  <a href='https://records.ping.pe/<HOP_IP>'><span>HOP_IP</span></a>  Loss% Snt Last Avg Best Wrst StDev  <a href='https://records.ping.pe/AS<ASN>' title='<NAME>'><span>ASN AS-NAME</span></a>  <span>PTR</span>
```

超时 hop：`<a href='https://records.ping.pe/%3F%3F%3F'><span>???</span></a>`，无 ASN。

实测时序：start 后 +25s 时 `outstandingNodeCount=148`（无任何 vantage 完成）；+65s 时降到 1。**完整 MTR ≈ 65–75 秒**。

### Step 5 — 清理（可省）

```
GET https://ping.pe/ajax_stopTask.php?stream_id=<stream_id_mtr>
```

best-effort，失败不影响结果。

## 真三网民用 vantage 名单

来自 Step 4 响应中 `state.outstandingNodes` 的 `provider` 字段：

| node_id | location | provider | 模块归类 |
|---------|----------|----------|---------|
| CN_102  | Jiangsu | China Telecom | ct |
| CN_112  | Lishui  | China Telecom | ct |
| CN_105  | Jiangsu | China Unicom  | cu |
| CN_113  | Lishui  | China Unicom  | cu |
| CN_104  | Jiangsu | China Mobile  | cm |
| CN_115  | Lishui  | China Mobile  | cm |

其余 CN 节点（CN_5/10/30/100/930 = Tencent；CN_160/210 = Aliyun）**为数据中心节点，不参与三网骨干识别**——它们的 trace 走的是 IDC 内部网络，看到的常是 AS749 等不相关 ASN。

## 实测 ASN 识别命中率（spike 数据，target=1.1.1.1）

| Vantage | 识别 ASN | 模块标签 |
|---------|---------|----------|
| CN_102 (江苏电信) | AS4134 CHINANET-BACKBONE | CT-163 |
| CN_112 (丽水电信) | AS136190 CHINATELECOM-ZHEJIANG-JINHUA-IDC | CT-163（区域 IDC，归为 163 体系） |
| CN_105 (江苏联通) | AS4837 CHINA169-BACKBONE | CU-169 |
| CN_113 (丽水联通) | AS4837 | CU-169 |
| CN_104 (江苏移动) | （未在 spike 截取中见 backbone ASN，路径是 10.x.x.x 内网） | 待重测 |
| CN_115 (丽水移动) | AS56041 CMNET-ZHEJIANG-AP | CM-CMNET（区域，归为 CMNET 体系） |

CN_104 这条提示我们：移动到 1.1.1.1 的路径前几跳全是内网 RFC1918，可能要走更深的 hop 才出公网 ASN。模块的 classifier 倒序扫所有 hop，覆盖这种情况。但极端情况下（trace 没扫到任何已知骨干 ASN），结果会显示 "未识别"——这是预期降级。

## 关键时序与预算

- Surge Panel 总 timeout：60s（模块 manifest 设定）
- 脚本预算：55s（main 的 `overallDeadline = startedAt + 55000`）
- ping.pe 完整 MTR 时间：65–75s
- 因此模块**几乎肯定无法等到 100% 完成**。策略：设 `poll_budget_ms` 默认 48s，到点返回 partial 数据，title 标记 `(部分完成)`，且不写缓存。
- 用户可在 panel 上多次点击；第二次刷新时若节点 IP 没变会命中缓存（但 partial 不缓存，所以实际是再发一次完整请求）。

## 已知风险

1. **antiflood / start_token / Origin 校验都是反爬措施**。ping.pe 没有公开 API，本模块属于第三方使用其前端协议。规模化使用可能被针对性封禁。
2. **token 内嵌请求方 IP**：四步流程全部走当前 Surge 节点，所以 ping.pe 看到的请求方 IP 即节点出口 IP；这与"测试节点出口" 的语义恰好一致，反而是有用副作用。但若用户在 trace 中途切换节点，第二次请求的 IP 不同，token 失效——重试即可。
3. **CN_104 等移动 vantage trace 前段 RFC1918**：导致 ASN 命中靠后或缺失。已有降级（"未识别"）。
4. **ping.pe 协议变更**：如果 ping.pe 改 endpoint / token 校验逻辑 / antiflood 算法，模块即时失效。adapter 隔离了协议细节（在 `pingPeRun` + `parseAntiflood` + `parseTaskStartToken` 三个函数内），改造范围可控。

## 验证产物

- `/tmp/route_test_check.js`：node 下跑的 30 个 sanity 测试用例（parser、classifier、padRight、IP 工具）。基于 spike 抓到的真实 `result_text` 编写，全部通过。
