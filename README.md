# Surge 线路路由测试模块

测试当前选中节点经国内三网（电信/联通/移动）民用 vantage 的回程路由，并识别骨干线路类型（CT-163 / CT-CN2、CU-169 / CU-9929、CM-CMNET / CMI / CMIN2）。在 Surge Dashboard 面板上手动点击触发。

数据源：[ping.pe](https://ping.pe/) 的 MTR API（含 6 个真三网民用 vantage：CN_102/112 电信、CN_105/113 联通、CN_104/115 移动）。

## 文件

- `route-test.sgmodule` — 模块清单
- `route-test.js` — 单文件 JS 脚本
- `docs/spike.md` — Phase 0 spike 探查记录与协议契约（实现的依据）

## 安装

### 本地开发（macOS Surge）

1. 在 Surge.app 顶部菜单 → Modules → Install Module from File，选择 `route-test.sgmodule`。
2. 编辑模块的 `[Script]` 中 `script-path=route-test.js`，改成本地绝对路径，例如 `script-path=/Users/<you>/Desktop/code/线路路由测试模块/route-test.js`。
3. Dashboard 出现 "路由测试" 面板，点击触发。

### 远程托管（macOS / iOS 通用）

1. 把 `route-test.sgmodule` 和 `route-test.js` 放到同一个 HTTPS 可访问的目录（GitHub raw、个人 OSS、自建静态服务）。
2. 在 sgmodule 里把 `script-path=route-test.js` 改成完整 URL，例如 `script-path=https://raw.githubusercontent.com/<you>/<repo>/main/route-test.js`。
3. Surge → Modules → Install from URL，输入 sgmodule 的 URL。

## 使用

面板触发后等 ~50 秒。**因 ping.pe 单次 MTR 需 65–75 秒，超过 Surge 60s panel timeout 上限，结果通常是 "部分完成"** —— 标题会标 `(部分完成)`，已完成 vantage 的线路类型仍可见，未完成的显示 "等待中…"。

典型输出：

```
title:  路由 · CT-163 / CU-169 / CM-CMNET

content:
节点 IP: 1.2.3.4
更新: 14:32:07  (部分完成)

  电信 江苏  CT-163
  电信 丽水  CT-163
  联通 江苏  CU-169
  联通 丽水  等待中…
  移动 江苏  CM-CMNET
  移动 丽水  CM-CMNET
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

## 已知限制

1. **协议层面做不了真双向 trace**。本模块只做"国内 vantage → 节点"的单向 reverse trace。Surge 沙箱不允许 ICMP，且 ping.pe 不提供"在节点反 trace 回 vantage"能力，所以**严格意义的"去程"测不到**。
2. **单次 MTR ~65–75s 卡 Surge 60s 超时**。结果通常 partial。要拿完整数据请重复点击或扩大 `poll_budget_ms`（仍受 60s 总 timeout 上限约束）。
3. **CN_104（江苏移动）trace 前几跳常为 RFC1918**，导致骨干 ASN 命中靠后或缺失，可能显示 "未识别"。
4. **CN2 GIA vs GT 不区分**。两者同属 AS4809，仅靠 ASN 分不开；要细分需 IP prefix 表（59.43.x.x 下一跳特征），第一版未实现。
5. **节点切换中途**：四步协议中节点切换会让 ping.pe 看到不同请求方 IP，导致 token 校验失败。重试即可。
6. **IPv6 节点暂不支持**：`isUsableIp` 仅校验 v4，v6 出口会报"节点出口 IP 不可用"。
7. **ping.pe 是第三方服务**：本模块复用其前端协议，无公开 API 授权。规模化使用可能被反爬封禁。

## 调试

- `argument=debug=true`：面板追加每跳详情；`console.log` 打印更多信息。
- macOS 看日志：Surge → Profile → Logs（或 Tools → Script Editor → Console）。
- iOS：Surge → More → Logs。
- node 下跑纯函数测试：`node /tmp/route_test_check.js`（spike 阶段产物，30 个 fixture 全过）。

## 故障速查

| 现象 | 原因 / 处理 |
|------|------------|
| `节点出口 IP X 不可用` | 出口是私有/CGN/IPv6；当前节点未走代理；检查节点策略 |
| `startTask 失败: Invalid start token` | UA 不一致 / token 过期 / 出口 IP 中途切换。重试一次 |
| 全部 vantage 显示 "等待中…" | 60s 内 ping.pe 还没回任何完成数据；网络抖动或 ping.pe 临时降级；重试 |
| 标签全部 "未识别" | trace 路径全是私网或不在 ASN 表内；打开 debug 看每跳 |

## 协议来源与扩展

详细的 ping.pe 四步协议契约（请求/响应样本、字段含义、token 内部结构）见 [`docs/spike.md`](./docs/spike.md)。

数据源切换：`pingPeRun` 和相关解析函数 (`parseAntiflood` / `parseTaskStartToken` / `parseResultText`) 是协议相关的；要换源（自建 LG、bgp.tools 等），实现一个新的 `xxxRun(targetIp, deadline)` 与 `parseXxxResult` 即可，`buildResults` / `classifyHops` / `formatPanel` 都不用动。
