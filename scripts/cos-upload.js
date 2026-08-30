/**
 * 临时工具：零依赖上传文件到 COS（XML API PutObject，手动签名）
 * 用法: node cos-upload.js <localFile> <cosKey>
 * 凭证取自环境变量 TENCENT_COS_SECRET_ID / TENCENT_COS_SECRET_KEY
 */
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

const SECRET_ID = process.env.TENCENT_COS_SECRET_ID;
const SECRET_KEY = process.env.TENCENT_COS_SECRET_KEY;
const BUCKET = process.env.TENCENT_COS_BUCKET || 'zhaobiao-1457331256';
const REGION = process.env.TENCENT_COS_REGION || 'ap-guangzhou';

function hmac(key, data) {
  return crypto.createHmac('sha1', key).update(data).digest('hex');
}

function cosSignature(method, pathname) {
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${now - 60};${now + 600}`;
  const signKey = hmac(SECRET_KEY, keyTime);
  const httpString = `${method.toLowerCase()}\n${pathname}\n\nhost=${BUCKET}.cos.${REGION}.myqcloud.com\n`;
  const sha1Http = crypto.createHash('sha1').update(httpString).digest('hex');
  const stringToSign = `sha1\n${keyTime}\n${sha1Http}\n`;
  const signature = hmac(signKey, stringToSign);
  return (
    `q-sign-algorithm=sha1&q-ak=${SECRET_ID}&q-sign-time=${keyTime}` +
    `&q-key-time=${keyTime}&q-header-list=host&q-url-param-list=&q-signature=${signature}`
  );
}

function putObject(localFile, key) {
  return new Promise((resolve, reject) => {
    const body = fs.readFileSync(localFile);
    const pathname = '/' + key.split('/').map(encodeURIComponent).join('/');
    const auth = cosSignature('PUT', pathname.toLowerCase());
    const req = https.request(
      {
        hostname: `${BUCKET}.cos.${REGION}.myqcloud.com`,
        path: pathname,
        method: 'PUT',
        headers: {
          Host: `${BUCKET}.cos.${REGION}.myqcloud.com`,
          Authorization: auth,
          'Content-Type': 'application/zip',
          'Content-Length': body.length,
        },
        timeout: 120000,
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          if (res.statusCode === 200) return resolve(d);
          reject(new Error(`status=${res.statusCode}: ${d.slice(0, 300)}`));
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.write(body);
    req.end();
  });
}

async function main() {
  const [localFile, key] = process.argv.slice(2);
  if (!localFile || !key) {
    console.error('用法: node cos-upload.js <localFile> <cosKey>');
    process.exit(1);
  }
  await putObject(path.resolve(localFile), key);
  console.log(`[上传] ${path.basename(localFile)} → cos://${BUCKET}/${key}`);
}

main().catch((e) => {
  console.error('上传失败:', e.message);
  process.exit(1);
});
