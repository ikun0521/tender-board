#!/usr/bin/env node
/**
 * 深圳阳光采购平台（www.szygcgpt.com）爬虫
 * =============================================================
 * 【站点特征】Vue 2 SPA，数据走 JSON 接口，无反爬/无登录/无验证码。
 *   - 列表接口 POST /app/home/pageGGList.do
 *     body: {page, rows, xmLeiXing:'', caiGouType:0, ggLeiXing:1(采购公告), keyWords:关键词, ...}
 *     → data.list[]：ggName(标题) / zbRName(招标人) / wjEndTime(截止,ms) / faBuTime(发布,ms) / bdBH(标段编号) / ggGuid
 *   - 列表自带全部字段，无需抓详情。
 *   - 详情页：/ygcg/detail?ggGuid=<ggGuid>
 * 【策略】逐关键词精确搜索（keyWords），按 发布时间近90天 + 截止未过期 过滤，去重后输出。
 * 用法：
 *   node scripts/crawl-szygcgpt.js [--days N] [--out FILE] [--gg-leixing N]
 */
const https = require('https');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const API = 'https://www.szygcgpt.com/app/home/pageGGList.do';
const PLATFORM = '深圳阳光采购';
const REQUEST_INTERVAL = 500; // ms（无挑战平台，可稍快）

// 噪音词（工程/生活/服务类无关公告）
const NOISE_WORDS = [
  '土建', '房建', '房屋', '厂房', '装修', '装饰', '幕墙', '门窗', '屋面', '道路', '公路',
  '桥梁', '隧道', '涵洞', '管网', '给排水', '供水', '排水', '污水处理', '水利', '市政',
  '站房', '道砟', '人行道', '围挡', '混凝土', '改扩建', '总承包', '土石方', '食堂',
  '宿舍', '办公楼', '酒店', '餐厅', '景观', '园林', '绿化', '保洁', '物业', '劳务',
  '保安', '印刷', '会议', '培训', '监理', '审计', '咨询', '广告', '空调', '电梯',
  '照明', '弱电', '安防', '消防', '家具', '办公用品', '食材', '伙食', '帆布', '服装',
  '钢筋', '钢材', '水泥', '砂石', '机动车', '汽车维修', '车辆租赁', '客车租赁', '出租车',
  '驾校', '汽车驾驶', '保险', '绿化养护', '垃圾清运', '钢结构', '临建', '网站', '软件',
  '信息系统', '数字化', '智能化', '资产评估', '股权转让', '法律顾问', '审计服务', '广告设计',
  '食品', '粮油', '饮用水', '办公设备租赁', '花卉', '苗木', '保洁服务', '物业外包',
  '设计服务', '方案设计', '修缮', '提升工程', '评估服务', '咨询服务', '法律服务',
  '跟拍', '宣传片', '特装', '考古', '勘探', '泊位研究', '装卸业务外包', '现场管理',
  '多式联运', '辅助业务', '监督评价', '内控',
];
const NOISE_RE = new RegExp('(' + NOISE_WORDS.join('|') + ')');
// 强相关行为词（标题含这些大概率是设备/检修类）
const ACTION_STRONG = [
  '维修', '大修', '维保', '试验', '检测', '配件', '备件', '工装', '试验台', '检修',
  '翻新', '改造', '探伤', '拆装', '压装', '清洗', '烘干', '磨合', '跑合', '试验机',
  '试验器', '试验装置', '试验设备', '测试台', '加热', '逆变', '充电机', '电源',
  '传感器', '转向架', '轴承', '受电弓', '车钩', '制动', '电机', '风机',
  '落轮', '架车', '移车台', '转盘', '升降平台', '作业平台', '工器具', '量具', '夹具',
  '吊具', '探伤仪', '监测', '测试', '设备', '机车', '车辆', '列车', '工程车', '静调',
  '保养', '养护', '液压', '气动', '机台', '机组', '泵', '压缩机', '冷库', '制冷',
  '叉车', '吊机', '装卸机械', '输送', '皮带机', '堆取料', '门机', '岸桥', '场桥', '岸吊',
];

/** 标题粗筛：设备关键词命中 或 强相关行为词命中（且非噪音/结果类） */
function isRelevant(title, keywords) {
  if (!title) return false;
  if (NOISE_RE.test(title)) return false;
  if (keywords.some((k) => k && title.includes(k))) return true;
  return ACTION_STRONG.some((w) => title.includes(w));
}

function getArg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 毫秒时间戳 → 北京时间 YYYY-MM-DD[ HH:mm] */
function ts2date(ms, withTime) {
  const n = Number(ms);
  if (!isFinite(n) || n <= 0) return '';
  const d = new Date(n + 8 * 3600 * 1000); // UTC+8
  const pad = (x) => String(x).padStart(2, '0');
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return withTime ? `${base} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : base;
}

/** 从 COS API 拉关键词，失败 fallback 产品关键词.txt */
async function loadKeywords() {
  const cli = getArg('keywords', '');
  if (cli) return cli.split(/[,，、]+/).map((s) => s.trim()).filter(Boolean);
  try {
    const txt = await new Promise((resolve, reject) => {
      https.get('https://1457331256-984dniw11b.ap-guangzhou.tencentscf.com/api/keywords', { timeout: 15000 }, (res) => {
        let d = ''; res.setEncoding('utf8'); res.on('data', (c) => (d += c)); res.on('end', () => resolve(d));
      }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
    });
    const arr = JSON.parse(txt);
    if (Array.isArray(arr) && arr.length) { console.log(`[关键词] 从 COS API 读取 ${arr.length} 个`); return arr; }
  } catch (e) { console.log(`[关键词] COS API 失败 (${e.message})，回退本地`); }
  const local = path.join(ROOT, '产品关键词.txt');
  if (fs.existsSync(local)) {
    const arr = fs.readFileSync(local, 'utf8').split(/[,，、\r\n]+/).map((s) => s.trim()).filter(Boolean);
    console.log(`[关键词] 从本地文件读取 ${arr.length} 个`);
    return arr;
  }
  throw new Error('无法获取关键词');
}

/** 调用列表接口 */
function queryGGList(keyWords, page, rows, ggLeiXing) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      page, rows, xmLeiXing: '', caiGouType: 0, ggLeiXing, isShiShuGuoQi: '', isZhanLueYingJiWuZi: '', keyWords,
    });
    const req = https.request(API, {
      method: 'POST', timeout: 20000,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.szygcgpt.com/ygcg/purchaseInfoList',
      },
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('非JSON响应')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const days = parseInt(getArg('days', '180'), 10) || 180;
  const ggLeiXing = parseInt(getArg('gg-leixing', '1'), 10) || 1;
  const outFile = path.resolve(ROOT, getArg('out', 'scripts/szygcgpt-candidates.json'));
  const keywords = await loadKeywords();

  console.log(`[配置] 关键词 ${keywords.length} 个 | 时间窗 ${days} 天 | 公告类型 ${ggLeiXing}(1=采购公告) | 间隔 ${REQUEST_INTERVAL}ms`);

  const now = Date.now();
  const cutoff = now - days * 24 * 3600 * 1000;
  const seen = new Set();
  const out = [];

  function push(x, src, kw) {
    const name = (x.ggName || '').trim();
    const faBu = Number(x.faBuTime) || 0;
    if (!name || faBu < cutoff) return;
    const key = x.bdBH || `${name}|${faBu}`;
    if (seen.has(key)) return;
    seen.add(key);
    const deadline = ts2date(Number(x.wjEndTime) || 0, true);
    out.push({
      name,
      unit: (x.zbRName || '').trim(),
      publish: ts2date(faBu, false),
      deadline: deadline || '待确认',
      deadlineSource: deadline ? 'wjEndTime' : 'none',
      link: `https://www.szygcgpt.com/ygcg/detail?ggGuid=${x.ggGuid || x.guid || ''}`,
      platform: PLATFORM,
      bdNo: (x.bdBH || '').trim(),
      xmLeiXing: x.xmLeiXing,
      noticeType: '采购公告',
      keyword: kw,
      _src: 'szygcgpt',
      src,
    });
  }

  // ---------- 1. 全量最新通道（无关键词，翻最新公告，标题粗筛） ----------
  console.log('\n[全量] 拉取最新公告（近' + days + '天），标题粗筛...');
  for (let p = 1; p <= 3; p++) {
    try {
      const j = await queryGGList('', p, 20, ggLeiXing);
      const list = (j.data && j.data.list) || [];
      let keep = 0;
      for (const x of list) {
        const faBu = Number(x.faBuTime) || 0;
        if (faBu < cutoff) { console.log(`  [第${p}页] 已越过 ${days} 天时间窗，停止`); p = 99; break; }
        if (isRelevant((x.ggName || '').trim(), keywords)) { push(x, 'full', '【阳光最新】'); keep++; }
      }
      console.log(`  [第${p}页] 浏览 ${list.length} 条，粗筛保留 ${keep}（累计 ${out.length}）`);
      if (!list.length || p === 99) break;
    } catch (e) {
      console.log(`  [第${p}页] 失败: ${e.message.slice(0, 60)}`);
      break;
    }
    await sleep(REQUEST_INTERVAL);
  }

  // ---------- 2. 关键词通道（精确搜索，时间窗 365 天） ----------
  const kwCutoff = now - 365 * 24 * 3600 * 1000;
  console.log('\n[关键词] 精确搜索（近 365 天）...');
  for (let k = 0; k < keywords.length; k++) {
    const kw = keywords[k];
    try {
      const j = await queryGGList(kw, 1, 20, ggLeiXing);
      const list = (j.data && j.data.list) || [];
      let added = 0;
      for (const x of list) {
        const faBu = Number(x.faBuTime) || 0;
        if (faBu < kwCutoff) continue;
        if (faBu >= cutoff) push(x, 'kw', kw);
        else {
          // 发布在 90 天外但 365 天内：仅当标题仍与关键词直接相关且未入过
          const key = x.bdBH || `${(x.ggName || '').trim()}|${faBu}`;
          if (!seen.has(key)) {
            seen.add(key);
            const deadline = ts2date(Number(x.wjEndTime) || 0, true);
            out.push({
              name: (x.ggName || '').trim(), unit: (x.zbRName || '').trim(),
              publish: ts2date(faBu, false),
              deadline: deadline || '待确认', deadlineSource: deadline ? 'wjEndTime' : 'none',
              link: `https://www.szygcgpt.com/ygcg/detail?ggGuid=${x.ggGuid || x.guid || ''}`,
              platform: PLATFORM, bdNo: (x.bdBH || '').trim(), xmLeiXing: x.xmLeiXing,
              noticeType: '采购公告', keyword: kw, _src: 'szygcgpt', src: 'kw365',
            });
          }
        }
        added++;
      }
      if (list.length) console.log(`  [${k + 1}/${keywords.length}] "${kw}" → ${list.length} 条，新增 ${added}`);
    } catch (e) {
      if (k % 10 === 0) console.log(`  [${k + 1}/${keywords.length}] "${kw}" 失败: ${e.message.slice(0, 50)}`);
    }
    await sleep(REQUEST_INTERVAL);
  }

  // 排序：发布时间新→旧
  out.sort((a, b) => (b.publish || '').localeCompare(a.publish || ''));

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');

  const withDl = out.filter((x) => x.deadline !== '待确认').length;
  const withUnit = out.filter((x) => x.unit).length;
  const bySrc = {};
  out.forEach((x) => { bySrc[x.src] = (bySrc[x.src] || 0) + 1; });
  console.log(`\n${'='.repeat(56)}`);
  console.log(`候选总数      : ${out.length} ${JSON.stringify(bySrc)}`);
  console.log(`有明确截止日期: ${withDl} (${out.length ? ((withDl / out.length) * 100).toFixed(1) : 0}%)`);
  console.log(`有招标单位    : ${withUnit} (${out.length ? ((withUnit / out.length) * 100).toFixed(1) : 0}%)`);
  console.log(`输出文件      : ${outFile}`);
  console.log('='.repeat(56));
}

main().catch((e) => { console.error('[致命错误]', e.message); process.exit(1); });
