const http = require('http');
const COS = require('cos-nodejs-sdk-v5');

const PORT = process.env.PORT || 9000;

const cos = new COS({
  SecretId: process.env.TENCENT_COS_SECRET_ID,
  SecretKey: process.env.TENCENT_COS_SECRET_KEY,
  SecurityToken: process.env.TENCENT_COS_TOKEN || undefined,
});

const REGION = process.env.TENCENT_COS_REGION;
const BUCKET = process.env.TENCENT_COS_BUCKET;
const STATUSES_KEY = 'data/statuses.json';
const KEYWORDS_KEY = 'data/keywords.json';
const TENDERS_KEY = 'data/tenders.json';
const ARCHIVED_TENDERS_KEY = 'data/archived-tenders.json';
const FILTER_CONFIG_KEY = 'data/filter-config.json';

// 内存级归档缓存（与前端自动归档匹配；启动时从 COS 加载）
let archivedTenders = [];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function getObject(key) {
  return new Promise((resolve, reject) => {
    cos.getObject(
      { Bucket: BUCKET, Region: REGION, Key: key },
      (err, data) => {
        if (err) {
          if (err.statusCode === 404 || err.code === 'NoSuchKey') return resolve(null);
          return reject(err);
        }
        resolve(data.Body ? data.Body.toString() : null);
      }
    );
  });
}

async function putObject(key, body) {
  return new Promise((resolve, reject) => {
    cos.putObject(
      { Bucket: BUCKET, Region: REGION, Key: key, Body: body, ContentType: 'application/json' },
      (err, data) => {
        if (err) return reject(err);
        resolve(data);
      }
    );
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  const method = req.method;
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const path = parsedUrl.pathname;

  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  try {
    if (path === '/api/statuses' && method === 'GET') {
      const data = await getObject(STATUSES_KEY);
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(data || '{}');
      return;
    }

    if (path === '/api/statuses' && method === 'POST') {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const currentRaw = await getObject(STATUSES_KEY);
      const current = currentRaw ? JSON.parse(currentRaw) : {};
      const updated = { ...current, ...payload };
      await putObject(STATUSES_KEY, JSON.stringify(updated));
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updated));
      return;
    }

    if (path === '/api/keywords' && method === 'GET') {
      const data = await getObject(KEYWORDS_KEY);
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(data || '[]');
      return;
    }

    if (path === '/api/keywords' && method === 'POST') {
      const body = await readBody(req);
      const payload = JSON.parse(body || '[]');
      if (!Array.isArray(payload)) {
        res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '关键词必须是数组' }));
        return;
      }
      await putObject(KEYWORDS_KEY, JSON.stringify(payload));
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }

    // GET /api/filter-config — 返回相关度筛选配置（阈值/权重/词表/人工升降级覆盖）
    if (path === '/api/filter-config' && method === 'GET') {
      const data = await getObject(FILTER_CONFIG_KEY);
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(data || '{}');
      return;
    }

    // POST /api/filter-config — 覆盖写入筛选配置
    if (path === '/api/filter-config' && method === 'POST') {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '筛选配置必须是对象' }));
        return;
      }
      payload.updatedAt = new Date().toISOString();
      await putObject(FILTER_CONFIG_KEY, JSON.stringify(payload));
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }

    // GET /api/tenders — 返回人工导入的招标信息
    if (path === '/api/tenders' && method === 'GET') {
      const data = await getObject(TENDERS_KEY);
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(data || '[]');
      return;
    }

    // POST /api/tenders — 追加一条人工导入的招标信息
    if (path === '/api/tenders' && method === 'POST') {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      if (!payload.name || !payload.unit) {
        res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '项目名称和招标单位不能为空' }));
        return;
      }
      const currentRaw = await getObject(TENDERS_KEY);
      const current = currentRaw ? JSON.parse(currentRaw) : [];
      current.push(payload);
      await putObject(TENDERS_KEY, JSON.stringify(current));
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(current));
      return;
    }

    // DELETE /api/tenders — 删除一条人工导入的招标信息（按 id）
    if (path === '/api/tenders' && method === 'DELETE') {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const currentRaw = await getObject(TENDERS_KEY);
      const current = currentRaw ? JSON.parse(currentRaw) : [];
      const filtered = current.filter(t => String(t.id) !== String(payload.id));
      await putObject(TENDERS_KEY, JSON.stringify(filtered));
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(filtered));
      return;
    }

    // GET /api/archive — 返回归档列表（从 COS 加载）
    if (path === '/api/archive' && method === 'GET') {
      const raw = await getObject(ARCHIVED_TENDERS_KEY);
      archivedTenders = raw ? JSON.parse(raw) : [];
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(archivedTenders));
      return;
    }

    // POST /api/archive — 添加一条归档记录并持久化到 COS
    if (path === '/api/archive' && method === 'POST') {
      const body = await readBody(req);
      const data = JSON.parse(body || '{}');
      data.archiveTime = new Date().toISOString();
      const raw = await getObject(ARCHIVED_TENDERS_KEY);
      const current = raw ? JSON.parse(raw) : [];
      current.push(data);
      archivedTenders = current;
      await putObject(ARCHIVED_TENDERS_KEY, JSON.stringify(current));
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, archived: archivedTenders }));
      return;
    }

    // DELETE /api/archive — 从归档列表中移除指定 id（恢复用）并持久化到 COS
    if (path === '/api/archive' && method === 'DELETE') {
      const body = await readBody(req);
      const { id } = JSON.parse(body || '{}');
      const raw = await getObject(ARCHIVED_TENDERS_KEY);
      const current = raw ? JSON.parse(raw) : [];
      archivedTenders = current.filter(t => String(t.id) !== String(id));
      await putObject(ARCHIVED_TENDERS_KEY, JSON.stringify(archivedTenders));
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, archived: archivedTenders }));
      return;
    }

    if (path === '/') {
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/plain' });
      res.end('tender-board backend running');
      return;
    }

    res.writeHead(404, corsHeaders);
    res.end('Not Found');
  } catch (err) {
    console.error(err);
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
