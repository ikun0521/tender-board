#!/usr/bin/env node
/**
 * 深圳地铁（cg.shenzhenmc.com）直连爬虫
 * 站点特征：服务端渲染 CMS，静态 .jhtml 页面，无反爬/无登录/无验证码。
 *   - 栏目：zzbgg(招标公告) / cghuowu(采购货物) / cgfuwu(采购服务) / cgshigong(采购施工)
 *   - 列表分页：/zzbgg/index.jhtml (第1页) ，/zzbgg/index_2.jhtml ... (第n页)
 *   - 列表项：<li><a href=...>标题</a><p>...发布时间：YYYY-MM-DD HH:mm:ss</p></li>
 *   - 详情页字段极规整：<th>标签</th><td>值</td>
 *       采购单位名称 / 公告开始时间(发布时间) / 递交文件截止时间(投标截止) / 文件获取截止时间 / 开标时间
 *
 * 用法：
 *   node scripts/crawl-szmetro.js [--detail] [--pages N] [--out FILE]
 *   --detail  抓取详情页抽取 采购单位名称 + 截止时间（默认仅列表）
 *   --pages N 每栏目爬取页数（默认 12，约覆盖近 1-2 个月）
 */
const fs = require('fs');
const path = require('path');
const BASE = 'https://cg.shenzhenmc.com';
const PLATFORM = '深圳轨道交通';
const REQUEST_INTERVAL = 350; // ms
const RECENCY_DAYS = 180; // 发布时间新鲜度窗口

// 招标公告 + 各采购栏目（货物/服务/施工都含设备标）
const CHANNELS = [
  { key: 'zzbgg', label: '招标公告' },
  { key: 'cghuowu', label: '采购货物' },
  { key: 'cgfuwu', label: '采购服务' },
  { key: 'cgshigong', label: '采购施工' },
];

// 地铁维保检修类补充关键词（具体设备/检修名词；不含过于宽泛的"地铁/车辆/列车"等，避免淹没看板）
const METRO_EXTRA = [
  '架修', '架大修', '大修', '检修', '维保', '运维', '探伤', '移车台', '落轮',
  '受电弓', '转向架', '轴承', '齿轮', '制动', '阀', '风机', '电机', '电源',
  '试验台', '试验设备', '检测设备', '工装', '工艺装备', '工装工具', '工装配件',
  '轮对', '车轮', '车轴', '车钩', '缓冲器', '传感器', '充电机', '空调', '车门',
  '站台门', '屏蔽门', '安全门', '打磨', '焊机', '起吊', '吊装', '立体库', '仓储',
  '清洗', '烘干', '喷漆', '架车机', '不落轮', '璇轮', '动平衡', '跑合',
];

const EXCLUDE_TITLE = /(中标候选人公示|中标结果公示|中标公告|结果公告|成交结果|直接采购公示|废旧|拍卖|遴选|比选结果|终止公告|延期公告|流标|废标|变更公告|澄清|答疑|补遗)/;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function loadKeywords() {
  const apiUrl = 'https://1457331256-984dniw11b.ap-guangzhou.tencentscf.com/api/keywords';
  let base = [];
  try {
    const res = await fetch(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      const arr = await res.json();
      if (Array.isArray(arr) && arr.length) {
        base = arr.map((k) => (typeof k === 'string' ? k : k.word || k.name || '')).filter(Boolean);
        console.error(`[关键词] 从 API 取得 ${base.length} 个`);
      }
    }
  } catch (e) {
    console.error('[关键词] API 失败，回退文件:', e.message);
  }
  if (!base.length) {
    const f = path.join(__dirname, '..', '产品关键词.txt');
    if (fs.existsSync(f)) base = fs.readFileSync(f, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  // 与地铁补充词取并集
  const set = new Set([...base, ...METRO_EXTRA]);
  return [...set];
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n');
}

// 解析详情页 <th>标签</th><td>值</td>
function parseDetail(html) {
  const pairs = {};
  const re = /<th[^>]*>([\s\S]{0,40}?)<\/th>\s*<td[^>]*>([\s\S]{0,200}?)<\/td>/gi;
  let m;
  while ((m = re.exec(html))) {
    let k = m[1].replace(/<[^>]+>/g, '').replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();
    const v = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (k && !(k in pairs)) pairs[k] = v;
  }
  return pairs;
}

function normalizeDate(s) {
  if (!s) return '';
  const m = s.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:\s*(\d{1,2}):(\d{2}))?/);
  if (!m) return '';
  const [, y, mo, d, hh, mm] = m;
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(mo)}-${pad(d)}` + (hh ? ` ${pad(hh)}:${pad(mm || '0')}` : '');
}

function extractUnit(pairs, bodyText) {
  if (pairs['采购单位名称']) return pairs['采购单位名称'];
  if (pairs['招标人']) return pairs['招标人'];
  if (pairs['采购人']) return pairs['采购人'];
  // 兜底：深圳地铁系单位（严格，仅匹配以组织后缀结尾、不含简介性文字的短名）
  const m = bodyText.match(/(深圳市地铁[^，。；：、\n]{0,16}(?:集团|有限公司|公司|运营有限公司|建设集团有限公司)?)/);
  if (m) {
    const u = m[1].trim();
    // 拒绝页脚简介类文本（含"成立/年/月/日/简介/电话"等）
    if (!/(成立|简介|电话|地址|年|月|日)/.test(u)) return u;
  }
  return '';
}

function isRecent(publish, refDate) {
  if (!publish) return false;
  const d = new Date(publish.replace(/[年月]/g, '-').replace(/日/g, '').replace(/\//g, '-'));
  if (isNaN(d.getTime())) return false;
  const cutoff = new Date(refDate);
  cutoff.setDate(cutoff.getDate() - RECENCY_DAYS);
  return d >= cutoff;
}

function isFutureDeadline(deadline, refDate) {
  if (!deadline) return true; // 未知视为通过
  const d = new Date(deadline.replace(/[年月]/g, '-').replace(/日/g, '').replace(/\//g, '-'));
  if (isNaN(d.getTime())) return true;
  return d >= new Date(refDate);
}

async function fetchList(channel, page) {
  const url = page <= 1 ? `${BASE}/${channel}/index.jhtml` : `${BASE}/${channel}/index_${page}.jhtml`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (res.status !== 200) return [];
  const html = await res.text();
  const items = [];
  // 锚定详情链接：<a href="BASE/channel/N.jhtml">标题</a>
  const re = new RegExp('<a\\s+href=["\']' + BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/' + channel + '/(\\d+)\\.jhtml["\'][^>]*>([\\s\\S]{0,120}?)</a>', 'gi');
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    const title = m[2].replace(/<[^>]+>/g, '').trim();
    if (title.length < 4) continue;
    // 就近抽取发布时间（</a> 之后 300 字符内）
    const tail = html.slice(m.index, m.index + 400);
    const dm = tail.match(/发布时间：\s*(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:\s*\d{1,2}:\d{1,2}(?::\d{1,2})?)?)/);
    const publish = dm ? normalizeDate(dm[1]) : '';
    items.push({ id, title, link: `${BASE}/${channel}/${id}.jhtml`, publish });
  }
  return items;
}

async function fetchDetail(link, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(link, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.status !== 200) { await sleep(REQUEST_INTERVAL); continue; }
      const html = await res.text();
      // 拦截/异常页（无任何公告标记）才重试
      if (!/采购单位名称|采购标段名称|项目信息|公告开始时间|计划发标时间/.test(html)) {
        await sleep(REQUEST_INTERVAL * 2);
        continue;
      }
      const pairs = parseDetail(html);
      const bodyText = stripTags(html);
      // 情况A：真实招标/采购公告（含采购单位名称 + 精确截止）
      if (pairs['采购单位名称']) {
        const submit = pairs['递交文件截止时间'] || '';
        const fileGet = pairs['文件获取截止时间'] || '';
        const open = pairs['开标时间'] || '';
        // 【2026-08-01】用户需求：截止=报名/获取文件截止 → 文件获取截止优先于递交截止
        const deadlineRaw = fileGet || submit || open || '';
        return {
          unit: pairs['采购单位名称'],
          publish: normalizeDate(pairs['公告开始时间'] || pairs['发布时间'] || ''),
          deadline: normalizeDate(deadlineRaw),
          dlSource: fileGet ? '文件获取截止' : submit ? '递交截止' : open ? '开标' : '',
        };
      }
      // 情况B：采购计划预告（采购标段名称 + 计划发标时间，无采购单位/无精确截止）
      if (pairs['采购标段名称']) {
        const plan = pairs['计划发标时间'] || '';
        return {
          unit: '深圳市地铁集团有限公司', // 预告页无采购人，深圳地铁项目默认归属集团
          publish: normalizeDate(pairs['公告开始时间'] || pairs['发布时间'] || ''),
          deadline: '待确认',
          dlSource: '计划预告(' + plan + ')',
        };
      }
      return null;
    } catch (e) {
      await sleep(REQUEST_INTERVAL);
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const withDetail = args.includes('--detail');
  const outFile = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'scripts/szmetro-candidates.json';
  const pagesArg = args.includes('--pages') ? parseInt(args[args.indexOf('--pages') + 1], 10) : 12;
  const PAGES = isNaN(pagesArg) || pagesArg < 1 ? 12 : pagesArg;

  const keywords = await loadKeywords();
  if (!keywords.length) { console.error('无关键词，退出'); process.exit(1); }
  const kwSet = new Set(keywords);
  const refDate = new Date().toISOString().slice(0, 10);

  console.error(`[开始] 关键词 ${keywords.length} 个，栏目 ${CHANNELS.length} 个，每栏 ${PAGES} 页，${withDetail ? '含详情' : '仅列表'}`);

  const collected = [];
  const seen = new Set();
  for (const ch of CHANNELS) {
    let chCount = 0;
    for (let p = 1; p <= PAGES; p++) {
      const items = await fetchList(ch.key, p);
      if (!items.length) break; // 该栏目已到末页
      for (const it of items) {
        if (seen.has(it.link)) continue;
        if (EXCLUDE_TITLE.test(it.title)) continue;
        // 关键词过滤（标题匹配）
        const hit = keywords.some((kw) => kw && it.title.includes(kw));
        if (!hit) continue;
        seen.add(it.link);
        collected.push(it);
        chCount++;
      }
      await sleep(REQUEST_INTERVAL);
    }
    console.error(`  [${ch.label}] 命中 ${chCount} 条`);
  }
  console.error(`[列表汇总] 候选 ${collected.length} 条`);

  const out = [];
  for (let i = 0; i < collected.length; i++) {
    const it = collected[i];
    let unit = '', publish = it.publish, deadline = '待确认', dlSource = '';
    if (withDetail) {
      const d = await fetchDetail(it.link);
      if (d) { unit = d.unit; publish = d.publish || publish; deadline = d.deadline || '待确认'; dlSource = d.dlSource; }
      if (i % 5 === 0) console.error(`  [详情] ${i + 1}/${collected.length} deadline=${deadline} unit=${unit || '(空)'}`);
      await sleep(REQUEST_INTERVAL);
    }
    // 新鲜度 + 活跃过滤
    if (!isRecent(publish, refDate)) { console.error(`    ✗ 过期发布 ${publish} 跳过: ${it.title.slice(0, 30)}`); continue; }
    if (!isFutureDeadline(deadline, refDate)) { console.error(`    ✗ 截止已过 ${deadline} 跳过: ${it.title.slice(0, 30)}`); continue; }

    const snip = [`采购人：${unit || '见公告'}`, `发布时间：${publish || '见公告'}`, `截止：${deadline}`].join('。');
    out.push({
      title: it.title,
      url: it.link,
      link: it.link,
      snippet: snip,
      keyword: '',
      _src: 'szmetro',
      deadline,
      unit,
      publish,
      deadlineSource: dlSource,
      platform: PLATFORM,
    });
  }

  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
  const withDl = out.filter((c) => c.deadline && c.deadline !== '待确认').length;
  const withUnit = out.filter((c) => c.unit).length;
  console.error(`[完成] 写出 ${out.length} 条 -> ${outFile} (含截止 ${withDl}, 含单位 ${withUnit})`);
}

if (require.main === module) {
  main().catch((e) => { console.error('[致命错误]', e.message); process.exit(1); });
}

module.exports = { fetchList, fetchDetail, parseDetail, normalizeDate, extractUnit, isRecent, isFutureDeadline, CHANNELS, BASE, PLATFORM };
