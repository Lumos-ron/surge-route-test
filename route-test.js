/*
 * Surge Panel: Route Test (CN Backbone)
 *
 * 测试当前选中节点经国内三网民用 vantage 的回程路由，识别 CT-163/CN2、CU-169/9929、
 * CM-CMNET/CMI/CMIN2 等骨干线路类型。
 *
 * 数据源: ping.pe（含 CN_102/104/105/112/113/115 真三网民用 vantage）
 *
 * 协议（由 spike 探明，详见 docs/spike.md）：
 *   1. GET /<TARGET>                        → 解析 antiflood cookie
 *   2. GET /<TARGET>?browsercheck=ok        → 解析 taskStartToken
 *   3. POST /ajax_startTask_v1.php          → 拿 stream_id_mtr
 *   4. GET /ajax_getPingResults_v2.php?...  → 轮询直到完成或超预算
 *   5. GET /ajax_stopTask.php?...           → 清理（可省）
 *
 * 已知约束：
 *   - Surge 沙箱仅 HTTP，不支持 ICMP/WebSocket
 *   - 单次 MTR ~65–75s，超过 Surge 60s panel timeout，因此设 poll_budget_ms 控制提前返回
 *   - taskStartToken 绑定请求方 IP 与 UA，整条流程必须保持 UA 一致
 */

(function () {
  'use strict';

  // ============================================================================
  // 1. CONFIG
  // ============================================================================

  const DEFAULTS = {
    carriers: 'ct|cu|cm',
    cache_ttl: 300,
    poll_budget_ms: 48000,
    ip_resolver: 'https://api.ip.sb/jsonip',
    debug: false,
  };

  function parseArg(raw) {
    const out = Object.assign({}, DEFAULTS);
    if (!raw) return out;
    String(raw).split('&').forEach((kv) => {
      const i = kv.indexOf('=');
      if (i < 0) return;
      const k = kv.slice(0, i).trim();
      const v = kv.slice(i + 1).trim();
      if (!(k in out)) return;
      if (k === 'debug') out[k] = v === 'true' || v === '1';
      else if (k === 'cache_ttl' || k === 'poll_budget_ms') out[k] = parseInt(v, 10) || DEFAULTS[k];
      else out[k] = v;
    });
    return out;
  }

  const ARG = parseArg(typeof $argument === 'string' ? $argument : '');
  const ENABLED_CARRIERS = new Set(ARG.carriers.split('|').map((s) => s.trim()).filter(Boolean));

  // ============================================================================
  // 2. CONSTANTS
  // ============================================================================

  // ping.pe 民用三网 vantage（其余 CN_* 均为 Tencent/Aliyun 数据中心，识别精度低，不参与）
  const VANTAGES = [
    { id: 'CN_102', carrier: 'ct', label: '电信 江苏' },
    { id: 'CN_112', carrier: 'ct', label: '电信 丽水' },
    { id: 'CN_105', carrier: 'cu', label: '联通 江苏' },
    { id: 'CN_113', carrier: 'cu', label: '联通 丽水' },
    { id: 'CN_104', carrier: 'cm', label: '移动 江苏' },
    { id: 'CN_115', carrier: 'cm', label: '移动 丽水' },
  ];

  // 骨干 ASN → 线路标签。覆盖三网核心 + 已观测到的区域 AS。
  // 来源：APNIC whois、PeeringDB、ping.pe 实测。CN2 GIA vs GT 仅靠 ASN 区分不开（同 4809），第一版统一标 CT-CN2。
  const BACKBONE_ASN = {
    // 电信
    4134: 'CT-163',
    4809: 'CT-CN2',
    23764: 'CT-CN2',
    // 电信省级 IDC（与 4134 同体系，归类为 163）
    136190: 'CT-163', // CHINATELECOM-ZHEJIANG-JINHUA-IDC
    137693: 'CT-163',
    140062: 'CT-163',
    // 联通
    4837: 'CU-169',
    9929: 'CU-9929',
    10099: 'CU-CUG',
    // 移动
    9808: 'CM-CMNET',
    58453: 'CM-CMI',
    58807: 'CM-CMIN2',
    // 移动省级（CMNET 区域，与 9808 同体系）
    56040: 'CM-CMNET',
    56041: 'CM-CMNET',
    56044: 'CM-CMNET',
    24400: 'CM-CMNET',
    // 国际 transit（不归为骨干，仅供 debug 标识）
    174: 'TRANSIT-Cogent',
    2914: 'TRANSIT-NTT',
    3491: 'TRANSIT-PCCW',
    6453: 'TRANSIT-TATA',
    1299: 'TRANSIT-Telia',
    3257: 'TRANSIT-GTT',
    6939: 'TRANSIT-HE',
  };

  function backboneTag(asn) {
    return BACKBONE_ASN[asn] || null;
  }

  function isCnBackbone(tag) {
    return tag && (tag.startsWith('CT-') || tag.startsWith('CU-') || tag.startsWith('CM-'));
  }

  // 模拟桌面浏览器 UA，全流程必须保持一致（taskStartToken 含 UA 哈希）
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

  const CACHE_KEY_PREFIX = 'route-test:v1:';

  // ============================================================================
  // 3. UTILS
  // ============================================================================

  function log(level, ...args) {
    if (level === 'error' || ARG.debug) {
      console.log('[RouteTest][' + level + ']', ...args);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout: ' + label + ' after ' + ms + 'ms')), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function http(method, url, opts) {
    opts = opts || {};
    const req = {
      url,
      headers: Object.assign({ 'User-Agent': UA }, opts.headers || {}),
    };
    if (opts.body !== undefined) req.body = opts.body;
    return withTimeout(
      new Promise((resolve, reject) => {
        const cb = (err, resp, body) => {
          if (err) return reject(new Error(String(err)));
          if (!resp) return reject(new Error('no response'));
          resolve({ status: resp.status, headers: resp.headers || {}, body: body || '' });
        };
        if (method === 'GET') $httpClient.get(req, cb);
        else if (method === 'POST') $httpClient.post(req, cb);
        else reject(new Error('unsupported method: ' + method));
      }),
      opts.timeoutMs || 15000,
      method + ' ' + url
    );
  }

  // 表单 url-encoded body（ping.pe POST 使用）
  function formEncode(obj) {
    return Object.keys(obj)
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(obj[k])))
      .join('&');
  }

  function cacheRead(key) {
    if (typeof $persistentStore === 'undefined') return null;
    const raw = $persistentStore.read(CACHE_KEY_PREFIX + key);
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw);
      if (Date.now() - (obj.savedAt || 0) > ARG.cache_ttl * 1000) return null;
      return obj;
    } catch (e) {
      return null;
    }
  }

  function cacheWrite(key, payload) {
    if (typeof $persistentStore === 'undefined' || ARG.cache_ttl <= 0) return;
    try {
      $persistentStore.write(JSON.stringify(Object.assign({ savedAt: Date.now() }, payload)), CACHE_KEY_PREFIX + key);
    } catch (e) {
      log('error', 'cache write failed', e);
    }
  }

  function fmtAge(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    return Math.round(s / 60) + 'm';
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  // ============================================================================
  // 4. IP RESOLVER（取当前节点出口 IP）
  // ============================================================================
  // Surge 没有取"当前 proxy 出口 IP"的 API；通过代理调用 IP echo 服务即可，因为
  // Surge 默认会将该请求经活动代理发出，返回的就是节点出口 IP。

  function buildResolverList() {
    const list = [ARG.ip_resolver];
    const fallbacks = ['https://api.ip.sb/jsonip', 'https://ipinfo.io/ip', 'https://ifconfig.co/ip'];
    fallbacks.forEach((u) => { if (!list.includes(u)) list.push(u); });
    return list;
  }

  async function resolveExitIp() {
    for (const url of buildResolverList()) {
      try {
        const r = await http('GET', url, { timeoutMs: 6000 });
        if (r.status >= 200 && r.status < 300) {
          const ip = extractIp(r.body);
          if (ip) {
            log('info', 'exit IP via', url, '→', ip);
            return ip;
          }
        }
      } catch (e) {
        log('info', 'resolver failed', url, e.message);
      }
    }
    throw new Error('无法获取节点出口 IP（所有 resolver 都失败）');
  }

  function extractIp(body) {
    if (!body) return null;
    const txt = String(body).trim();
    // 直接是 IP 文本
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(txt)) return txt;
    // JSON: {"ip":"x.x.x.x"} 或类似
    try {
      const j = JSON.parse(txt);
      if (j && typeof j.ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(j.ip)) return j.ip;
    } catch (e) {}
    // 文本里嵌入
    const m = txt.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    return m ? m[0] : null;
  }

  function isUsableIp(ip) {
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
    // 排除私有/CGN/loopback
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return false;
    if (p[0] === 127) return false;
    if (p[0] === 0) return false;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
    if (p[0] === 192 && p[1] === 168) return false;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false; // CGN
    if (p[0] >= 224) return false;
    return true;
  }

  // ============================================================================
  // 5. PING.PE ADAPTER（四步协议）
  // ============================================================================

  const PING_PE = 'https://ping.pe';

  async function pingPeRun(targetIp, deadline) {
    // Step 1: bootstrap，拿 antiflood cookie
    const bootstrap = await http('GET', PING_PE + '/' + targetIp, { timeoutMs: 8000 });
    const cookie = parseAntiflood(bootstrap.body);
    if (!cookie) throw new Error('无法解析 antiflood cookie');

    // Step 2: 完整页 + token
    const full = await http('GET', PING_PE + '/' + targetIp + '?browsercheck=ok', {
      headers: { Cookie: 'antiflood=' + cookie },
      timeoutMs: 12000,
    });
    if (full.status !== 200) throw new Error('full page status ' + full.status);
    const token = parseTaskStartToken(full.body);
    if (!token) throw new Error('无法解析 taskStartToken');

    // Step 3: startTask
    const start = await http('POST', PING_PE + '/ajax_startTask_v1.php', {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: PING_PE,
        Referer: PING_PE + '/' + targetIp,
        Cookie: 'antiflood=' + cookie,
      },
      body: formEncode({ query: targetIp, interval_s: '5', dense_mode: '0', start_token: token }),
      timeoutMs: 10000,
    });
    let startJson;
    try { startJson = JSON.parse(start.body); } catch (e) { throw new Error('startTask 响应非 JSON'); }
    if (!startJson.ok || !startJson.data || !startJson.data.stream_id_mtr) {
      throw new Error('startTask 失败: ' + (startJson.error || start.body.slice(0, 120)));
    }
    const streamId = startJson.data.stream_id_mtr;
    log('info', 'stream_id_mtr', streamId, 'pinger_count', startJson.data.pinger_count);

    // Step 4: poll until done or budget exhausted
    const interval = 6000; // ping.pe JS 用 6s 轮询
    const headers = { Cookie: 'antiflood=' + cookie, Referer: PING_PE + '/' + targetIp };

    // 首次拉取前先等 ~22s（实测 25s 时仍 0/148 完成；之后开始陆续完成）
    await sleep(Math.min(22000, deadline - Date.now() - 4000));

    let lastJson = null;
    while (Date.now() < deadline) {
      const r = await http('GET', PING_PE + '/ajax_getPingResults_v2.php?stream_id=' + streamId, { headers, timeoutMs: 10000 });
      try { lastJson = JSON.parse(r.body); } catch (e) { log('error', 'poll parse failed'); break; }
      const out = (lastJson && lastJson.state && lastJson.state.outstandingNodeCount) | 0;
      log('info', 'poll outstanding', out);
      if (out === 0) break;
      // 关注的 vantage 是否都出结果了？是则提前结束
      if (lastJson && Array.isArray(lastJson.data) && allEnabledVantagesDone(lastJson.data)) break;
      if (deadline - Date.now() < interval + 2000) break;
      await sleep(interval);
    }

    // Step 5: best-effort cleanup（不阻塞）
    http('GET', PING_PE + '/ajax_stopTask.php?stream_id=' + streamId, { headers, timeoutMs: 4000 }).catch(() => {});

    return lastJson || { data: [], state: {} };
  }

  function allEnabledVantagesDone(items) {
    const ids = new Set(items.map((i) => i.node_id));
    for (const v of VANTAGES) {
      if (ENABLED_CARRIERS.has(v.carrier) && !ids.has(v.id)) return false;
    }
    return true;
  }

  function parseAntiflood(html) {
    if (!html) return null;
    const m = String(html).match(/document\.cookie\s*=\s*"antiflood=([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
  }

  function parseTaskStartToken(html) {
    if (!html) return null;
    const m = String(html).match(/var\s+taskStartToken\s*=\s*"([^"]+)"/);
    return m ? m[1] : null;
  }

  // ============================================================================
  // 6. CLASSIFIER（解析 result_text → hops → 主骨干 ASN）
  // ============================================================================

  function parseResultText(text) {
    // 每行格式：
    //   <idx> <a ...records.ping.pe/IP><span>IP</span></a>  loss% snt last avg best wrst stdev
    //     [<a ...records.ping.pe/AS####...><span>####  AS-NAME</span></a>] <span>PTR</span>
    // 或 hop 超时：<a ...>???</a>
    const lines = String(text || '').split(/\n/);
    const hops = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || /^Loss%/.test(line)) continue;
      const idxM = line.match(/^(\d+)[.\s]/);
      if (!idxM) continue;
      const idx = parseInt(idxM[1], 10);
      const ipM = line.match(/records\.ping\.pe\/(?:%3F%3F%3F|\?\?\?|(\d{1,3}(?:\.\d{1,3}){3}))/);
      const ip = ipM && ipM[1] ? ipM[1] : null;
      const asnM = line.match(/records\.ping\.pe\/AS(\d+)['"]/);
      const asn = asnM ? parseInt(asnM[1], 10) : null;
      const asNameM = line.match(/<span>\s*\d+\s+([A-Z0-9-]+)/);
      const asName = asNameM ? asNameM[1] : null;
      hops.push({ idx, ip, asn, asName });
    }
    return hops;
  }

  // 在 hops 中识别主骨干 ASN：倒序扫，取第一个命中 BACKBONE_ASN 且非 transit 的。
  // 同时记录是否同时出现 4134 与 4809（电信 163 → CN2 切换标记）。
  function classifyHops(hops) {
    const seen = new Set();
    let primary = null;
    for (let i = hops.length - 1; i >= 0; i--) {
      const a = hops[i].asn;
      if (!a) continue;
      seen.add(a);
      const tag = backboneTag(a);
      if (tag && isCnBackbone(tag) && !primary) primary = tag;
    }
    let extra = '';
    if (seen.has(4134) && seen.has(4809)) extra = ' (163→CN2)';
    return primary ? primary + extra : null;
  }

  // ============================================================================
  // 7. FORMATTER
  // ============================================================================

  function buildResults(rawData) {
    const items = (rawData && rawData.data) || [];
    const byNode = {};
    for (const it of items) byNode[it.node_id] = it;

    const out = [];
    for (const v of VANTAGES) {
      if (!ENABLED_CARRIERS.has(v.carrier)) continue;
      const item = byNode[v.id];
      if (!item) {
        out.push({ vantage: v, status: 'pending', hops: [], tag: null });
        continue;
      }
      const hops = parseResultText(item.result_text || '');
      const tag = classifyHops(hops);
      out.push({ vantage: v, status: 'ok', hops, tag });
    }
    return out;
  }

  function formatPanel({ exitIp, exitMeta, results, partial, age, fetchedAt, error }) {
    const lines = [];
    if (error && !exitIp) {
      return { title: '路由测试 · 失败', content: '错误: ' + error };
    }

    const ipLine = '节点 IP: ' + (exitIp || '?') + (exitMeta ? '  (' + exitMeta + ')' : '');
    lines.push(ipLine);
    const cacheNote = age != null ? '  缓存: ' + fmtAge(age) : '';
    lines.push('更新: ' + fmtTime(fetchedAt) + cacheNote + (partial ? '  (部分完成)' : ''));
    lines.push('');

    const titleTags = [];
    const carrierGroups = { ct: '电信', cu: '联通', cm: '移动' };
    for (const c of ['ct', 'cu', 'cm']) {
      if (!ENABLED_CARRIERS.has(c)) continue;
      const carrierResults = results.filter((r) => r.vantage.carrier === c);
      const tags = carrierResults.map((r) => r.tag).filter(Boolean);
      const uniq = Array.from(new Set(tags));
      if (uniq.length) titleTags.push(uniq.join('|'));
      else titleTags.push(carrierGroups[c] + '?');
    }

    for (const c of ['ct', 'cu', 'cm']) {
      if (!ENABLED_CARRIERS.has(c)) continue;
      const carrierResults = results.filter((r) => r.vantage.carrier === c);
      for (const r of carrierResults) {
        const left = padRight(r.vantage.label, 9);
        let right;
        if (r.status === 'pending') right = '等待中…';
        else if (!r.tag) right = '未识别';
        else right = r.tag;
        lines.push('  ' + left + right);
        if (ARG.debug && r.hops && r.hops.length) {
          for (const h of r.hops.slice(0, 12)) {
            const ipPart = h.ip || '*';
            const asPart = h.asn ? 'AS' + h.asn + (h.asName ? ' ' + h.asName : '') : '-';
            lines.push('    ' + padRight(String(h.idx), 3) + padRight(ipPart, 18) + asPart);
          }
        }
      }
    }

    const title = '路由 · ' + titleTags.join(' / ');
    return { title, content: lines.join('\n') };
  }

  function padRight(s, w) {
    s = String(s == null ? '' : s);
    // 简单按 char count；中文按 2 个宽度近似（手机 panel 等宽对齐）
    let width = 0;
    for (const ch of s) width += ch.charCodeAt(0) > 127 ? 2 : 1;
    if (width >= w) return s + ' ';
    return s + ' '.repeat(w - width);
  }

  // ============================================================================
  // 8. ORCHESTRATOR
  // ============================================================================

  async function main() {
    const startedAt = Date.now();
    const overallDeadline = startedAt + 55000; // 留 5s 给 $done 和 cleanup

    let exitIp = null;
    try {
      exitIp = await resolveExitIp();
    } catch (e) {
      return formatPanel({ error: e.message });
    }
    if (!isUsableIp(exitIp)) {
      return { title: '路由 · 异常', content: '节点出口 IP ' + exitIp + ' 不可用（私有/CGN/IPv6/未走代理？）' };
    }

    const cacheKey = exitIp + ':' + Array.from(ENABLED_CARRIERS).sort().join(',');
    const cached = cacheRead(cacheKey);
    if (cached && cached.results) {
      log('info', 'cache hit', cacheKey, fmtAge(Date.now() - cached.fetchedAt));
      return formatPanel({
        exitIp,
        exitMeta: cached.exitMeta,
        results: cached.results,
        partial: cached.partial,
        age: Date.now() - cached.fetchedAt,
        fetchedAt: cached.fetchedAt,
      });
    }

    let rawJson;
    try {
      rawJson = await pingPeRun(exitIp, overallDeadline);
    } catch (e) {
      log('error', 'ping.pe run failed', e.message);
      return { title: '路由 · 失败', content: '节点 IP: ' + exitIp + '\n错误: ' + e.message };
    }

    const results = buildResults(rawJson);
    const outstanding = (rawJson.state && rawJson.state.outstandingNodeCount) | 0;
    const partial = outstanding > 0 || results.some((r) => r.status === 'pending');

    const fetchedAt = Date.now();
    const payload = { exitIp, results, partial, fetchedAt };
    if (!partial) cacheWrite(cacheKey, payload);

    return formatPanel(payload);
  }

  // ============================================================================
  // 9. ENTRY
  // ============================================================================

  main()
    .then((panel) => {
      try {
        $done({ title: panel.title || '路由测试', content: panel.content || '' });
      } catch (e) {
        $done({ title: '路由 · 错误', content: 'panel render failed: ' + e.message });
      }
    })
    .catch((err) => {
      log('error', 'unhandled', err && err.message);
      $done({ title: '路由 · 异常', content: '内部错误: ' + (err && err.message ? err.message : String(err)) });
    });
})();
