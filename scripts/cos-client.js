#!/usr/bin/env node
/**
 * 零依赖 COS 直连工具（XML API，手动签名 v5）
 * 用途：SCF Web 函数后端不可用时，本地直接读写 COS 兜底
 *
 * 用法:
 *   node cos-client.js list [prefix]
 *   node cos-client.js stat <key>
 *   node cos-client.js get  <key> [saveTo]
 *   node cos-client.js put  <localFile> <key>
 *
 * 凭证: 环境变量 TENCENT_COS_SECRET_ID / KEY / BUCKET / REGION（项目根 .env）
 */
'use strict';
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

const SECRET_ID = process.env.TENCENT_COS_SECRET_ID;
const SECRET_KEY = process.env.TENCENT_COS_SECRET_KEY;
const BUCKET = process.env.TENCENT_COS_BUCKET || 'zhaobiao-1457331256';
const REGION = process.env.TENCENT_COS_REGION || 'ap-guangzhou';
const HOST = `${BUCKET}.cos.${REGION}.myqcloud.com`;

if (!SECRET_ID || !SECRET_KEY) {
  console.error('缺少凭证: 请先加载项目根 .env (TENCENT_COS_SECRET_ID / TENCENT_COS_SECRET_KEY)');
  process.exit(1);
}

function hmac(key, data) {
  return crypto.createHmac('sha1', key).update(data).digest('hex');
}

function encodeKey(k) {
  return encodeURIComponent(k).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** 生成 COS 签名；params 为对象（会按字典序参与签名） */
function cosSignature(method, keyPath, params) {
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${now - 60};${now + 600}`;
  const signKey = hmac(SECRET_KEY, keyTime);

  const entries = Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k.toLowerCase(), String(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const httpParameters = entries.map(([k, v]) => `${encodeKey(k)}=${encodeKey(v)}`).join('&');
  const urlParamList = entries.map(([k]) => k).join(';');
  const httpHeaders = `host=${encodeKey(HOST)}`;
  const headerList = 'host';

  const httpString = [
    method.toLowerCase(),
    keyPath,
    httpParameters,
    httpHeaders,
    '',
  ].join('\n');

  const sha1Http = crypto.createHash('sha1').update(httpString).digest('hex');
  const stringToSign = `sha1\n${keyTime}\n${sha1Http}\n`;
  const signature = hmac(signKey, stringToSign);

  return (
    `q-sign-algorithm=sha1&q-ak=${SECRET_ID}&q-sign-time=${keyTime}` +
    `&q-key-time=${keyTime}&q-header-list=${headerList}` +
    `&q-url-param-list=${urlParamList}&q-signature=${signature}`
  );
}

function request(method, keyPath, params, body) {
  return new Promise((resolve, reject) => {
    const query = Object.entries(params || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeKey(k)}=${encodeKey(String(v))}`)
      .join('&');
    const p = query ? `${keyPath}?${query}` : keyPath;
    const auth = cosSignature(method, keyPath, params);

    const req = https.request(
      {
        hostname: HOST,
        path: p,
        method,
        headers: {
          Host: HOST,
          Authorization: auth,
          ...(body ? { 'Content-Type': 'application/octet-stream', 'Content-Length': Buffer.byteLength(body) } : {}),
        },
        timeout: 60000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, headers: res.headers, body: buf });
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${buf.toString('utf8').slice(0, 400)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

function toPath(key) {
  return '/' + String(key).split('/').map(encodeURIComponent).join('/');
}

function stripXmlTag(s, tag) {
  const m = s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : '';
}

async function cmdList(prefix) {
  const r = await request('GET', '/', { prefix: prefix || '', 'max-keys': 1000 });
  const xml = r.body.toString('utf8');
  const keys = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => {
    const blk = m[1];
    return {
      key: stripXmlTag(blk, 'Key'),
      size: Number(stripXmlTag(blk, 'Size') || 0),
      lastModified: stripXmlTag(blk, 'LastModified'),
    };
  });
  if (!keys.length) {
    console.log(`(空) prefix="${prefix || ''}"`);
    return;
  }
  console.log(`${'最后修改'.padEnd(22)} ${'大小'.padStart(10)}  Key`);
  for (const k of keys) {
    console.log(`${k.lastModified.padEnd(22)} ${String(k.size).padStart(10)}  ${k.key}`);
  }
  console.log(`\n共 ${keys.length} 个对象`);
}

async function cmdStat(key) {
  const r = await request('HEAD', toPath(key), {});
  console.log(`Key        : ${key}`);
  console.log(`存在       : 是`);
  console.log(`大小       : ${r.headers['content-length']} bytes`);
  console.log(`最后修改   : ${r.headers['last-modified']}`);
  console.log(`ETag       : ${r.headers.etag}`);
}

async function cmdGet(key, saveTo) {
  const r = await request('GET', toPath(key), {});
  if (saveTo) {
    fs.mkdirSync(path.dirname(path.resolve(saveTo)), { recursive: true });
    fs.writeFileSync(path.resolve(saveTo), r.body);
    console.log(`已保存: ${path.resolve(saveTo)}  (${r.body.length} bytes)`);
  } else {
    console.log(r.body.toString('utf8'));
  }
}

async function cmdPut(localFile, key) {
  const body = fs.readFileSync(path.resolve(localFile));
  await request('PUT', toPath(key), {}, body);
  console.log(`已上传: ${path.basename(localFile)} → cos://${BUCKET}/${key}  (${body.length} bytes)`);
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  const map = { list: () => cmdList(a), stat: () => cmdStat(a), get: () => cmdGet(a, b), put: () => cmdPut(a, b) };
  if (!map[cmd]) {
    console.error('用法: node cos-client.js list|stat|get|put ...');
    process.exit(1);
  }
  await map[cmd]();
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
