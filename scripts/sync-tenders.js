/**
 * 招标信息同步脚本
 *
 * 用法：
 *   node scripts/sync-tenders.js
 *   node scripts/sync-tenders.js --input scripts/search-results.json
 *
 * 说明：
 * - 默认从后端 API 读取关键词，失败时 fallback 到 产品关键词.txt
 * - 搜索优先读取 --input / TENDER_SEARCH_RESULTS 提供的候选列表；
 *   未提供时尝试 DuckDuckGo HTML 搜索作为兜底（可能被反爬）。
 * - 抓取公告详情后按规则提取投标截止日期。
 * - 去重、分配优先级、更新 index.html、自动归档截止日期已过的记录、Git 提交推送。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { parseDeadline, normalizeDeadlineText, isNormalizedDeadline } = require('./lib/deadline-parser');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'index.html');
const BACKUP_PATH = path.join(ROOT, 'index_backup.html');
const KEYWORDS_FILE = path.join(ROOT, '产品关键词.txt');
const API_BASE = 'https://1457331256-984dniw11b.ap-guangzhou.tencentscf.com';

const EXCLUDED_TERMS = ['驾校', '汽车驾驶', '客车租赁', '租车', '驾驶培训'];
const FIRST_HAND_DOMAINS = [
  { domain: 'cg.95306.cn', name: '国铁采购平台' },
  { domain: 'crrcgo.cc', name: '中车购2.0平台' },
  { domain: 'cg.shenzhenmc.com', name: '深圳地铁智能招采管理平台' },
  { domain: 'eps.shmetro.com', name: '上海地铁采购平台' },
  { domain: 'ggzyfw.beijing.gov.cn', name: '北京市公共资源交易中心' },
  { domain: 'ggzyjy.shandong.gov.cn', name: '青岛市公共资源交易电子服务系统' },
  { domain: 'ggzy.xinjiang.gov.cn', name: '新疆公共资源交易网' },
  { domain: 'jxszwsjb.jiaxing.gov.cn', name: '嘉兴市公共资源交易网' },
  { domain: 'ggzyjy.sc.gov.cn', name: '四川省公共资源交易信息网' },
  { domain: 'chinabidding.cn', name: '中国招标投标公共服务平台' },
  { domain: 'cebpubservice.com', name: '中国招标投标公共服务平台' },
  { domain: 'tjgdjt.com', name: '天津轨道交通集团' },
  { domain: 'jac.com.cn', name: '安徽江淮汽车集团' },
];

const THIRD_PARTY_DOMAINS = [
  { domain: 'qianlima.com', name: '千里马招标网' },
  { domain: 'dlzb.com', name: '电力招标网' },
  { domain: 'coopaa.com', name: '建设招标网' },
  { domain: 'zhiliaobiaoxun.cn', name: '知了标讯' },
  { domain: 'zhaobiao.cn', name: '招标网' },
  { domain: 'jianyu360.cn', name: '剑鱼标讯' },
  { domain: 'jiancezhaobiao.com', name: '检测招标网' },
  { domain: '86ztbb.com', name: '中拓招标网' },
  { domain: 'szhbuy.com', name: '商智荟招采' },
  { domain: 'bidnews.cn', name: '标讯天下' },
  { domain: 'ccpc360.com', name: '招标采购导航网' },
  { domain: 'anfangzhaobiao.com', name: '安防招标网' },
];

const PLATFORM_DOMAINS = [...FIRST_HAND_DOMAINS, ...THIRD_PARTY_DOMAINS];

const FIELD_ORDER = ['id', 'name', 'unit', 'category', 'publish', 'deadline', 'link', 'platform', 'priority'];

function log(...args) {
  console.log(...args);
}

function readFile(path) {
  try {
    return fs.readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function detectEOL(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function splitLines(text) {
  return text.split(/\r?\n/);
}

function joinLines(lines, eol) {
  return lines.join(eol);
}

// ---------- 关键词 ----------

async function fetchKeywords() {
  try {
    const res = await fetch(`${API_BASE}/api/keywords`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length) return data;
    }
  } catch (e) {
    log('  API 关键词获取失败，使用本地文件 fallback:', e.message);
  }
  const txt = readFile(KEYWORDS_FILE);
  if (!txt) return [];
  return txt
    .split(/[,，、\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

// ---------- 招标数据加载与保存 ----------

function loadTendersFromHtml(html) {
  const match = html.match(/let tenders = \[[\s\S]*?\n\s*\];/m);
  if (!match) throw new Error('无法定位 tenders 数组');
  const arrText = match[0].replace(/^let tenders = /, '').replace(/;\s*$/, '');
  return new Function('return ' + arrText)();
}

function parseTenderBlocks(html) {
  const lines = splitLines(html);
  const result = [];
  let arrayStartLine = -1;
  let arrayEndLine = -1;

  for (let i = 0; i < lines.length; i++) {
    if (/let tenders = \[/.test(lines[i])) arrayStartLine = i;
    if (arrayStartLine !== -1 && /^\s*\];\s*$/.test(lines[i])) {
      arrayEndLine = i;
      break;
    }
  }

  if (arrayStartLine === -1 || arrayEndLine === -1) {
    throw new Error('无法定位 tenders 数组边界');
  }

  let depth = 1; // 已在数组 [ 内部
  let objStart = -1;
  let currentId = null;
  for (let i = arrayStartLine + 1; i < arrayEndLine; i++) {
    const line = lines[i];
    const openCount = (line.match(/\{/g) || []).length;
    const closeCount = (line.match(/\}/g) || []).length;

    if (depth === 1 && openCount > 0) {
      objStart = i;
      currentId = null;
    }

    if (objStart !== -1 && currentId === null) {
      const idMatch = line.match(/"id"\s*:\s*(\d+|"[^"]+")/);
      if (idMatch) currentId = idMatch[1].replace(/^"|"$/g, '');
    }

    depth += openCount - closeCount;

    if (objStart !== -1 && depth === 1 && closeCount > 0) {
      result.push({ id: currentId, start: objStart, end: i });
      objStart = -1;
    }
  }

  return { lines, arrayStartLine, arrayEndLine, blocks: result };
}

function formatTender(t, objIndent = 12, fieldIndent = 24) {
  const objSpace = ' '.repeat(objIndent);
  const fieldSpace = ' '.repeat(fieldIndent);
  const out = [objSpace + '{'];
  const presentKeys = FIELD_ORDER.filter((k) => k in t);
  for (let i = 0; i < presentKeys.length; i++) {
    const key = presentKeys[i];
    const comma = i < presentKeys.length - 1 ? ',' : '';
    out.push(fieldSpace + `"${key}": ${JSON.stringify(t[key])}${comma}`);
  }
  out.push(objSpace + '}');
  return out.join('\n');
}

function buildUpdatedArray(html, keptBlocks, newTenders) {
  const { lines, arrayStartLine, arrayEndLine } = parseTenderBlocks(html);
  const eol = detectEOL(html);
  const out = [];

  // 数组声明行
  out.push(lines[arrayStartLine]);

  // 保留的历史对象
  const keptLines = [];
  for (const b of keptBlocks) {
    for (let i = b.start; i <= b.end; i++) keptLines.push(lines[i]);
  }
  if (keptLines.length) {
    out.push(...keptLines);
  }

  // 修正最后一个保留对象的逗号
  if (keptLines.length) {
    const idx = out.length - 1;
    const lastLine = out[idx];
    const hasComma = lastLine.trim().endsWith(',');
    if (newTenders.length && !hasComma) {
      out[idx] = lastLine + ',';
    } else if (!newTenders.length && hasComma) {
      out[idx] = lastLine.replace(/,\s*$/, '');
    }
  }

  // 新增对象
  if (newTenders.length) {
    for (let i = 0; i < newTenders.length; i++) {
      out.push(formatTender(newTenders[i]) + (i < newTenders.length - 1 ? ',' : ''));
    }
  }

  // 结束行
  out.push(lines[arrayEndLine]);

  const before = lines.slice(0, arrayStartLine);
  const after = lines.slice(arrayEndLine + 1);
  const newLines = [...before, ...out, ...after];
  let newHtml = joinLines(newLines, eol);
  return newHtml;
}

function saveTenders(html, tendersToKeep, newTenders) {
  const { blocks } = parseTenderBlocks(html);
  const archiveIds = new Set();
  const keptBlocks = blocks.filter((b) => {
    const keep = tendersToKeep.some((t) => String(t.id) === String(b.id));
    if (!keep) archiveIds.add(b.id);
    return keep;
  });

  let newHtml = buildUpdatedArray(html, keptBlocks, newTenders);

  // 更新统计信息
  const total = tendersToKeep.length + newTenders.length;
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = `${dateStr} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  newHtml = newHtml.replace(
    /(<span id="totalCount"[^>]*>)[^<]+(<\/span>)/,
    `$1${total}$2`
  );
  newHtml = newHtml.replace(
    /(<span class="text-sm text-slate-500">最近更新：)[^<]+(<\/span>)/,
    `$1${timeStr}$2`
  );
  newHtml = newHtml.replace(
    /(数据来源：招标信息汇总\.md \| 生成时间：)\d{4}-\d{2}-\d{2}/,
    `$1${dateStr}`
  );

  fs.copyFileSync(HTML_PATH, BACKUP_PATH);
  fs.writeFileSync(HTML_PATH, newHtml, 'utf-8');

  return { archiveIds: Array.from(archiveIds), total };
}

// ---------- 搜索与抓取 ----------

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : undefined;
}

async function loadCandidates(keywords) {
  const inputPath = getArg('--input') || process.env.TENDER_SEARCH_RESULTS;
  if (inputPath) {
    log(`使用候选文件: ${inputPath}`);
    const data = JSON.parse(readFile(path.resolve(ROOT, inputPath)) || '[]');
    return Array.isArray(data) ? data : [];
  }

  log('未提供候选文件，尝试 DuckDuckGo 搜索（可能被限制）...');
  const all = [];
  for (const kw of keywords) {
    const results = await duckSearch(`${kw} 招标公告 2026`);
    for (const r of results) {
      all.push({ ...r, keyword: kw });
    }
  }
  return all;
}

async function duckSearch(query) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const results = [];
    // DuckDuckGo HTML 结果
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && results.length < 10) {
      const rawHref = m[1];
      const title = stripHtml(m[2]).trim();
      const link = decodeDuckLink(rawHref);
      if (link && title) results.push({ title, url: link, snippet: '' });
    }
    return results;
  } catch (e) {
    log('  DuckDuckGo 搜索失败:', e.message);
    return [];
  }
}

function decodeDuckLink(href) {
  try {
    if (href.startsWith('http')) return href;
    const u = new URL(href, 'https://duckduckgo.com');
    const real = u.searchParams.get('uddg');
    if (real) return decodeURIComponent(real);
  } catch {}
  return null;
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&\w+;/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchPageText(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    log(`  抓取失败 ${url}: ${e.message}`);
    return null;
  }
}

function isCaptchaPage(html, url) {
  const text = stripHtml(html).replace(/\s+/g, ' ');
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripHtml(titleMatch[1]).trim() : '';
  // 国铁采购平台常见验证码页标题为"公告详情"且正文极短
  if (title === '公告详情' && text.length < 800) return true;
  if (/验证码|captcha|滑动验证|请完成验证|访问验证|安全验证/.test(text)) return true;
  return false;
}

function isReasonableDateStr(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  const year = d.getFullYear();
  return year >= 2024 && year <= 2027;
}

const UNIT_BLACKLIST = [
  '不予受理', '将予以拒收', '点击查看', '招标编号', '招标估价', '招标代理机构', '采购代理机构',
  '代理', '项目名称', '采购联系人', '报名截止', '未送达', '逾期送达', '拒收', '详见', '见附件',
  '无', '待定', '招标公告', '采购公告', '请 注册 查看', '注册 查看', '地 址', '地址',
  '及其所属单位', '及实际需求企业', '关于本项目', '应及时向', '符合国家及国家', '侵权投诉',
  '原设备的维修', '维修义务', '有关规定期限执行', '（盖章）', '盖章', '将于', '网上发布',
  '补充（答疑、澄清）', '答疑、澄清', '投标', '对采购标的物产品质量处罚', '不允许参加该标的物的投标',
  '取消招标资格', '处罚期内的供应商', '相应处理的', '对上述费用均不承担任何责任',
  '不承担任何责任', '对上述', '及上级母公司列入黑名单', '列入黑名单', '上级母公司',
  '因质量', '履约', '廉洁', '负面影响', '产品质量'
];

const UNIT_SUFFIX_RE = /(?:公司|集团|局|段|所|厂|院|中心|部|处|分公司|有限公司|股份公司|指挥部|办公室|分公司)$/;

function isValidUnit(unit) {
  if (!unit) return false;
  const s = unit.trim();
  if (s.length < 4 || s.length > 50) return false;
  if (/^[的为：:\s]/.test(s)) return false;
  if (/^\d/.test(s)) return false;
  if (/[,，。；：！？*]/.test(s)) return false;
  if (/\s{2,}/.test(s)) return false;
  if (/\d{4,}/.test(s)) return false;          // 过滤银行账号、联行号等
  if (/202[4-7]年/.test(s)) return false;     // 过滤误抓的日期句
  if (!UNIT_SUFFIX_RE.test(s)) return false;  // 必须以组织机构后缀结尾
  return !UNIT_BLACKLIST.some((w) => s.includes(w));
}

function cleanUnit(s) {
  if (!s) return '';
  return s
    .replace(/^[的为：:\s]+/, '')
    .replace(/\s*(?:招标代理机构|采购代理机构|代理|联系地址|详细地址|地\s*址|电\s*话|邮\s*编|传\s*真|开\s*户|招标中心|联行号|户名|开户行|银行账号|账号|采购单位|发布|补充|项目编号|项目名称|采购联系人|报名截止时间|报名|售价|文件|截止时间|时间|条件|要求|详见|附件).*$/, '')
    .replace(/[\s]+/g, ' ')
    .replace(/\d+$/, '')
    .trim();
}

function normalizeUnitText(text) {
  if (!text) return '';
  return text
    .replace(/招\s*标\s*人/g, '招标人')
    .replace(/采\s*购\s*人/g, '采购人')
    .replace(/采\s*购\s*单\s*位\s*名\s*称/g, '采购单位名称')
    .replace(/地\s*址/g, '地址')
    .replace(/电\s*话/g, '电话')
    .replace(/邮\s*编/g, '邮编')
    .replace(/开\s*户/g, '开户');
}

function extractUnitByLabel(text) {
  if (!text) return '';
  const normalized = normalizeUnitText(text);
  const labelRe = /(?:招标人|采购人|采购单位名称|招标单位|采购单位|招标人为|采购人为|项目单位|建设单位|业主单位)[：:为]?\s*([\u4e00-\u9fa5（）()][^,，.。;；:：!！?？\n\r]{2,50}?)(?=[,，.。;；:：!！?？\n\r]|\s*(?:招标代理机构|采购代理机构|代理|联系地址|详细地址|地址|电话|邮编|传真|开户|招标中心|联行号|户名|开户行|银行账号|账号|采购单位|发布|补充|项目编号|项目名称|采购联系人|报名截止时间|报名|售价|文件|截止时间|时间|条件|要求|详见|附件))/gi;
  const entrustRe = /受\s*([\u4e00-\u9fa5（）()][^,，.。;；:：!！?？\n\r]{2,50}?)\s*委托/gi;
  let best = '';
  let m;
  while ((m = labelRe.exec(normalized)) !== null) {
    const candidate = cleanUnit(m[1]);
    if (isValidUnit(candidate) && candidate.length > best.length) best = candidate;
  }
  while ((m = entrustRe.exec(normalized)) !== null) {
    const candidate = cleanUnit(m[1]);
    if (isValidUnit(candidate) && candidate.length > best.length) best = candidate;
  }
  return best;
}

function extractUnitFromTitle(title) {
  if (!title) return '';
  const patterns = [
    /中国铁路[\u4e00-\u9fa5]+局集团有限公司[\u4e00-\u9fa5]+(?:段|所|厂|车间|分公司|处)/,
    /中国铁路[\u4e00-\u9fa5]+局集团有限公司/,
    /中国铁路[\u4e00-\u9fa5]+局集团[\u4e00-\u9fa5]+(?:段|所|厂|车间|分公司|处)/,
    /[\u4e00-\u9fa5]+(?:局集团|局集团公司)[\u4e00-\u9fa5]+(?:段|所|厂|车间|分公司|处)/,
    /[\u4e00-\u9fa5]+局[\u4e00-\u9fa5]+(?:段|所|厂|车间|分公司|处)/,
    /[\u4e00-\u9fa5]+(?:有限公司|股份公司|集团)[\u4e00-\u9fa5]*(?:段|所|厂|车间|分公司|处|部|中心)/,
    /中车[\u4e00-\u9fa5]+(?:有限公司|股份公司|集团有限公司|集团)/,
    /[\u4e00-\u9fa5]+地铁[\u4e00-\u9fa5]*(?:有限公司|分公司|集团)/,
    /安徽江淮汽车[\u4e00-\u9fa5]*(?:有限公司|集团|股份公司)/,
    /天津轨道交通[\u4e00-\u9fa5]*(?:有限公司|集团)/,
    /^([\u4e00-\u9fa5]+?)(?:202[4-7]|\d{4}年)/,
  ];
  for (const re of patterns) {
    const m = title.match(re);
    if (m) {
      const s = m[0].replace(/(?:采购|招标)?公告$/, '').trim();
      if (isValidUnit(s)) return s;
    }
  }
  return '';
}

function unitQualityScore(s) {
  if (!s) return -1;
  const nonChinese = (s.match(/[^\u4e00-\u9fa5]/g) || []).length;
  // 优先中文多、特殊符号少的； hyphen/括号少量扣分
  return s.length - nonChinese * 2;
}

function extractUnit(text, title) {
  const fromLabel = extractUnitByLabel(text);
  const fromTitle = extractUnitFromTitle(title || '');
  if (!fromLabel) return fromTitle || '';
  if (!fromTitle) return fromLabel;
  return unitQualityScore(fromTitle) > unitQualityScore(fromLabel) ? fromTitle : fromLabel;
}

function detectPlatformByText(title, text, url) {
  const combined = `${title || ''} ${text || ''} ${url || ''}`.toLowerCase();
  const rules = [
    { name: '国铁采购平台', kw: ['国铁采购平台', 'cg.95306.cn'] },
    { name: '中车购2.0平台', kw: ['中车购', 'crrcgo.cc'] },
    { name: '上海地铁采购平台', kw: ['上海地铁', 'eps.shmetro.com'] },
    { name: '深圳地铁智能招采管理平台', kw: ['深圳地铁', '深铁运营', 'cg.shenzhenmc.com'] },
    { name: '北京市公共资源交易中心', kw: ['北京公共资源', 'ggzyfw.beijing.gov.cn'] },
    { name: '青岛市公共资源交易电子服务系统', kw: ['青岛公共资源', 'ggzyjy.shandong.gov.cn'] },
    { name: '新疆公共资源交易网', kw: ['新疆公共资源', 'ggzy.xinjiang.gov.cn'] },
    { name: '嘉兴市公共资源交易网', kw: ['嘉兴公共资源', 'jxszwsjb.jiaxing.gov.cn'] },
    { name: '四川省公共资源交易信息网', kw: ['四川公共资源', 'ggzyjy.sc.gov.cn'] },
    { name: '中国招标投标公共服务平台', kw: ['中国招标投标公共服务', 'chinabidding.cn', 'cebpubservice.com'] },
    { name: '天津轨道交通集团', kw: ['天津轨道交通', '津铁科技', 'tjgdjt.com'] },
    { name: '安徽江淮汽车集团', kw: ['江淮汽车', 'jac.com.cn'] },
    { name: '千里马招标网', kw: ['千里马', 'qianlima.com'] },
    { name: '电力招标网', kw: ['电力招标网', 'dlzb.com'] },
    { name: '建设招标网', kw: ['建设招标网', 'coopaa.com'] },
    { name: '知了标讯', kw: ['知了标讯', 'zhiliaobiaoxun.cn'] },
    { name: '招标网', kw: ['招标网', 'zhaobiao.cn'] },
    { name: '剑鱼标讯', kw: ['剑鱼标讯', 'jianyu360.cn'] },
    { name: '检测招标网', kw: ['检测招标网', 'jiancezhaobiao.com'] },
    { name: '商智荟招采', kw: ['商智荟', 'szhbuy.com'] },
    { name: '中拓招标网', kw: ['中拓招标网', '86ztbb.com'] },
    { name: '招标采购导航网', kw: ['招标采购导航', 'ccpc360.com'] },
    { name: '标讯天下', kw: ['标讯天下', 'bidnews.cn'] },
    { name: '安防招标网', kw: ['安防招标网', 'anfangzhaobiao.com'] },
  ];
  for (const r of rules) {
    if (r.kw.some((k) => combined.includes(k))) return r.name;
  }
  return detectPlatform(url);
}

async function extractFromPage(html, url, keyword, candidateTitle, snippet = '') {
  let text = stripHtml(html);
  // 如果是一手平台但返回验证码/登录页，则主要依赖 snippet
  if (isFirstHand(url) && isCaptchaPage(html, url)) {
    if (!snippet) {
      log(`  一手平台页面为验证码且无 snippet，跳过: ${url}`);
      return null;
    }
    log(`  一手平台页面为验证码，使用 snippet 提取信息: ${url}`);
    text = snippet;
  }
  const combinedText = text + '\n' + snippet;

  // 标题：优先使用搜索结果传入的标题，fallback 到页面 title/h1
  let name = '';
  if (candidateTitle && candidateTitle.length > 5) {
    name = candidateTitle.trim();
  } else {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    name = stripHtml(titleMatch ? titleMatch[1] : h1Match ? h1Match[1] : '');
  }
  if (!name) name = text.slice(0, 120);

  // 发布时间
  let publish = null;
  const pubRe = /(?:发布|公告|采购)时间[：:]?\s*(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?)/i;
  const pubMatch = combinedText.match(pubRe);
  if (pubMatch) publish = normalizeDate(pubMatch[1]);
  if (!publish) {
    // 取正文中第一个合理的日期（过滤版权等旧日期）
    const allDates = [...combinedText.matchAll(/\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?/g)]
      .map((m) => normalizeDate(m[0]))
      .filter(Boolean)
      .filter(isReasonableDateStr);
    if (allDates.length) publish = allDates[0];
  }
  if (!publish) publish = new Date().toISOString().split('T')[0];

  // 招标单位
  const unit = extractUnit(combinedText, name);

  // 截止日期
  const parsed = parseDeadline(combinedText, publish);
  const deadline = parsed && parsed.value ? parsed.value : '待确认';

  // 平台：根据公告标题/正文/链接域名判断，公告链接保持原始来源
  const platform = detectPlatformByText(name, combinedText, url);

  // 类别
  const category = keyword || '未分类';

  return { name, unit, category, publish, deadline, link: url, platform };
}

// 优先采用国铁(95306) / 中车购(crrcgo) 爬虫已得的结构化字段作为权威来源。
// 不再重新抓取候选页并重抽，避免 JS 渲染页 / 反爬导致字段丢失或被错抽历史日期。
// 仅当结构化字段缺失（如 WebSearch 候选）时才退化到 fetch + extractFromPage。
function buildInfoFromStructured(c) {
  const name = (c.title || '').trim();
  if (!name) return null;
  let deadline = (c.deadline || '').trim();
  if (!deadline || deadline === '待确认' || deadline === 'null') deadline = '待确认';
  const publish = (c.publish || '').trim() || new Date().toISOString().split('T')[0];
  const unit = (c.unit || '').trim();
  const platform = c.platform || detectPlatformByText(name, (c.snippet || '') + ' ' + name, c.url) || detectPlatform(c.url);
  const category = c.keyword || c.category || '未分类';
  return { name, unit, category, publish, deadline, link: c.url, platform };
}

function isFirstHand(url) {
  try {
    const host = new URL(url).hostname;
    return FIRST_HAND_DOMAINS.some((p) => host.includes(p.domain));
  } catch {
    return false;
  }
}

function normalizeDate(str) {
  if (!str) return null;
  const m = str
    .replace(/日$/, '')
    .match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})$/);
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function detectPlatform(url) {
  try {
    const host = new URL(url).hostname;
    for (const p of PLATFORM_DOMAINS) {
      if (host.includes(p.domain)) return p.name;
    }
  } catch {}
  return '其他';
}

// ---------- 过滤、去重、优先级 ----------

function isExcluded(text) {
  return EXCLUDED_TERMS.some((term) => text.includes(term));
}

function normalizeName(name) {
  return name.replace(/\s+/g, '').replace(/[\uff08\uff09]/g, '').trim();
}

function daysUntil(deadline) {
  if (!deadline || !isNormalizedDeadline(deadline)) return null;
  const d = new Date(deadline);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

/**
 * 截止日期是否已过：截止日当天仍视为有效（保留），从次日起移除。
 * 仅对 deadline 明确（YYYY-MM-DD[ HH:mm]）的条目生效；「待确认」返回 false（留给发布超 30 天规则兜底）。
 * 用于自动归档剔除规则：原「已查阅满 30 天」改为「截止日期一过即归档」。
 */
function isDeadlinePassed(deadline) {
  if (!deadline || !isNormalizedDeadline(deadline)) return false;
  const d = new Date(deadline.replace(' ', 'T'));
  if (isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d.getTime() < today.getTime();
}

function assignPriority(tender, keyword) {
  const remaining = daysUntil(tender.deadline);
  const name = tender.name;
  const exactMatch = keyword && name.includes(keyword);
  // 已截止的标优先级降低
  if (remaining !== null && remaining < 0) return '低';
  if (remaining !== null && remaining <= 7 && exactMatch) return '高';
  if ((remaining !== null && remaining <= 30) || exactMatch) return '中';
  return '低';
}

// ---------- 归档 ----------

async function loadStatuses() {
  try {
    const res = await fetch(`${API_BASE}/api/statuses`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) return await res.json();
  } catch {}
  return {};
}

async function archiveExpiredTenders(tenders) {
  const archiveIds = [];
  for (const t of tenders) {
    // 剔除规则：截止日期已过（截止日当天保留，次日起移除），不再依赖「已查阅」状态与 30 天计时
    if (isDeadlinePassed(t.deadline)) archiveIds.push(t.id);
  }
  if (!archiveIds.length) return [];

  for (const id of archiveIds) {
    const t = tenders.find((x) => String(x.id) === String(id));
    if (!t) continue;
    try {
      const res = await fetch(`${API_BASE}/api/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(t),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) log(`  归档 POST 失败 id=${id}: ${res.status}`);
    } catch (e) {
      log(`  归档异常 id=${id}: ${e.message}`);
    }
  }

  // 清理超过 7 天未操作的归档
  try {
    const archived = await (await fetch(`${API_BASE}/api/archive`, { signal: AbortSignal.timeout(8000) })).json();
    if (Array.isArray(archived)) {
      for (const a of archived) {
        if (!a.archiveTime) continue;
        const days = (now - new Date(a.archiveTime).getTime()) / (1000 * 60 * 60 * 24);
        if (days > 7) {
          await fetch(`${API_BASE}/api/archive?id=${encodeURIComponent(a.id)}`, { method: 'DELETE', signal: AbortSignal.timeout(8000) });
        }
      }
    }
  } catch (e) {
    log('  清理归档失败:', e.message);
  }

  return archiveIds;
}

/**
 * 计算需要自动删除的 id：发布时间早于当前 30 天（一个月）的信息。
 * 与前端 applyPublishAutoDelete 规则一致，每日同步时从看板真实移除。
 */
function computeOldPublishDeletions(list) {
  const now = Date.now();
  const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
  const ids = [];
  for (const t of list) {
    if (!t.publish) continue;
    const pub = new Date(t.publish);
    if (isNaN(pub.getTime())) continue;
    if (now - pub.getTime() > MONTH_MS) ids.push(t.id);
  }
  return ids;
}

// ---------- Git ----------

function runGit(args) {
  const cmd = `git -C "${ROOT}" ${args}`;
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
  } catch (e) {
    throw new Error(`git ${args} 失败: ${e.message}\n${e.stderr || ''}`);
  }
}

function commitAndPush(count, date) {
  runGit('add index.html');
  runGit(`commit -m "自动同步: 新增 ${count} 条招标信息 (${date})"`);
  try {
    runGit('stash');
  } catch {}
  try {
    runGit('pull origin main --rebase --allow-unrelated-histories');
  } catch {}
  try {
    const conflicts = execSync(`git -C "${ROOT}" diff --name-only --diff-filter=U`, { encoding: 'utf-8' }).trim();
    if (conflicts.includes('index.html')) {
      runGit('checkout --ours index.html && git add index.html && git rebase --continue');
    }
  } catch {}
  try {
    runGit('stash pop');
  } catch {}
  runGit('push origin main');
}

// ---------- 主流程 ----------

async function main() {
  const dateStr = new Date().toISOString().split('T')[0];
  log(`== 招标信息同步开始 (${dateStr}) ==`);

  const keywords = await fetchKeywords();
  if (!keywords.length) {
    log('没有关键词，终止。');
    process.exit(1);
  }
  log(`关键词: ${keywords.join(', ')}`);

  const html = readFile(HTML_PATH);
  if (!html) {
    log('index.html 不存在');
    process.exit(1);
  }

  const existingTenders = loadTendersFromHtml(html);
  const dedupKeySet = new Set(
    existingTenders.map((t) => `${normalizeName(t.name)}|${t.publish}`)
  );
  const maxId = existingTenders.reduce((max, t) => {
    const n = typeof t.id === 'number' ? t.id : parseInt(t.id, 10);
    return isNaN(n) ? max : Math.max(max, n);
  }, 0);

  const candidates = await loadCandidates(keywords);
  log(`候选结果: ${candidates.length} 条`);

  const newTenders = [];
  for (const c of candidates) {
    if (!c.url) continue;
    let info;
    // 95306 / crrcgo / suzhou-metro / szmetro / cebpubservice 一手平台爬虫结果权重最高：结构化字段齐全时直接采用，跳过重新抓取与重抽
    if ((c._src === '95306' || c._src === 'crrcgo' || c._src === 'suzhou-metro' || c._src === 'szmetro' || c._src === 'cebpubservice') && (c.deadline || c.unit || c.publish)) {
      info = buildInfoFromStructured(c);
    } else {
      const pageHtml = await fetchPageText(c.url);
      if (!pageHtml) continue;
      info = await extractFromPage(pageHtml, c.url, c.keyword || c.category || '', c.title, c.snippet || '');
    }
    if (!info || !info.name) continue;
    if (isExcluded(info.name + ' ' + (c.snippet || ''))) continue;

    // 截止日期过滤（与看板规则一致）：必须为明确的 YYYY-MM-DD[ HH:mm] 且 >= 今天，否则不入库
    const dlRaw = String(info.deadline || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(dlRaw)) continue;
    const dlDate = new Date(dlRaw.replace(' ', 'T'));
    const today0 = new Date();
    today0.setHours(0, 0, 0, 0);
    if (isNaN(dlDate.getTime()) || dlDate < today0) continue;

    const key = `${normalizeName(info.name)}|${info.publish}`;
    if (dedupKeySet.has(key)) continue;
    dedupKeySet.add(key);

    info.priority = assignPriority(info, c.keyword);
    newTenders.push(info);
  }

  // 分配 id 并排序
  let nextId = maxId + 1;
  newTenders.forEach((t) => {
    t.id = nextId++;
  });
  newTenders.sort((a, b) => {
    const po = { 高: 0, 中: 1, 低: 2 };
    if (po[a.priority] !== po[b.priority]) return po[a.priority] - po[b.priority];
    return new Date(b.publish) - new Date(a.publish);
  });

  log(`新增招标: ${newTenders.length} 条`);

  // 状态（归档与自动删除共用，避免重复请求）
  const statuses = await loadStatuses();

  // 归档：截止日期已过（含未查阅项）移出看板，保留 7 天归档后可恢复
  const archiveIds = await archiveExpiredTenders(existingTenders);
  log(`归档截止日期已过: ${archiveIds.length} 条`);

  // 自动删除：发布时间早于 30 天（兜底「待确认」/长期未清理项）
  const oldPublishIds = computeOldPublishDeletions(existingTenders);
  log(`自动删除 发布时间超30天: ${oldPublishIds.length} 条`);

  let keptTenders = existingTenders.filter(
    (t) => !archiveIds.includes(t.id) && !oldPublishIds.includes(t.id)
  );

  if (!newTenders.length && !archiveIds.length && !oldPublishIds.length) {
    log('无新增/归档，跳过文件更新与 Git 提交');
    log(`当前看板总数: ${existingTenders.length}`);
    return;
  }

  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    log('--dry-run 模式：不写入文件，不提交 Git');
    log(`预计看板总数: ${keptTenders.length + newTenders.length}`);
  } else {
    const { total } = saveTenders(html, keptTenders, newTenders);
    log(`当前看板总数: ${total}`);
    try {
      commitAndPush(newTenders.length, dateStr);
      log('Git 推送成功');
    } catch (e) {
      log('Git 推送失败:', e.message);
      process.exit(1);
    }
  }

  log('\n新增项目:');
  for (const t of newTenders) {
    log(`  [${t.priority}] ${t.name} | ${t.platform} | 截止 ${t.deadline}`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  loadTendersFromHtml,
  parseTenderBlocks,
  saveTenders,
  formatTender,
  extractFromPage,
  extractUnit,
  extractUnitByLabel,
  extractUnitFromTitle,
  assignPriority,
  buildInfoFromStructured,
  isExcluded,
  normalizeName,
  detectPlatformByText,
  detectPlatform,
  isFirstHand,
  normalizeDate,
  fetchKeywords,
  FIRST_HAND_DOMAINS,
  THIRD_PARTY_DOMAINS,
  PLATFORM_DOMAINS,
};

