'use strict';
/**
 * 招标看板后端（零依赖版 v2.0.0）
 * 原版依赖 cos-nodejs-sdk-v5（包 1.24MB）；本版用 Node 内置 https + 手写 COS 签名，
 * 包体积 ~12KB，可直接 ZipFile 内联部署，避免依赖与部署源问题。
 * API 行为与原版完全一致。
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PORT = process.env.PORT || 9000;
const SECRET_ID = process.env.TENCENT_COS_SECRET_ID;
const SECRET_KEY = process.env.TENCENT_COS_SECRET_KEY;
const REGION = process.env.TENCENT_COS_REGION || 'ap-guangzhou';
const BUCKET = process.env.TENCENT_COS_BUCKET || 'zhaobiao-1457331256';
const HOST = `${BUCKET}.cos.${REGION}.myqcloud.com`;

const STATUSES_KEY = 'data/statuses.json';
const KEYWORDS_KEY = 'data/keywords.json';
const TENDERS_KEY = 'data/tenders.json';
const ARCHIVED_TENDERS_KEY = 'data/archived-tenders.json';
const FILTER_CONFIG_KEY = 'data/filter-config.json';
const CRRCGO_CANDIDATES_KEY = 'crawl/crrcgo-candidates.json';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-crawl-token',
};

function hmacSha1(key, data) {
  return crypto.createHmac('sha1', key).update(data).digest('hex');
}

function cosRequest(method, key, body) {
  return new Promise((resolve, reject) => {
    const now = Math.floor(Date.now() / 1000);
    const keyTime = `${now - 60};${now + 600}`;
    const signKey = hmacSha1(SECRET_KEY, keyTime);
    const pathname = '/' + String(key).split('/').map(encodeURIComponent).join('/');
    const httpString = `${method.toLowerCase()}\n${pathname}\n\nhost=${HOST}\n`;
    const sha1Http = crypto.createHash('sha1').update(httpString).digest('hex');
    const stringToSign = `sha1\n${keyTime}\n${sha1Http}\n`;
    const signature = hmacSha1(signKey, stringToSign);
    const auth =
      `q-sign-algorithm=sha1&q-ak=${SECRET_ID}&q-sign-time=${keyTime}` +
      `&q-key-time=${keyTime}&q-header-list=host&q-url-param-list=&q-signature=${signature}`;

    const req = https.request(
      {
        hostname: HOST,
        path: pathname,
        method,
        headers: {
          Host: HOST,
          Authorization: auth,
          ...(body !== undefined && body !== null
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            : {}),
        },
        timeout: 30000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, body: buf.toString('utf8') });
          } else {
            reject(Object.assign(new Error(`COS ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`), { cosStatus: res.statusCode }));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('COS 请求超时')));
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

async function getObject(key) {
  try {
    const r = await cosRequest('GET', key);
    return r.body;
  } catch (e) {
    if (e.cosStatus === 404) return null;
    throw e;
  }
}

async function putObject(key, body) {
  await cosRequest('PUT', key, body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

function json(res, code, data) {
  res.writeHead(code, { ...corsHeaders, 'Content-Type': 'application/json' });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const method = req.method;
  const path = new URL(req.url, `http://${req.headers.host}`).pathname;

  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  try {
    if (path === '/api/statuses' && method === 'GET') {
      const data = await getObject(STATUSES_KEY);
      return json(res, 200, data || '{}');
    }

    if (path === '/api/statuses' && method === 'POST') {
      const payload = JSON.parse((await readBody(req)) || '{}');
      const currentRaw = await getObject(STATUSES_KEY);
      const current = currentRaw ? JSON.parse(currentRaw) : {};
      const updated = { ...current, ...payload };
      await putObject(STATUSES_KEY, JSON.stringify(updated));
      return json(res, 200, updated);
    }

    if (path === '/api/keywords' && method === 'GET') {
      const data = await getObject(KEYWORDS_KEY);
      return json(res, 200, data || '[]');
    }

    if (path === '/api/keywords' && method === 'POST') {
      const payload = JSON.parse((await readBody(req)) || '[]');
      if (!Array.isArray(payload)) return json(res, 400, { error: '关键词必须是数组' });
      await putObject(KEYWORDS_KEY, JSON.stringify(payload));
      return json(res, 200, payload);
    }

    if (path === '/api/crrcgo-candidates' && method === 'GET') {
      const data = await getObject(CRRCGO_CANDIDATES_KEY);
      return json(res, 200, data || '[]');
    }

    if (path === '/api/crrcgo-candidates' && method === 'POST') {
      if (!process.env.CRAWL_TOKEN || req.headers['x-crawl-token'] !== process.env.CRAWL_TOKEN) {
        return json(res, 401, { error: 'token 校验失败' });
      }
      const body = await readBody(req);
      if (body.length > 5 * 1024 * 1024) return json(res, 413, { error: 'payload 超过 5MB 上限' });
      const payload = JSON.parse(body || '[]');
      if (!Array.isArray(payload)) return json(res, 400, { error: '候选必须是数组' });
      await putObject(CRRCGO_CANDIDATES_KEY, JSON.stringify(payload));
      return json(res, 200, { success: true, count: payload.length });
    }

    if (path === '/api/filter-config' && method === 'GET') {
      const data = await getObject(FILTER_CONFIG_KEY);
      return json(res, 200, data || '{}');
    }

    if (path === '/api/filter-config' && method === 'POST') {
      const payload = JSON.parse((await readBody(req)) || '{}');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return json(res, 400, { error: '筛选配置必须是对象' });
      }
      payload.updatedAt = new Date().toISOString();
      await putObject(FILTER_CONFIG_KEY, JSON.stringify(payload));
      return json(res, 200, payload);
    }

    if (path === '/api/tenders' && method === 'GET') {
      const data = await getObject(TENDERS_KEY);
      return json(res, 200, data || '[]');
    }

    if (path === '/api/tenders' && method === 'POST') {
      const payload = JSON.parse((await readBody(req)) || '{}');
      if (!payload.name || !payload.unit) return json(res, 400, { error: '项目名称和招标单位不能为空' });
      const currentRaw = await getObject(TENDERS_KEY);
      const current = currentRaw ? JSON.parse(currentRaw) : [];
      current.push(payload);
      await putObject(TENDERS_KEY, JSON.stringify(current));
      return json(res, 200, current);
    }

    if (path === '/api/tenders' && method === 'DELETE') {
      const payload = JSON.parse((await readBody(req)) || '{}');
      const currentRaw = await getObject(TENDERS_KEY);
      const current = currentRaw ? JSON.parse(currentRaw) : [];
      const filtered = current.filter((t) => String(t.id) !== String(payload.id));
      await putObject(TENDERS_KEY, JSON.stringify(filtered));
      return json(res, 200, filtered);
    }

    if (path === '/api/archive' && method === 'GET') {
      const raw = await getObject(ARCHIVED_TENDERS_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return json(res, 200, list);
    }

    if (path === '/api/archive' && method === 'POST') {
      const data = JSON.parse((await readBody(req)) || '{}');
      data.archiveTime = new Date().toISOString();
      const raw = await getObject(ARCHIVED_TENDERS_KEY);
      const current = raw ? JSON.parse(raw) : [];
      current.push(data);
      await putObject(ARCHIVED_TENDERS_KEY, JSON.stringify(current));
      return json(res, 200, { success: true, archived: current });
    }

    if (path === '/api/archive' && method === 'DELETE') {
      const { id } = JSON.parse((await readBody(req)) || '{}');
      const raw = await getObject(ARCHIVED_TENDERS_KEY);
      const current = raw ? JSON.parse(raw) : [];
      const filtered = current.filter((t) => String(t.id) !== String(id));
      await putObject(ARCHIVED_TENDERS_KEY, JSON.stringify(filtered));
      return json(res, 200, { success: true, archived: filtered });
    }

    if (path === '/') {
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/plain' });
      res.end('tender-board backend running (zero-dep v2.0.0)');
      return;
    }

    res.writeHead(404, corsHeaders);
    res.end('Not Found');
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
