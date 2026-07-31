/**
 * 苏州轨道交通集团采购平台 直连爬虫
 * 站点：http://zzcg.sz-mtr.com （新点电子交易平台框架，静态详情页 + AJAX 列表接口）
 *
 * 列表接口：POST /EWB-FRONT/rest/GgSearchAction/getInfoMationList
 *   参数：siteGuid, categoryNum(栏目), kw(关键词), infoDate, pageIndex, pageSize, verificationCode, verificationGuid
 *   返回：{ AllCount, custom:[{ title, title2, infodate, infourl, index }] }
 * 详情页：GET /cgxx/002002/002002001/<YYYYMMDD>/<uuid>.html （Word 导出碎标签，需去标签抽取）
 *
 * 输出：scripts/suzhou-metro-candidates.json —— 供 _merge_candidates.js 合并
 *
 * 用法：
 *   node scripts/crawl-suzhou-metro.js                 # 仅列表（publish=infodate，无单位/截止）
 *   node scripts/crawl-suzhou-metro.js --detail        # 额外抓取详情页，抽取 招标单位/截止日期
 *   node scripts/crawl-suzhou-metro.js --detail --out xxx.json
 */

const fs = require('fs');
const path = require('path');
const { parseDeadline } = require('./lib/deadline-parser.js');

const BASE = 'http://zzcg.sz-mtr.com';
const SITE_GUID = '7eb5f7f1-9041-43ad-8e13-8fcb82ea831a';
const API = `${BASE}/EWB-FRONT/rest/GgSearchAction/getInfoMationList`;
const CATEGORY = '002002001'; // 招标/采购公告主栏目
const REQUEST_INTERVAL = 280; // ms
const PAGE_SIZE = 50;
const PLATFORM = '苏州轨道交通';

const EXCLUDE_TITLE = /(中标候选人公示|中标公告|结果公告|成交结果|直接采购公示|废旧|拍卖|遴选|比选结果|终止公告)/;

// 地铁维保类补充关键词（192 主词表未含、但地铁平台高度相关的词，如 架修委外/架大修设备采购）
const METRO_KEYWORDS = [
  '架修', '架大修', '移车台', '落轮', '落轮机', '工艺转向架', '转向架', '受电弓',
  '轴箱轴承', '轴承', '制动', '制动机', '风阀', '阀', '风机', '试验台',
  '检测设备', '检修设备', '电源', '直流电源', '工装', '车钩', '传感器', '架车机',
];
// 仅保留近 N 天发布的公告（苏州轨道搜索不带日期过滤，会翻出 2008 年的古董标）
const RECENCY_DAYS = 180;
function isRecent(publish, refDate) {
  if (!publish) return false;
  const d = new Date(publish.replace(/[年月]/g, '-').replace(/日/g, '').replace(/\//g, '-'));
  if (isNaN(d.getTime())) return false;
  const cutoff = new Date(refDate);
  cutoff.setDate(cutoff.getDate() - RECENCY_DAYS);
  return d >= cutoff;
}

// 截止日须为未来（或未知=待确认），剔除已过期项（与 95306 爬虫一致）
function isActiveDeadline(deadline, refDate) {
  if (!deadline || deadline === '待确认') return true;
  const d = new Date(deadline.replace(' ', 'T'));
  if (isNaN(d.getTime())) return true;
  return d >= new Date(refDate);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadKeywords() {
  // 优先 SCF API（与 runbook 一致），失败回退 产品关键词.txt
  const apiUrl = 'https://1457331256-984dniw11b.ap-guangzhou.tencentscf.com/api/keywords';
  let list = [];
  try {
    const res = await fetch(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      const arr = await res.json();
      if (Array.isArray(arr) && arr.length) {
        list = arr.map((k) => (typeof k === 'string' ? k : k.word || k.name || '')).filter(Boolean);
      }
    }
  } catch (e) {
    console.error('[关键词] API 失败，回退文件:', e.message);
  }
  if (!list.length) {
    const f = path.join(__dirname, '..', '产品关键词.txt');
    if (fs.existsSync(f)) list = fs.readFileSync(f, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  // 与地铁维保补充词取并集（去重）
  const merged = [...new Set([...list, ...METRO_KEYWORDS])];
  console.error(`[关键词] 主词 ${list.length} + 地铁补充 ${METRO_KEYWORDS.length} = 共 ${merged.length} 个`);
  return merged;
}

async function searchList(keyword, maxPages = 30) {
  const items = [];
  const seen = new Set();
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const body = new URLSearchParams({
      siteGuid: SITE_GUID,
      categoryNum: CATEGORY,
      kw: keyword,
      infoDate: '',
      pageIndex: String(pageIndex),
      pageSize: String(PAGE_SIZE),
      verificationCode: '',
      verificationGuid: '',
    });
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      console.error(`[列表] HTTP ${res.status} keyword=${keyword} page=${pageIndex}`);
      break;
    }
    const json = await res.json();
    const list = json.custom || [];
    if (!list.length) break;
    for (const it of list) {
      const url = BASE + it.infourl;
      if (seen.has(url)) continue;
      seen.add(url);
      items.push({
        title: (it.title || it.title2 || '').trim(),
        publish: (it.infodate || '').trim(),
        link: url,
        keyword,
      });
    }
    if (list.length < PAGE_SIZE) break;
    await sleep(REQUEST_INTERVAL);
  }
  return items;
}

function extractUnit(bodyText) {
  // 苏州轨道采购人通常是「苏州市轨道交通X公司/集团」，遇 空格/的/标点 即截断，避免连带后续从句
  let m = bodyText.match(/采购人[：:]\s*(苏州市轨道交通[^的\s，。；：、]{0,18}?(?:公司|集团|运营有限公司|建设有限公司|有限公司))/);
  if (m) return m[1].trim();
  m = bodyText.match(/采购人[：:]\s*(苏州轨道交通[^的\s，。；：、]{0,18}?(?:公司|集团|运营有限公司|有限公司))/);
  if (m) return m[1].trim();
  // 通用：采购人后跟带组织后缀的短名
  m = bodyText.match(/采购人[：:]\s*([^的\s，。；：\n]{2,16}?(?:公司|集团|研究院|院|所|局|中心|部|分公司|有限公司))/);
  if (m) return m[1].trim();
  // 兜底：正文中的苏州轨道交通系单位
  m = bodyText.match(/(苏州市轨道交通[^的\s，。；：、]{0,18}?(?:公司|集团|运营有限公司|有限公司))/);
  if (m) return m[1].trim();
  return '';
}

function extractPublish(bodyText, fallback) {
  const m = bodyText.match(/发布时间[：:]\s*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2})/);
  if (m) return m[1].replace(/年|月/g, '-').replace(/\//g, '-');
  return fallback || '';
}

async function fetchDetail(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const html = await res.text();
    const bodyText = stripTags(html);
    const publish = extractPublish(bodyText, '');
    const unit = extractUnit(bodyText);
    let deadline = '待确认';
    let dlSource = '';
    const parsed = parseDeadline(bodyText, publish);
    if (parsed && parsed.value) {
      deadline = String(parsed.value);
      dlSource = parsed.source || '';
    }
    return { publish, unit, deadline, dlSource };
  } catch (e) {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const withDetail = args.includes('--detail');
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0 ? args[outIdx + 1] : path.join(__dirname, 'suzhou-metro-candidates.json');

  const keywords = await loadKeywords();
  if (!keywords.length) { console.error('无关键词，退出'); process.exit(1); }

  const refDate = new Date();
  console.error(`[开始] 关键词 ${keywords.length} 个，栏目 ${CATEGORY}，${withDetail ? '含详情' : '仅列表'}，仅保留 ${RECENCY_DAYS} 天内发布`);

  const collected = [];
  const seen = new Set();
  let droppedOld = 0;
  for (const kw of keywords) {
    const items = await searchList(kw);
    let added = 0;
    for (const it of items) {
      if (seen.has(it.link)) continue;
      if (EXCLUDE_TITLE.test(it.title)) continue;
      if (!isRecent(it.publish, refDate)) { droppedOld++; continue; }
      seen.add(it.link);
      collected.push(it);
      added++;
    }
    if (added) console.error(`  [${kw}] +${added} (累计 ${collected.length})`);
    await sleep(REQUEST_INTERVAL);
  }

  console.error(`[列表汇总] 候选 ${collected.length} 条（剔除过期/古董 ${droppedOld} 条）`);

  const out = [];
  let expiredDropped = 0;
  for (let i = 0; i < collected.length; i++) {
    const it = collected[i];
    let unit = '', publish = it.publish, deadline = '待确认', dlSource = '';
    if (withDetail) {
      const d = await fetchDetail(it.link);
      if (d) { unit = d.unit; publish = d.publish || publish; deadline = d.deadline; dlSource = d.dlSource; }
      if (i % 10 === 0) console.error(`  [详情] ${i + 1}/${collected.length} deadline=${deadline} unit=${unit || '(空)'}`);
      await sleep(REQUEST_INTERVAL);
      if (!isActiveDeadline(deadline, refDate)) { expiredDropped++; continue; }
    }
    const snip = [
      `招标人/采购人:${unit || '见公告'}`,
      `发布时间:${publish || '见公告'}`,
      `截止:${deadline}`,
    ].join('。');
    out.push({
      name: it.title,
      link: it.link,
      url: it.link,
      snippet: snip,
      keyword: it.keyword,
      unit,
      publish,
      deadline,
      deadlineSource: dlSource,
      platform: PLATFORM,
      _src: 'suzhou-metro',
    });
  }

  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
  const withDl = out.filter((c) => c.deadline && c.deadline !== '待确认').length;
  const withUnit = out.filter((c) => c.unit).length;
  console.error(`[完成] 写出 ${out.length} 条 -> ${outFile} (含截止 ${withDl}, 含单位 ${withUnit}，剔除过期 ${expiredDropped})`);
}

if (require.main === module) {
  main().catch((e) => { console.error('[致命错误]', e.message); process.exit(1); });
}

module.exports = { searchList, fetchDetail, extractUnit, extractPublish, API, CATEGORY, SITE_GUID, PLATFORM, stripTags };
