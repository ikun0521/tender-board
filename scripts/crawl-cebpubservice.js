#!/usr/bin/env node
/**
 * 中国招标投标公共服务平台（cebpubservice.com）直连爬虫 — 法定聚合兜底，覆盖全平台。
 *
 * 站点特征：
 *   - 公告数据在 bulletin.cebpubservice.com，搜索为服务端渲染（SSR）：
 *     GET /xxfbcmses/search/bulletin.html?searchDate=YYYY-MM-DD&dates=90&word=关键词&categoryId=88&page=N
 *     服务器直接返回含结果列表的 HTML（翻页由前端 fetch + document.write 实现）。
 *   - categoryId：88=招标公告 / 89=变更 / 90=结果 / 91=中标候选 / 92=资格预审（本爬虫只取 88 招标公告）。
 *   - 列表每一行已含全部所需字段（无需再抓详情页）：
 *       标题 + uuid（urlOpen('UUID')）→ 详情链接 ctbpsp.com/#/bulletinDetail?uuid=UUID
 *       发布时间（<td name="imgShow" id="YYYY-MM-DD HH:mm:ss">）
 *       行业（<span title="铁路">铁路</span>，用于滤除汽车/钢铁等非轨交噪音）
 *       地区、来源平台（包钢/必联/中招联合/各省招投标监管网… → "覆盖全平台"价值所在）
 *       开标时间（<td name="openTime" id="YYYY-MM-DD HH:mm:ss">）
 *       【注意】列表仅提供开标时间，无"报名/获取文件截止"字段；详情页与公告 PDF（ctbpsp.com）
 *       均需登录（403 未登录）。故 deadline 如实取开标时间并标注 deadlineSource='开标时间'，
 *       由看板显示"开标 08-11"前缀，避免伪装成报名截止。
 *   - vaptcha 在源码中已被注释禁用，基础搜索无需验证码。
 *   - 详情在 ctbpsp.com（Vue SPA，API 隐藏），故本爬虫只取列表字段；采购人(unit)列表无，留空由看板标"见公告"。
 *
 * 用法：
 *   node scripts/crawl-cebpubservice.js [--pages N] [--days N] [--out FILE] [--kw 关键词1,关键词2]
 *   --pages N  每关键词翻页上限（默认 5）
 *   --days N   服务端时间窗天数（默认 90，即近 3 个月）
 *   --out FILE 输出路径（默认 scripts/cebpubservice-candidates.json）
 *   --kw       逗号分隔的额外关键词（与内置轨交词取并集）
 */
const fs = require('fs');
const path = require('path');

const BASE = 'https://bulletin.cebpubservice.com';
const DETAIL = 'https://ctbpsp.com/#/bulletinDetail';
const PLATFORM = '中国招标投标公共服务平台';
const CATEGORY_ID = '88'; // 招标公告
const REQUEST_INTERVAL = 400; // ms，对国家级站点稍宽容
const RECENCY_DAYS = 120; // 发布时间新鲜度窗口（客户端兜底过滤）

// 轨交/铁路检修设备定向关键词（聚焦于铁路/城轨，避免全国站点被泛化词淹没）
// 注意：搜索词可适当宽泛（组件词如轴承也会搜），但最终保留由 INDUSTRY_WHITELIST + RAIL_TITLE 严格过滤
const RAIL_KEYWORDS = [
  '转向架', '受电弓', '落轮', '不落轮', '璇轮', '轮对', '车轮', '车轴', '车钩', '缓冲器',
  '轴承', '闸片', '碳滑板', '站台门', '屏蔽门', '安全门', '移车台', '架车机', '架车', '落轮机',
  '架修', '架大修', '铁水车', '矿车', '平板车', '漏斗车', '敞车', '罐车', '机车', '动车',
  '高铁', '地铁', '城轨', '轨道交通', '中车', '铁路', '钢轨', '道岔', '信号机', '转辙机',
  '应答器', '计轴', '联锁', '接触网', '供电', '牵引', '受流', '集电', '弹性车轮', '橡胶轮',
  '走行部', '钩缓', '空气弹簧', '抗侧滚', '构架', '摇枕', '侧架', '承载', '心盘', '旁承',
  '制动夹钳', '踏面', '车轮车床', '不落轮车床', '轮对探伤', '受电弓碳滑板', '油压减振',
  '减振器', '轴温', '车载', '列控', '信号系统',
];

// 行业白名单（列表 <span title> 值）：仅保留轨交/铁路相关，滤除矿产冶金/汽车/其他
const INDUSTRY_WHITELIST = new Set(['铁路', '轨道交通', '城市轨道', '地铁']);
// 标题强轨交信号（行业被标"其他/市政"时也借此保留）。
// 仅保留"铁路系统/实体"或"铁路专属部件"强信号词；刻意排除跨行业词：
//   架车(船闸斜架车)、平板车/罐车/矿车/敞车(公路/矿山/港口车)、齿轮箱(风电/直升机)、
//   轴承(摩托/风电)、风机(风电)、车轮/车轴(汽车)、构架/减振器(汽车) 等。
const RAIL_TITLE = /(铁路|地铁|城轨|中车|动车|高铁|轨道交通|列车|机车|车辆段|机务段|电务段|工务段|供电段|动车所|运用车间|检修车间|25[GKT]|CRH|CR\d{2}|有轨电车|磁浮|跨座式|转向架|受电弓|落轮|不落轮|璇轮|轮对|车钩|移车台|钢轨|道岔|转辙机|应答器|计轴|联锁|接触网|受流|碳滑板|闸片|制动夹钳|空气弹簧|车轮车床|不落轮车床|走行部|轴箱|轮对探伤|受电弓碳滑板|列控|信号系统)/;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function normalizeDate(s) {
  if (!s) return '';
  // 支持 "2026-07-20 14:30:00" / "2026-07-20" / "2026年07月20日 14:30"
  const m = s.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:\s*(\d{1,2}):(\d{2})(?::\d{2})?)?/);
  if (!m) return '';
  const [, y, mo, d, hh, mm] = m;
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(mo)}-${pad(d)}` + (hh ? ` ${pad(hh)}:${pad(mm || '0')}` : '');
}

function buildSearchUrl(word, page, days) {
  const sd = new Date();
  sd.setDate(sd.getDate() - days);
  const searchDate = sd.toISOString().split('T')[0];
  const q = encodeURIComponent(word);
  return `${BASE}/xxfbcmses/search/bulletin.html?searchDate=${searchDate}&dates=${days}` +
    `&word=${q}&categoryId=${CATEGORY_ID}&industryName=&area=&status=&publishMedia=&sourceInfo=&showStatus=&page=${page}`;
}

// 解析结果行：返回 { uuid, title, publish, industry, area, source, openTime }
function parseRows(html) {
  const rows = [];
  const rowRe = /<tr>([\s\S]{0,1600}?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html))) {
    const row = m[1];
    if (!/urlOpen\(/.test(row)) continue;
    const uuidM = row.match(/urlOpen\('([0-9a-f]+)'\)/);
    if (!uuidM) continue;
    const uuid = uuidM[1];
    const titleM = row.match(/urlOpen\('[^']+'\)"\s*title="([^"]*)"/) || row.match(/title="([^"]*)"[^>]*>\s*([\s\S]{0,100}?)<\/a>/);
    let title = (titleM ? titleM[1] : '').trim();
    if (!title) {
      const t2 = row.match(/>([^<]{4,100})<\/a>/);
      title = t2 ? t2[1].trim() : '';
    }
    if (title.length < 4) continue;
    const pubM = row.match(/name="imgShow"\s+id="([^"]+)"/);
    const publish = pubM ? normalizeDate(pubM[1]) : '';
    const spans = [...row.matchAll(/<span\s+title\s*=\s*"([^"]*)"\s*>([\s\S]*?)<\/span>/g)];
    const industry = spans[0] ? spans[0][2].trim() : '';
    const area = spans[1] ? spans[1][2].trim() : '';
    const openM = row.match(/name="openTime"\s+id="([^"]+)"/);
    const openTime = openM ? normalizeDate(openM[1]) : '';
    // 来源平台：area span 闭合后的 <td>文本，直到发布日期 <td>
    const srcM = row.match(/<\/span>\s*<\/td>\s*<td>\s*([^<]+?)\s*<\/td>\s*<td>\s*(\d{4}-\d{2}-\d{2})/);
    const source = srcM ? srcM[1].trim() : '';
    rows.push({ uuid, title, publish, industry, area, source, openTime });
  }
  return rows;
}

function isRailRelevant(industry, title) {
  if (INDUSTRY_WHITELIST.has(industry)) return true;
  if (RAIL_TITLE.test(title)) return true;
  return false;
}

function isRecent(publish, refDate) {
  if (!publish) return false;
  const d = new Date(publish.replace(' ', 'T'));
  if (isNaN(d.getTime())) return false;
  const cutoff = new Date(refDate);
  cutoff.setDate(cutoff.getDate() - RECENCY_DAYS);
  return d >= cutoff;
}

function isFutureDeadline(deadline, refDate) {
  if (!deadline) return false;
  const d = new Date(deadline.replace(' ', 'T'));
  if (isNaN(d.getTime())) return false;
  const t = new Date(refDate);
  t.setHours(0, 0, 0, 0);
  return d >= t;
}

async function fetchList(word, page, days) {
  const url = buildSearchUrl(word, page, days);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept': 'text/html, application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': 'https://bulletin.cebpubservice.com/xxfbcmses/search/bulletin.html',
    },
  });
  if (res.status !== 200) return [];
  const html = await res.text();
  return parseRows(html);
}

async function main() {
  const args = process.argv.slice(2);
  const pagesArg = args.includes('--pages') ? parseInt(args[args.indexOf('--pages') + 1], 10) : 5;
  const PAGES = isNaN(pagesArg) || pagesArg < 1 ? 5 : pagesArg;
  const daysArg = args.includes('--days') ? parseInt(args[args.indexOf('--days') + 1], 10) : 90;
  const DAYS = isNaN(daysArg) || daysArg < 1 ? 90 : daysArg;
  const outFile = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'scripts/cebpubservice-candidates.json';
  const kwArg = args.includes('--kw') ? args[args.indexOf('--kw') + 1] : '';

  let keywords = [...RAIL_KEYWORDS];
  if (kwArg) keywords = keywords.concat(kwArg.split(',').map((s) => s.trim()).filter(Boolean));

  const refDate = new Date().toISOString().slice(0, 10);
  console.error(`[开始] 关键词 ${keywords.length} 个，每词 ${PAGES} 页，时间窗 ${DAYS} 天，参考日 ${refDate}`);

  const collected = [];
  const noiseCollected = [];
  const seenUuid = new Set();
  for (const kw of keywords) {
    let kwCount = 0;
    let kwRails = 0;
    for (let p = 1; p <= PAGES; p++) {
      let rows;
      try {
        rows = await fetchList(kw, p, DAYS);
      } catch (e) {
        console.error(`  [${kw}] 第${p}页失败: ${e.message}`);
        break;
      }
      if (!rows.length) break; // 该词已到末页
      for (const r of rows) {
        if (seenUuid.has(r.uuid)) continue;
        if (!isRailRelevant(r.industry, r.title)) {
          // 收集被「噪音筛选」拦掉的条目，供前端「显示未筛选噪音」开关按需展示
          if (isRecent(r.publish, refDate)) {
            noiseCollected.push({
              ...r,
              url: `${DETAIL}?uuid=${r.uuid}&inpvalue=&dataSource=0&tenderAgency=`,
            });
          }
          continue;
        }
        seenUuid.add(r.uuid);
        collected.push(r);
        kwCount++;
        if (isRecent(r.publish, refDate)) kwRails++;
      }
      await sleep(REQUEST_INTERVAL);
    }
    if (kwCount) console.error(`  [${kw}] 命中 ${kwCount} 条 (近${RECENCY_DAYS}天 ${kwRails})`);
  }
  console.error(`[列表汇总] 候选 ${collected.length} 条`);

  // 过滤：新鲜度 + 活跃截止（开标时间须为未来，否则看板入库会被 deadline 正则拒掉）
  const out = [];
  for (const r of collected) {
    if (!isRecent(r.publish, refDate)) continue;
    const deadline = r.openTime || '待确认';
    if (deadline !== '待确认' && !isFutureDeadline(deadline, refDate)) {
      console.error(`    ✗ 开标已过 ${deadline} 跳过: ${r.title.slice(0, 30)}`);
      continue;
    }
    const url = `${DETAIL}?uuid=${r.uuid}&inpvalue=&dataSource=0&tenderAgency=`;
    const snip = [
      `来源平台：${r.source || '见公告'}（中国招标投标公共服务平台聚合）`,
      `采购人：见公告`,
      `发布时间：${r.publish || '见公告'}`,
      `开标/截止：${deadline}`,
    ].join('。');
    out.push({
      title: r.title,
      url,
      link: url,
      snippet: snip,
      keyword: '',
      _src: 'cebpubservice',
      deadline,
      deadlineSource: '开标时间', // 列表仅提供开标时间（详情/PDF 需登录），如实标注，不伪装成报名截止
      unit: '',
      publish: r.publish,
      sourcePlatform: r.source,
      industry: r.industry,
      area: r.area,
      platform: r.source || PLATFORM,
    });
  }

  fs.writeFileSync(path.resolve(__dirname, '..', outFile), JSON.stringify(out, null, 2), 'utf8');
  const withDl = out.filter((c) => c.deadline && c.deadline !== '待确认').length;
  console.error(`[完成] 写出 ${out.length} 条 -> ${outFile} (含开标截止 ${withDl})`);

  // 噪音（被 isRailRelevant 拦掉）条目 -> 供前端「显示未筛选噪音」开关按需展示
  const noiseOut = noiseCollected.map((r) => ({
    title: r.title,
    url: r.url,
    link: r.url,
    snippet: `来源平台：${r.source || '见公告'}（中国招标投标公共服务平台聚合）`,
    keyword: '',
    _src: 'cebpubservice-noise',
    deadline: r.openTime || '待确认',
    deadlineSource: '开标时间',
    unit: '',
    publish: r.publish,
    sourcePlatform: r.source,
    industry: r.industry,
    area: r.area,
    platform: r.source || PLATFORM,
    railRelevant: false,
  }));
  fs.writeFileSync(path.resolve(__dirname, '..', 'scripts/noise-candidates.json'), JSON.stringify(noiseOut, null, 2), 'utf8');
  console.error(`[噪音] 写出 ${noiseOut.length} 条被拦条目 -> scripts/noise-candidates.json`);
}

if (require.main === module) {
  main().catch((e) => { console.error('[致命错误]', e.message); process.exit(1); });
}

module.exports = { buildSearchUrl, parseRows, normalizeDate, isRailRelevant, fetchList, RAIL_KEYWORDS, BASE, PLATFORM };
