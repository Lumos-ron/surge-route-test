# Surge 线路路由测试模块

测试当前选中节点经国内三网（电信/联通/移动）民用 vantage 的**去程路由**（严格定义：**国内 → 节点方向**，由 vantage 主动 trace），并识别骨干线路类型（CT-163 / CT-CN2、CU-169 / CU-9929、CM-CMNET / CMI / CMIN2）。在 Surge Dashboard 面板上手动点击触发。

数据源：[ping.pe](https://ping.pe/) 的 MTR API（含 6 个真三网民用 vantage：CN_102/112 电信、CN_105/113 联通、CN_104/115 移动）。

## ⚠️ 关于「去程 vs 回程」（重要）

社区严格定义（参考 [bandwagonhost.net](https://www.bandwagonhost.net/1186.html)）：

- **去程** = "本地到 VPS 的路由"，由**用户/国内 vantage** 出发 trace 到 VPS。
- **回程** = "VPS 到本地的路由"，必须**在 VPS 上跑 traceroute** 回中国 IP。

本模块通过 ping.pe 的国内三网民用 vantage 主动 trace 到节点 IP，方向是**国内 → 节点**，**这就是严格意义的"去程"**。

**真正的"回程"（节点 → 国内）本模块测不到**——Surge 脚本沙箱仅 HTTP 不能 ICMP，且任何"国内 LG"（ping.pe / itdog / zhale）vantage 都在国内，不可能从节点端出发 trace。要测真回程见后文 [测真回程怎么办](#测真回程怎么办)。

## 文件

- `route-test.sgmodule` — 模块清单
- `route-test.js` — 单文件 JS 脚本
- `docs/spike.md` — Phase 0 spike 探查记录与协议契约（实现的依据）

## 安装

### 远程托管（macOS / iOS 通用，推荐）

Surge → Profile → Modules → **从 URL 安装模块** → 输入：

```
https://raw.githubusercontent.com/Lumos-ron/surge-route-test/main/route-test.sgmodule
```

### 本地开发（macOS Surge）

把 sgmodule 里 `script-path=` 改成本地绝对路径，再用 `file:///` URL 装：

```
file:///Users/<you>/Desktop/code/线路路由测试模块/route-test.sgmodule
```

## 使用

面板触发后等 ~50 秒。**因 ping.pe 单次 MTR 需 65–75 秒，超过 Surge 60s panel timeout，结果通常是 "部分完成"**——已完成 vantage 的线路标签可见，未完成的显示 "等待中…"。partial 时面板末尾会自动追加诊断信息。

典型输出：

```
title:  去程路由 · CT-163 / CU-169 / CM-CMNET

content:
节点 IP: 1.2.3.4
归属: JP/Tokyo · AS12345 · Some ISP Co
更新: 14:32:07  (部分完成)

去程线路（国内 → 节点）
  电信 江苏  CT-163
  电信 丽水  CT-163
  联通 江苏  CU-169
  联通 丽水  等待中…
  移动 江苏  CM-CMNET
  移动 丽水  CM-CMNET

— 诊断 —
总耗时: 55s
  bootstrap   ok 0.8s  http=200 cookie=32
  fullpage    ok 1.5s  http=200 token=313 html=522045
  startTask   ok 0.6s  http=200 pingers=148
  poll        partial 50s  polls=4 outst=6 stop=budget
  nodeinfo    ok
```

切换节点后再点击会自动重测（cache key 包含出口 IP）。

## 配置

在 Surge 模块详情页修改 `argument`，或在 sgmodule 的 `[Script]` 行改默认 argument：

| 参数 | 默认 | 说明 |
|------|------|------|
| `carriers` | `ct\|cu\|cm` | 要展示的运营商，`\|` 分隔。可只看一网，例如 `carriers=cm` |
| `cache_ttl` | `300` | 同一节点 IP 的"完整结果"缓存秒数，0 = 禁用。**部分结果不缓存。** |
| `poll_budget_ms` | `48000` | ping.pe MTR 轮询预算毫秒。预算用尽即返回当前数据；脚本总预算固定 55s |
| `ip_resolver` | `https://api.ip.sb/jsonip` | 取节点出口 IP 的 API；JSON 解析失败会自动 fallback 到 ipinfo.io / ifconfig.co |
| `debug` | `false` | `true` 时面板每个 vantage 后追加最多 12 跳详情 |

## 识别表

`route-test.js` 的 `BACKBONE_ASN` 表覆盖：

| ASN | 标签 |
|-----|------|
| 4134 / 136190 / 137693 / 140062 | CT-163（含省级电信 IDC） |
| 4809 / 23764 | CT-CN2（GIA / GT 第一版不区分） |
| 4837 | CU-169 |
| 9929 | CU-9929（精品） |
| 10099 | CU-CUG |
| 9808 / 24400 / 56040 / 56041 / 56044 | CM-CMNET（含省级 CMNET-ZHEJIANG 等） |
| 58453 | CM-CMI |
| 58807 | CM-CMIN2 |
| 174 / 2914 / 3491 / 6453 / 1299 / 3257 / 6939 | TRANSIT-* （Cogent / NTT / PCCW / TATA / Telia / GTT / HE，不计入骨干） |

路径同时出现 4134 与 4809 时显示 `CT-CN2 (163→CN2)` 表示双线切换。

## 测真回程怎么办

本模块**测不到回程**，要测真正的"节点 → 国内"路径，按可控性从高到低：

### 方案 1：登录节点 SSH，跑 NextTrace / BestTrace

```bash
# NextTrace（推荐，识别国内骨干 ASN）
bash <(curl -fsSL https://nxtrace.org/nt)
# 然后跑：
nexttrace 202.96.209.5      # → 上海电信 DNS（电信回程）
nexttrace 202.106.0.20      # → 北京联通 DNS（联通回程）
nexttrace 211.136.17.107    # → 北京移动 DNS（移动回程）

# 或 BestTrace
wget https://cdn.ipip.net/17mon/besttrace4linux.zip
unzip besttrace4linux.zip && chmod +x besttrace
./besttrace -q1 202.96.209.5
```

读 trace 报告里的 ASN：

- AS4809 → CT-CN2（精品回程）
- AS4134 → CT-163（普通回程）
- AS9929 → CU-9929（精品）
- AS4837 → CU-169
- AS58807 → CM-CMIN2
- AS9808 → CM-CMNET

### 方案 2：用机房自带的 Looking Glass

很多 VPS 商在机房页面提供 LG，你输入中国 IP，它在机房机器上 trace 给你。例如 [bandwagonhost LG](https://lg.bandwagonhost.com/)、[Vultr LG](https://www.vultr.com/faq/#lookingGlass)、Linode LG 等。

### 方案 3：本模块未来扩展（你提供 endpoint）

如果你在节点上跑一个 HTTP 接口（例如 `GET /trace?ip=...` 返回 JSON hop 数组），告诉我 endpoint 和响应格式，我可以加一个 `forwardTrace` adapter，让模块同时显示真回程。spike 阶段已留好接口位。

## 已知限制

1. **架构上做不了回程 trace**（见上文专节）。本模块只测去程。
2. **单次 MTR ~65–75s 卡 Surge 60s 超时**。结果通常 partial，partial 不写缓存，重复点击或扩大 `poll_budget_ms`（仍受 60s 上限约束）。
3. **CN_104 江苏移动 trace 前几跳常为 RFC1918**，导致骨干 ASN 命中靠后或缺失，可能显示 "未识别"。
4. **CN2 GIA vs GT 不区分**。两者同属 AS4809，仅靠 ASN 分不开；要细分需 IP prefix 表（59.43.x.x 下一跳特征），第一版未实现。
5. **节点切换中途**：四步协议中切节点会让 ping.pe 看到不同请求方 IP，导致 token 校验失败。重试即可。
6. **IPv6 节点暂不支持**：`isUsableIp` 仅校验 v4，v6 出口会报"节点出口 IP 不可用"。
7. **ping.pe 是第三方服务**：本模块复用其前端协议，无公开 API 授权。规模化使用可能被反爬封禁。

## 调试

partial / error 时 panel 末尾**自动追加诊断尾**（不需要 debug=true），含每步耗时、HTTP 状态、cookie/token 长度、轮询次数、停止原因。截图发出来即可定位。

其他工具：

- `argument=debug=true`：面板追加每跳详情。
- macOS 看 Surge 日志：Surge → Tools → Log；筛选框输入 `RouteTest`。
- iOS：Surge → 更多 → 日志。
- node 下跑纯函数测试：`node /tmp/route_test_check.js`（31 个 fixture 全过）。

## 故障速查

| 现象 | 原因 / 处理 |
|------|------------|
| `节点出口 IP X 不可用` | 出口是私有/CGN/IPv6；当前节点未走代理；检查节点策略 |
| `startTask 失败: Invalid start token` | UA 不一致 / token 过期 / 出口 IP 中途切换。重试一次 |
| 全部 vantage 显示 "等待中…" | 60s 内 ping.pe 还没回任何完成数据；网络抖动或 ping.pe 临时降级；重试 |
| 标签全部 "未识别" | trace 路径全是私网或不在 ASN 表内；打开 debug 看每跳 |

## 协议来源与扩展

详细的 ping.pe 四步协议契约（请求/响应样本、字段含义、token 内部结构）见 [`docs/spike.md`](./docs/spike.md)。

数据源切换：`pingPeRun` 和相关解析函数（`parseAntiflood` / `parseTaskStartToken` / `parseResultText`）是协议相关的；要换源（自建 LG、bgp.tools 等），实现一个新的 `xxxRun(targetIp, deadline)` 与 `parseXxxResult` 即可，`buildResults` / `classifyHops` / `formatPanel` 都不用动。
