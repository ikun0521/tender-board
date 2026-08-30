/**
 * 中车购爬虫 SCF 事件函数（tender-crrcgo-crawler）
 * ------------------------------------------------------------------
 * 每日定时（凌晨 02:00）在云端抓取中车购候选，POST 上报到 tender-backend：
 *   1. https 拉关键词（FUNCTION_URL/api/keywords）
 *   2. require ./crawl-crrcgo 的 main()（复用 scripts/crawl-crrcgo.js 原文件）
 *   3. 结果文件 POST 到 FUNCTION_URL/api/crrcgo-candidates（x-crawl-token 鉴权）
 *
 * 设计约定（2026-08-30）：
 *   - 云端出口 IP 与家宽不同，规避本地 IP 被中车购 WAF 限流的问题
 *   - 零 npm 依赖、零凭证（上传由后端函数代写 COS），只支持 Node 内置模块
 *   - 测试钩子：Invoke 时传 ClientContext base64({"limit":3}) 或环境变量
 *     CRRCGO_LIMIT，可只爬前 N 个关键词快速验证
 */

const https = require('https');
const fs = require('fs');

const FUNCTION_URL = (process.env.FUNCTION_URL || 'https://1457331256-984dniw11b.ap-guangzhou.tencentscf.com').replace(/\/$/, '');
const TMP_OUT = '/tmp/crrcgo-candidates.json';

function httpJson(method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(FUNCTION_URL + urlPath);
    const payload = body ? Buffer.from(body) : null;
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': payload.length } : {}),
          ...(headers || {}),
        },
        timeout: 30000,
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, text: d }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function loadKeywords() {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { status, text } = await httpJson('GET', '/api/keywords');
      if (status === 200) {
        const arr = JSON.parse(text);
        if (Array.isArray(arr) && arr.length) return arr;
      }
      throw new Error(`keywords API status=${status}`);
    } catch (e) {
      console.log(`[关键词] 第${attempt}次拉取失败: ${e.message}`);
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

exports.main_handler = async (event) => {
  const started = Date.now();
  // 测试钩子：ClientContext(base64 JSON) 或环境变量
  let limit = parseInt(process.env.CRRCGO_LIMIT || '0', 10) || 0;
  try {
    const raw = event && (event.ClientContext || event.clientContext);
    if (raw) {
      const ctx = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
      if (ctx && ctx.limit) limit = parseInt(ctx.limit, 10) || limit;
    }
  } catch (e) {
    /* 忽略非法 ClientContext */
  }

  let keywords = await loadKeywords();
  const totalKeywords = keywords.length;
  if (limit > 0) {
    keywords = keywords.slice(0, limit);
    console.log(`[测试] CRRCGO_LIMIT=${limit}，只爬前 ${limit} 个关键词`);
  }

  // 复用本地爬虫逻辑：通过 argv 传参（main 内部用 getArg 读取）
  process.argv = [
    'node', 'crawl-crrcgo.js',
    '--keywords', keywords.join(','),
    '--out', TMP_OUT,
  ];
  const { main } = require('./crawl-crrcgo');
  await main();

  const result = fs.readFileSync(TMP_OUT, 'utf-8');
  const count = JSON.parse(result).length;

  const { status, text } = await httpJson('POST', '/api/crrcgo-candidates', result, {
    'x-crawl-token': process.env.CRAWL_TOKEN || '',
  });
  if (status !== 200) {
    throw new Error(`候选上报失败 status=${status}: ${text.slice(0, 200)}`);
  }

  const summary = {
    ok: true,
    count,
    keywordsUsed: keywords.length,
    totalKeywords,
    limit: limit || undefined,
    durationMs: Date.now() - started,
    upload: JSON.parse(text),
  };
  console.log('[完成]', JSON.stringify(summary));
  return summary;
};
