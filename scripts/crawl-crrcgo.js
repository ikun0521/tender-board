/**
 * 中车购 2.0 平台（crrcgo.cc）招标公告爬虫
 * ------------------------------------------------------------------
 * 原理说明：
 *   中车购前台是 Vue SPA，公告数据来自两个 JSON 接口，均无需登录：
 *     - 列表：POST /api/purchasepublic/portal/purchase/publicList?ep=<sig>&p=<ts>
 *     - 详情：GET  /api/purchasepublic/portal/purchase/publicDetails?id=<id>&ep=<sig>&p=<ts>&type=first
 *   接口带一个反爬签名 ep：用前端硬编码的 RSA 公钥（JSEncrypt / PKCS#1 v1.5）
 *   加密当前时间戳字符串得到，服务端解密后与明文 p 比对。用 Node 内置 crypto 即可复现。
 *
 * 用法：
 *   node scripts/crawl-crrcgo.js                      # 用 COS 关键词，抓「公告中」，输出候选 JSON
 *   node scripts/crawl-crrcgo.js --keywords 试验台,架车机 --out out.json
 *   node scripts/crawl-crrcgo.js --status 1 --page-size 20 --detail   # 抓详情提取单位/发布时间
 *   node scripts/crawl-crrcgo.js --no-filter          # 不按截止日期过滤（含已截止）
 *
 * 参数：
 *   --keywords  逗号分隔的关键词（默认从 COS API 读取，失败回退 产品关键词.txt）
 *   --status    公告状态：1=公告中(默认) 2=公告截止 ""=全部
 *   --page-size 每个关键词取前 N 条（默认 20）
 *   --detail    抓取每条详情正文获取招标单位/发布时间（较慢）
 *   --no-filter 不过滤已截止项目（默认仅保留 截止 >= 明天 与 待确认）
 *   --all-types 保留所有公告类型（默认只保留可投标的「采购/招标公告」，
 *               剔除中标候选人公示、成交结果公示、直接采购公示等结果类公示）
 *   --out       输出候选 JSON 路径（默认 scripts/crrcgo-candidates.json）
 *   --concurrency 详情抓取并发数（默认 2）
 */

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOST = 'www.crrcgo.cc';
// 前端硬编码 RSA 公钥（static/js chunk_0 "c+qv" 模块）
const PUBLIC_KEY =
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCgEM1U3sOmLlNTYwJqsKngcdQGf9gDDTet1eHMy' +
  'U20szhrqsX9rWoaDH4DbzmAJ+TCpSnu7Y/8TsYxa3CRiZ8c+lH/TwSSTvjnx7naTlPsf1+q/hVVhM' +
  'Lz3lwBM2rCijI2ZeQ6NIiFpj1d0FnQgCjJIIg4dE4cUmul4RJXgmpksQIDAQAB';

function pem(b64) {
  return '-----BEGIN PUBLIC KEY-----\n' + b64.match(/.{1,64}/g).join('\n') + '\n-----END PUBLIC KEY-----\n';
}

/** 生成接口签名 ep：RSA 公钥加密时间戳字符串，输出 hex */
function makeEp(ts) {
  return crypto
    .publicEncrypt({ key: pem(PUBLIC_KEY), padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(ts))
    .toString('hex');
}

function request(method, pathBase, body) {
  return new Promise((resolve, reject) => {
    const ts = Date.now();
    const ep = makeEp(ts.toString());
    const sep = pathBase.includes('?') ? '&' : '?';
    const fullPath = `${pathBase}${sep}ep=${ep}&p=${ts}`;
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      // 2026-08-30 触发中车购 WAF 限流（TLS 层被掐断），请求头补全为完整浏览器特征
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Origin: 'https://www.crrcgo.cc',
      Referer: 'https://www.crrcgo.cc/',
      Connection: 'keep-alive',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request(
      { hostname: HOST, path: fullPath, method, headers, timeout: 20000 },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(new Error('JSON 解析失败: ' + d.slice(0, 200)));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 按关键词搜索公告列表 */
async function searchList(keyword, { status = '1', pageSize = 20 } = {}) {
  const res = await request('POST', '/api/purchasepublic/portal/purchase/publicList', {
    subjecttype: '',
    anncmnttitle: keyword,
    startTime: '',
    endTime: '',
    current: 1,
    pageSize,
    anncmntType: '',
    srcsysname: '',
    plant: '',
    oneCategoryId: '',
    status,
  });
  if (!res || res.status !== 200 || !res.data) return [];
  return res.data.data || [];
}

/** 抓取公告详情，返回纯文本正文 */
async function getDetailText(id) {
  const res = await request(
    'GET',
    `/api/purchasepublic/portal/purchase/publicDetails?id=${id}&type=first`,
    null
  );
  const e = (res && res.data) || {};
  const raw = e.a2w9_content_tag || e.a2w9_content || '';
  const text = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#xa0;|&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return { text, entity: e.a2w9_procuring_entity || e.busOrgName || '', publish: e.a2w9_publishtime || '' };
}

function getArg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : def;
}
function hasFlag(name) {
  return process.argv.includes(name);
}

/** 随机延迟 [minMs, maxMs]：模拟人类节奏，避免固定间隔被风控识别（2026-08-30 加） */
function sleepMs(minMs, maxMs) {
  return new Promise((r) => setTimeout(r, minMs + Math.floor(Math.random() * (maxMs - minMs + 1))));
}

/** 读取关键词：优先 COS API，失败回退本地文件 */
async function loadKeywords() {
  const api = 'https://1457331256-984dniw11b.ap-guangzhou.tencentscf.com/api/keywords';
  try {
    const res = await fetch(api, { signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const arr = await res.json();
      if (Array.isArray(arr) && arr.length) {
        console.log(`[关键词] 从 COS 读取 ${arr.length} 个`);
        return arr;
      }
    }
  } catch (e) {
    console.log('[关键词] COS API 失败，回退本地文件:', e.message);
  }
  const local = path.join(ROOT, '产品关键词.txt');
  const raw = fs.readFileSync(local, 'utf-8');
  const arr = raw
    .split(/[\r\n,，、]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  console.log(`[关键词] 从本地文件读取 ${arr.length} 个`);
  return arr;
}

/**
 * 判断是否为「可投标」的招标/采购公告。
 * 中车购上大量条目是结果类公示（中标候选人公示、成交结果公示、直接采购公示等），
 * 这些没有投标截止时间，对我们没有商机价值，默认剔除。
 */
const RESULT_NOTICE_RE =
  /(中标候选人公示|中标结果|成交结果|成交公示|结果公示|中标公告|成交公告|废标|流标|终止公告|变更公告|澄清)/;
const BIDDABLE_NOTICE_RE = /(采购公告|招标公告|询比公告|竞价公告|谈判公告|磋商公告|资格预审)/;

function isBiddableNotice(title) {
  if (!title) return false;
  if (RESULT_NOTICE_RE.test(title)) return false;
  // 「直接采购公示」是已定供应商的公示，不可投标
  if (/直接采购公示/.test(title)) return false;
  return BIDDABLE_NOTICE_RE.test(title);
}

// 截止日期统一使用接口 overTime 字段（报名/公告截止日）

function todayPlusDays(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
}

async function main() {
  const status = getArg('--status', '1');
  const pageSize = parseInt(getArg('--page-size', '20'), 10);
  const withDetail = hasFlag('--detail');
  const noFilter = hasFlag('--no-filter');
  const concurrency = parseInt(getArg('--concurrency', '2'), 10);
  const outPath = path.resolve(ROOT, getArg('--out', 'scripts/crrcgo-candidates.json'));

  let keywords;
  const kwArg = getArg('--keywords');
  if (kwArg) {
    keywords = kwArg.split(',').map((s) => s.trim()).filter(Boolean);
    console.log(`[关键词] 命令行指定 ${keywords.length} 个`);
  } else {
    keywords = await loadKeywords();
  }

  console.log(`[配置] status=${status} pageSize=${pageSize} detail=${withDetail} filter=${!noFilter}`);
  console.log('[开始] 逐关键词搜索中车购公告...\n');

  const byId = new Map();
  let queried = 0;
  for (const kw of keywords) {
    try {
      const list = await searchList(kw, { status, pageSize });
      queried++;
      if (list.length) {
        for (const item of list) {
          if (!byId.has(item.id)) {
            byId.set(item.id, {
              id: item.id,
              name: item.a2w9_anncmnttitle,
              unit: item.a2w9_procuring_entity || item.busOrgName || '',
              publish: item.a2w9_publishtime || '',
              subjecttype: item.a2w9_subjecttype,
              statusTitle: item.statusTitle,
              overTime: item.overTime,
              keyword: kw,
            });
          }
        }
        console.log(`  ✓ ${kw}: ${list.length} 条`);
      }
    } catch (e) {
      console.log(`  ✗ ${kw}: ${e.message}`);
    }
    await sleepMs(2000, 3000); // 限速：每关键词 2~3 秒随机间隔（原 120ms，2026-08-30 触发 WAF 限流后加严）
  }

  let candidates = [...byId.values()];
  console.log(`\n[去重] ${queried} 个关键词共命中去重后 ${candidates.length} 条公告`);

  // 公告类型过滤：默认只保留可投标的采购/招标公告
  if (!hasFlag('--all-types')) {
    const before = candidates.length;
    candidates = candidates.filter((c) => isBiddableNotice(c.name));
    console.log(`[类型] 剔除结果类公示 ${before - candidates.length} 条，保留可投标公告 ${candidates.length} 条`);
  }

  // 抓详情获取招标单位/发布时间（截止日期直接用 overTime）
  if (withDetail && candidates.length) {
    console.log(`[详情] 抓取 ${candidates.length} 条详情获取单位/时间（并发 ${concurrency}）...`);
    let idx = 0;
    async function worker() {
      while (idx < candidates.length) {
        const c = candidates[idx++];
        try {
          const { text, entity, publish } = await getDetailText(c.id);
          if (entity && !c.unit) c.unit = entity;
          if (publish && !c.publish) c.publish = publish;
        } catch (e) {
          // 详情抓取失败，保留列表已有的 overTime / unit
        }
        c.deadline = c.overTime || '待确认';
        c.deadlineSource = 'overTime';
        await sleepMs(800, 1500); // 限速：每条详情 0.8~1.5 秒随机间隔（原 80ms，2026-08-30 加严）
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  } else {
    // 截止日期直接用 overTime（公告截止日，与国铁报名截止统一）
    for (const c of candidates) c.deadline = c.overTime || '待确认';
  }

  // 过滤：仅保留 截止 >= 明天 或 待确认
  if (!noFilter) {
    const cutoff = todayPlusDays(1);
    const before = candidates.length;
    candidates = candidates.filter((c) => {
      if (!c.deadline || c.deadline === '待确认') return true;
      const d = new Date(c.deadline.replace(' ', 'T'));
      return isNaN(d.getTime()) ? true : d >= cutoff;
    });
    console.log(`[过滤] 截止 < 明天 移除 ${before - candidates.length} 条，保留 ${candidates.length} 条`);
  }

  // 整理成候选格式（对接 sync-tenders / index.html）
  const out = candidates.map((c) => ({
    name: c.name,
    unit: c.unit,
    category: c.keyword,
    publish: c.publish,
    deadline: c.deadline,
    link: `https://www.crrcgo.cc/#/detail/purchaseDetail?id=${c.id}&tabName=first`,
    platform: '中车购2.0平台',
    title: c.name,
    url: `https://www.crrcgo.cc/#/detail/purchaseDetail?id=${c.id}&tabName=first`,
    keyword: c.keyword,
  }));

  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf-8');
  console.log(`\n[输出] ${out.length} 条候选 → ${outPath}`);
  console.log('\n===== 结果预览 =====');
  out.slice(0, 30).forEach((c, i) =>
    console.log(`${i + 1}. ${c.publish} | 截止 ${c.deadline} | ${c.name} | ${c.unit}`)
  );
  if (out.length > 30) console.log(`... 其余 ${out.length - 30} 条见 JSON 文件`);
}

main().catch((e) => {
  console.error('运行失败:', e);
  process.exit(1);
});
