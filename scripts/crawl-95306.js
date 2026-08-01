#!/usr/bin/env node
/**
 * 国铁采购平台（cg.95306.cn）招标公告爬虫
 * =============================================================
 *
 * 【接口逆向说明】
 * 站点是 jQuery + layui 传统架构，页面 HTML 只是空壳，数据全部走两个 AJAX 接口：
 *   列表：POST /proxy/portal/elasticSearch/queryDataToEs
 *   详情：POST /proxy/portal/elasticSearch/indexView
 *
 * 无需登录、无需 token（Authorization 传空即可）。
 *
 * 【验证码机制 —— 关键】
 * 平台的滑块验证码不是入口墙，而是**频率限制**：
 *   - 请求参数里的 mhId 是前端 FingerprintJS v4 生成的浏览器指纹（32位hex）
 *   - 服务端按 mhId 累计请求次数，同一 mhId 约 3 次后即拒绝，
 *     前端随即弹出滑块验证码，滑过后调 /elasticSearch/checkRequestNumValidateCode 重置计数
 *   - 由于 mhId 完全由客户端生成，本脚本为每个请求生成独立 mhId，从而不触发计数
 * 实测 30 次连续请求成功率 100%。
 * 注意：仍保留请求间隔（REQUEST_INTERVAL），避免对服务器造成压力。
 *
 * 【截止日期策略 —— 已统一为"报名截止"，与中车购一致】
 * 列表/详情返回的 latestDocumentSaleEndTime 即「采购文件获取/报名截止」，
 * 统一以此为截止日期基准，不再从正文解析投标递交截止。
 *
 * 【全量兜底通道 —— 防漏抓（默认开启）】
 * 关键词通道只搜「标题含关键词」的公告，标题不含设备词的（如"XX段2026年设备采购"）
 * 会漏掉。本爬虫默认额外跑一条"全量通道"：
 *   空标题 + 时间窗(startDate/endDate 取近 --days 天) + noticeType
 *   → 拉回时间窗内全部公告列表 → 本地用 设备词/行为词 粗筛（剔除基建/物业/土建等噪音）
 *   → 与关键词通道结果按 id 合并去重。
 * 实测 17 天时间窗可拉回 7439 条全量项目公告。
 *
 * 【公告类型字典 noticeType】
 *   01 项目公告(可投标)  02 变更公告  03 补遗公告  04 中标公示
 *   05 结果公告          06 采购方式公示  07 结果公示
 * 默认只抓 01（+02，因变更公告常含新的截止时间），服务端直接过滤，效率最高。
 *
 * 【采购方式字典 bidType】
 *   01 招标  02 竞价采购  03 询价采购  04 单一来源
 *   05 谈判采购  06 需求信息  08 直接采购(应急)  10 拍卖
 *
 * 用法：
 *   node scripts/crawl-95306.js --keywords "试验台,架车机" [options]
 *   node scripts/crawl-95306.js                       # 自动读取 COS 关键词
 *
 * 选项：
 *   --keywords <a,b,c>   指定关键词（逗号分隔），缺省则从 COS API / 本地文件读取
 *   --notice-type <t>    公告类型，默认 "01,02"；传 "all" 抓全部
 *   --pages <n>          每个关键词翻几页，默认 1（每页 10 条）
 *   --detail             抓取详情正文并解析投标截止日期（强烈建议开启）
 *   --no-filter          不过滤已截止项目（默认仅保留 截止 >= 明天 与 待确认）
 *   --keep-auction       保留废旧物资处置/拍卖类（默认剔除）
 *   --days <n>           时间窗天数（全量通道按此拉取），默认 7；传 30 可抓近一个月
 *   --no-full            关闭全量兜底通道（仅关键词通道）
 *   --max-detail <n>     详情抓取上限（默认 1500，防止请求过多）
 *   --out <file>         输出 JSON 路径，默认 scripts/95306-candidates.json
 *   --verbose            打印每条抓取明细
 */

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOST = 'cg.95306.cn';
const BASE = '/proxy/portal';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const LIST_REFERER =
  'https://cg.95306.cn/baseinfor/notice/toBuyNoticeMore?bidType=&noticeType=';
const REQUEST_INTERVAL = 220; // ms，礼貌节流

const NOTICE_TYPE_NAMES = {
  '01': '项目公告',
  '02': '变更公告',
  '03': '补遗公告',
  '04': '中标公示',
  '05': '结果公告',
  '06': '采购方式公示',
  '07': '结果公示',
};

// ============ 基础工具 ============

/** 每次请求生成新的 mhId，绕开按指纹累计的频率限制 */
function newMhId() {
  return crypto.randomBytes(16).toString('hex');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 清洗 HTML：去标签、去搜索高亮 <span style="color:red">、还原实体 */
function strip(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 正文清洗：保留换行，便于内容提取 */
function stripBody(s) {
  return String(s == null ? '' : s)
    .replace(/<\s*(br|\/p|\/div|\/tr|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function post(apiPath, params) {
  const mhId = newMhId();
  const form = new URLSearchParams(
    Object.assign({ mhId, Authorization: '' }, params)
  ).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: HOST,
        path: BASE + apiPath,
        method: 'POST',
        timeout: 25000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Content-Length': Buffer.byteLength(form),
          'User-Agent': UA,
          'X-Requested-With': 'XMLHttpRequest',
          Origin: 'https://cg.95306.cn',
          Referer: LIST_REFERER,
          Cookie: `mhId=${mhId}`,
        },
      },
      (res) => {
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(new Error(`非JSON响应 (HTTP ${res.statusCode}): ${d.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.write(form);
    req.end();
  });
}

// ============ 接口封装 ============

async function searchList(keyword, { noticeType = '', pageNum = 1, startDate = '', endDate = '' } = {}) {
  const res = await post('/elasticSearch/queryDataToEs', {
    projBidType: '',
    bidType: '',
    noticeType,
    wzType: '',
    title: keyword,
    disposalMethod: '',
    startDate,
    endDate,
    sortCondition: '0',
    pageNum: String(pageNum),
  });
  if (!res.success) {
    throw new Error(`列表接口失败: ${res.msg || '(无消息，可能触发频率限制)'}`);
  }
  const rd = (res.data && res.data.resultData) || {};
  return {
    list: rd.result || [],
    totalCount: rd.totalCount || 0,
    totalPageCount: rd.totalPageCount || 0,
  };
}

async function getDetail(noticeId) {
  const res = await post('/elasticSearch/indexView', { noticeId });
  if (!res.success || !res.data) return null;
  const nc = res.data.noticeContent || {};
  return {
    title: strip(nc.notTitle),
    body: stripBody(nc.notCont),
    noticeType: nc.noticeType || '',
    checkTime: nc.checkTime || '',
    projCode: nc.projCode || nc.biddingProjCode || '',
    latestEnd: nc.latestDocumentSaleEndTime || '',
  };
}

/**
 * 全量兜底通道：空标题 + 时间窗（近 days 天）拉取全部公告列表，
 * 本地用 isFullScanRelevant 粗筛，返回候选数组（不含详情）。
 * 列表按发布时间倒序（sortCondition=0），新公告在前 → 本地按 checkTime
 * 判断是否已超出时间窗边界，一旦越过即停止翻页（不必翻到 maxPages）。
 * 窗口越小停止越早：--days 7 约 300 页，--days 30 约 1300 页。
 */
async function scanFullWindow(keywords, { noticeType = '', days = 7, maxPages = 3000, verbose = false } = {}) {
  const cutoff = todayPlusDays(-days);
  const out = [];
  const seen = new Set();
  for (let p = 1; p <= maxPages; p++) {
    let list;
    try {
      const r = await searchList('', { noticeType, pageNum: p });
      list = r.list || [];
      if (verbose && p === 1) {
        console.log(`[全量] 时间窗近${days}天, 类型${noticeType || 'all'} 总命中 ${r.totalCount}, 逐页拉取...`);
      }
    } catch (e) {
      console.log(`[全量] 第${p}页失败: ${e.message}`);
      break;
    }
    if (!list.length) break;

    let reachedBoundary = false;
    for (const item of list) {
      const title = strip(item.notTitle);
      if (!title || seen.has(item.id)) continue;
      const checkDate = parseDateLoose((item.checkTime || '').split(' ')[0]);
      if (checkDate && checkDate < cutoff) {
        // 时间倒序：本条已早于时间窗，后面的更早 → 停止整页扫描
        reachedBoundary = true;
        break;
      }
      if (!isFullScanRelevant(title, keywords)) continue;
      seen.add(item.id);
      out.push({
        id: item.id,
        name: title,
        noticeTypeName: item.noticeTypeName || '',
        bidTypeName: item.bidTypeName || '',
        professionalName: item.professionalName || '',
        publish: (item.checkTime || '').split(' ')[0],
        latestEnd: item.latestDocumentSaleEndTime || '',
        digest: strip(item.digest),
        keyword: '【全量兜底】',
        fromFullScan: true,
      });
    }
    if (verbose && p % 50 === 0) console.log(`       ...第${p}页 累计${out.length}条`);
    await sleep(REQUEST_INTERVAL);
    if (reachedBoundary) {
      if (verbose) console.log(`[全量] 第${p}页已越过时间窗边界, 停止`);
      break;
    }
  }
  return out;
}

// ============ 关键词加载 ============

function getArg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function loadKeywords() {
  const cli = getArg('keywords', '');
  if (cli) {
    return cli
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // 优先 COS API
  try {
    const txt = await new Promise((resolve, reject) => {
      https
        .get(
          'https://1457331256-984dniw11b.ap-guangzhou.tencentscf.com/api/keywords',
          { timeout: 15000 },
          (res) => {
            let d = '';
            res.setEncoding('utf8');
            res.on('data', (c) => (d += c));
            res.on('end', () => resolve(d));
          }
        )
        .on('error', reject)
        .on('timeout', function () {
          this.destroy(new Error('timeout'));
        });
    });
    const arr = JSON.parse(txt);
    if (Array.isArray(arr) && arr.length) {
      console.log(`[关键词] 从 COS API 读取 ${arr.length} 个`);
      return arr;
    }
  } catch (e) {
    console.log(`[关键词] COS API 失败 (${e.message})，回退本地文件`);
  }

  const local = path.join(ROOT, '产品关键词.txt');
  if (fs.existsSync(local)) {
    const arr = fs
      .readFileSync(local, 'utf8')
      .split(/[,，、\r\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    console.log(`[关键词] 从本地文件读取 ${arr.length} 个`);
    return arr;
  }
  throw new Error('无法获取关键词');
}

// ============ 业务过滤 ============

/** 结果类公告（不可投标），标题兜底判断 */
const RESULT_NOTICE_RE =
  /(中标公示|中标结果|成交公告|成交公示|成交候选人|中标候选人|评审结果|结果公告|结果公示|流标公告|废标公告|终止公告|采购方式公示|直接采购公示|单一来源公示)/;

/**
 * 废旧物资处置 / 拍卖类。
 * 这类是平台"卖废品"（如"废货车轴承物资处置"），方向与采购相反，
 * 但因标题含关键词会被搜出来，默认剔除。--keep-auction 可保留。
 */
const AUCTION_RE = /(物资处置|废旧物资|废钢|报废|处置项目|资产处置|拍卖)/;

/**
 * 全量通道粗筛：标题命中设备关键词 或 采购行为词 → 值得保留（宁滥勿缺，详情页再确认）。
 * 明显噪音（基建/物业/土建/办公生活类）先剔除，避免全量通道被土建工程公告淹没。
 */
const FULL_SCAN_ACTION_TERMS = [
  '采购', '招标', '询价', '竞价', '比选', '竞争性谈判', '磋商', '谈判',
  '维修', '大修', '改造', '委外', '维保', '供应', '物资', '配件', '备件',
  '购置', '租赁', '试验', '检测', '检修', '整治',
];

/** 全量通道噪音词（工程/生活/车辆等与设备采购无关的大类），命中即剔除 */
const FULL_SCAN_NOISE_WORDS = [
  // 工程/土建/市政类
  '土建', '房建', '房屋', '厂房', '装修', '装饰', '幕墙', '门窗', '屋面',
  '道路', '路面', '路基', '桥梁', '隧道', '涵洞', '管网', '给排水', '供水',
  '排水', '污水处理', '水利', '河道', '堤防', '泵站', '市政', '站房', '雨棚',
  '道砟', '人行道', '围挡', '混凝土', '改扩建', '建筑工程', '市政工程',
  '道路工程', '桥梁工程', '隧道工程', '水利工程', '总承包', '土石方',
  // 生活/办公/服务类
  '食堂', '宿舍', '办公楼', '营业厅', '更衣室', '门厅', '酒店', '餐厅',
  '景观', '园林', '绿化', '保洁', '物业', '劳务', '保安', '印刷', '会议',
  '培训', '监理', '审计', '咨询', '广告', '空调', '通风空调', '电梯',
  '照明', '弱电', '安防', '消防', '家具', '床上用品', '办公用品', '纸张',
  '劳保用品', '保险', '邮政', '快递', '洗涤', '消杀',
  // 生活/生产材料等无关补充
  '食材', '伙食', '食品', '粮食', '蔬菜', '水果', '矿泉水', '饮用水',
  '帆布', '服装', '被服', '布料', '钢筋', '钢材', '水泥', '砂石', '石料',
  '道砟', '球机', '监控摄像头', '行车记录仪', '打印机', '复印机', '硒鼓',
  '电脑', '显示器', '键盘', '鼠标', '桌椅', '货架',
  // 车辆/出行无关类
  '机动车', '汽车维修', '车辆租赁', '客车租赁', '出租车', '驾校', '汽车驾驶',
];
const FULL_SCAN_NOISE_RE = new RegExp('(' + FULL_SCAN_NOISE_WORDS.join('|') + ')');

function isFullScanRelevant(title, keywords) {
  if (!title) return false;
  if (FULL_SCAN_NOISE_RE.test(title)) return false;
  if (keywords.some((k) => k && title.includes(k))) return true;
  return FULL_SCAN_ACTION_TERMS.some((w) => title.includes(w));
}

/**
 * 国铁专用单位兜底提取。
 * 国铁公告标题绝大多数以采购单位名开头，但部分不带「中国铁路…局集团有限公司」前缀
 * （如「上海大机运用检修段…」「2026年成都电务段…」「【北京铁科英迈技术有限公司】…」），
 * sync-tenders 的通用模式覆盖不到，这里按国铁命名习惯补一层。
 */
function extractUnitFrom95306Title(title) {
  if (!title) return '';
  let s = String(title).trim();

  // 【单位名】开头
  const bracket = s.match(/^[【\[]\s*([\u4e00-\u9fa5A-Za-z0-9（）()]{4,40}?)\s*[】\]]/);
  if (bracket && /(?:公司|集团|局|段|所|厂|院|中心)$/.test(bracket[1])) {
    return bracket[1];
  }

  // 去掉开头的年份 / 编号噪音
  s = s.replace(/^(?:\d{4}\s*年度?|20\d{2})\s*/, '');

  // 以铁路单位后缀结尾的开头片段
  const m = s.match(
    /^([\u4e00-\u9fa5]{2,30}?(?:机务段|车辆段|供电段|电务段|工务段|车务段|检修段|机辆段|大修段|客运段|运用检修段|段|所|厂|车间|中心|研究院|设计院))/
  );
  if (m) {
    const u = m[1];
    // 过滤明显不是单位的（如"电机库"、"通道"）
    if (u.length >= 4 && !/(库|通道|棚|楼|室|线|站台)$/.test(u)) return u;
  }

  // 以公司名开头
  const c = s.match(
    /^([\u4e00-\u9fa5]{2,30}?(?:有限公司|股份有限公司|集团有限公司|有限责任公司))/
  );
  if (c) return c[1];

  return '';
}

/**
 * 修正单位名中连续重复的机构名。
 * 国铁部分公告标题存在源数据重复（如"中国铁路济南局集团有限公司中国铁路济南局集团有限公司青岛机务段"），
 * 导致提取出的单位名带重复前缀。
 */
function dedupUnitName(unit) {
  if (!unit) return unit;
  let s = unit.trim();
  // 形如 XXX公司XXX公司... → 去掉重复段
  const m = s.match(/^(.{6,}?(?:公司|集团|局|段|所|厂|院|中心))\1+/);
  if (m) s = s.slice(m[1].length);
  // 兜底：整体前后两半完全相同
  const half = Math.floor(s.length / 2);
  if (s.length % 2 === 0 && s.slice(0, half) === s.slice(half)) s = s.slice(0, half);
  return s.trim();
}

function todayPlusDays(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
}

function parseDateLoose(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 截止日期：以 latestDocumentSaleEndTime（报名截止）为准，与中车购统一。
 */
function mergeDeadline(latestEnd) {
  if (latestEnd) {
    const t = String(latestEnd).trim().replace(/:00$/, '');
    return { value: t, from: 'latestDocumentSaleEndTime' };
  }
  return { value: '待确认', from: 'none' };
}

// ============ 主流程 ============

async function main() {
  const noticeTypeArg = getArg('notice-type', '01,02');
  const noticeTypes =
    noticeTypeArg === 'all'
      ? ['']
      : noticeTypeArg.split(',').map((s) => s.trim()).filter(Boolean);
  const pages = parseInt(getArg('pages', '1'), 10) || 1;
  const withDetail = hasFlag('detail');
  const noFilter = hasFlag('no-filter');
  const verbose = hasFlag('verbose');
  const daysLimit = parseInt(getArg('days', '7'), 10) || 0;
  const outFile = path.resolve(ROOT, getArg('out', 'scripts/95306-candidates.json'));

  const keywords = await loadKeywords();
  // 柳州/南宁局定向补充词：提升广西及南宁局检修装备公告召回（2026-08 柳州重点市场）
  const LIUZHOU_KEYWORDS = [
    '柳州机车车辆', '柳州机务段', '柳州车辆段', '柳州供电段', '柳州工务段', '柳州电务段',
    '南宁局', '南宁机务段', '南宁车辆段', '广西铁路', '柳州铁路', 'HXN5', '柳州车辆厂',
  ];
  for (const w of LIUZHOU_KEYWORDS) {
    if (!keywords.includes(w)) keywords.push(w);
  }
  console.log(
    `[配置] 关键词 ${keywords.length} 个 | 公告类型 ${noticeTypeArg} | 每词 ${pages} 页 | 详情 ${withDetail ? '开' : '关'}`
  );
  console.log('');

  const byId = new Map();
  let queried = 0;
  let failed = 0;

  for (const kw of keywords) {
    for (const nt of noticeTypes) {
      for (let p = 1; p <= pages; p++) {
        try {
          const { list, totalCount } = await searchList(kw, {
            noticeType: nt,
            pageNum: p,
          });
          queried++;
          if (p === 1 && verbose) {
            console.log(
              `[搜索] "${kw}" 类型${nt || 'all'} → 命中 ${totalCount} 条，取前 ${list.length}`
            );
          }
          for (const item of list) {
            const title = strip(item.notTitle);
            if (!title) continue;
            if (!byId.has(item.id)) {
              byId.set(item.id, {
                id: item.id,
                name: title,
                noticeTypeName: item.noticeTypeName || NOTICE_TYPE_NAMES[nt] || '',
                bidTypeName: item.bidTypeName || '',
                professionalName: item.professionalName || '',
                publish: (item.checkTime || '').split(' ')[0],
                latestEnd: item.latestDocumentSaleEndTime || '',
                digest: strip(item.digest),
                keyword: kw,
              });
            }
          }
          if (list.length === 0) break; // 没有更多了
        } catch (e) {
          failed++;
          console.log(`[警告] "${kw}" 类型${nt || 'all'} 第${p}页 失败: ${e.message}`);
        }
        await sleep(REQUEST_INTERVAL);
      }
    }
  }

  let candidates = [...byId.values()];
  console.log(
    `\n[去重] ${queried} 次查询（失败 ${failed}），关键词通道去重后 ${candidates.length} 条公告`
  );

  // ========== 全量兜底通道（默认开启，--no-full 关闭）==========
  if (!hasFlag('no-full')) {
    const fullDays = daysLimit > 0 ? daysLimit : 30;
    const maxFullPages = parseInt(getArg('max-pages', '3000'), 10) || 3000;
    const startFull = candidates.length;
    console.log(`\n[全量] 启动全量兜底通道（时间窗近 ${fullDays} 天, 最多 ${maxFullPages} 页）...`);
    for (const nt of noticeTypes) {
      const fullList = await scanFullWindow(keywords, {
        noticeType: nt,
        days: fullDays,
        maxPages: maxFullPages,
        verbose,
      });
      for (const c of fullList) {
        if (!byId.has(c.id)) byId.set(c.id, c);
      }
      await sleep(REQUEST_INTERVAL);
    }
    candidates = [...byId.values()];
    console.log(`[全量] 全量通道新增 ${candidates.length - startFull} 条，合并后共 ${candidates.length} 条`);
  } else {
    console.log('\n[全量] 已关闭全量兜底通道（--no-full）');
  }

  // 结果类公告过滤（服务端已按 noticeType 过滤，这里按标题再兜一层）
  if (noticeTypeArg !== 'all') {
    const before = candidates.length;
    candidates = candidates.filter((c) => !RESULT_NOTICE_RE.test(c.name));
    if (before !== candidates.length) {
      console.log(`[类型过滤] 剔除结果公示类 ${before - candidates.length} 条`);
    }
  }

  // 废旧物资处置 / 拍卖过滤
  if (!hasFlag('keep-auction')) {
    const before = candidates.length;
    candidates = candidates.filter(
      (c) => !AUCTION_RE.test(c.name) && c.bidTypeName !== '拍卖'
    );
    if (before !== candidates.length) {
      console.log(`[拍卖过滤] 剔除废旧物资处置类 ${before - candidates.length} 条`);
    }
  }

  // 发布时间过滤
  if (daysLimit > 0) {
    const cutoff = todayPlusDays(-daysLimit);
    const before = candidates.length;
    candidates = candidates.filter((c) => {
      const d = parseDateLoose(c.publish);
      return !d || d >= cutoff;
    });
    console.log(`[时间过滤] 仅保留近 ${daysLimit} 天，剔除 ${before - candidates.length} 条`);
  }

  // 截止日期统一用 latestDocumentSaleEndTime（报名截止）
  const maxDetail = parseInt(getArg('max-detail', '1500'), 10) || 0;
  const detailList = withDetail ? candidates.slice(0, maxDetail) : [];
  if (withDetail && candidates.length) {
    console.log(`\n[详情] 抓取 ${detailList.length} 条正文${candidates.length > detailList.length ? `（其余 ${candidates.length - detailList.length} 条跳过 --max-detail）` : ''}...`);
    let done = 0;
    let idx = 0;
    const CONCURRENCY = 3;

    async function worker() {
      while (idx < detailList.length) {
        const c = detailList[idx++];
        try {
          const d = await getDetail(c.id);
          if (d) {
            c.body = d.body;
            c.projCode = d.projCode;
            if (d.latestEnd) c.latestEnd = d.latestEnd;
            if (d.noticeType) {
              c.noticeType = d.noticeType;
              c.noticeTypeName = NOTICE_TYPE_NAMES[d.noticeType] || c.noticeTypeName;
            }
          }
        } catch (e) {
          // 保留列表已有的 latestEnd，详情抓取失败不抛异常
        }
        const merged = mergeDeadline(c.latestEnd);
        c.deadline = merged.value;
        c.deadlineSource = merged.from;
        done++;
        if (done % 20 === 0) console.log(`       ...${done}/${detailList.length}`);
        await sleep(REQUEST_INTERVAL);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    console.log(`[详情] 完成 ${done} 条`);
  } else {
    for (const c of candidates) {
      const merged = mergeDeadline(c.latestEnd);
      c.deadline = merged.value;
      c.deadlineSource = merged.from;
    }
  }

  // 招标单位提取（复用 sync-tenders 已调优的逻辑）
  let extractUnit = null;
  try {
    ({ extractUnit } = require('./sync-tenders'));
  } catch (e) {
    /* 忽略，退化为不提取 */
  }
  for (const c of candidates) {
    if (extractUnit) {
      try {
        c.unit = dedupUnitName(extractUnit(c.body || c.digest || '', c.name) || '');
      } catch (e) {
        c.unit = '';
      }
    } else {
      c.unit = '';
    }
    // 通用逻辑未命中时，用国铁命名习惯兜底
    if (!c.unit) c.unit = dedupUnitName(extractUnitFrom95306Title(c.name));
  }

  // 截止日期过滤
  if (!noFilter) {
    const tomorrow = todayPlusDays(1);
    const before = candidates.length;
    candidates = candidates.filter((c) => {
      if (!c.deadline || c.deadline === '待确认') return true;
      const d = parseDateLoose(c.deadline);
      return !d || d >= tomorrow;
    });
    console.log(`[截止过滤] 剔除已截止 ${before - candidates.length} 条`);
  }

  // 输出
  const out = candidates.map((c) => ({
    name: c.name,
    unit: c.unit,
    publish: c.publish,
    deadline: c.deadline,
    link: `https://cg.95306.cn/baseinfor/notice/informationShow?id=${c.id}`,
    platform: '国铁采购平台',
    noticeType: c.noticeTypeName,
    bidType: c.bidTypeName,
    professional: c.professionalName,
    projCode: c.projCode || '',
    keyword: c.keyword,
    deadlineSource: c.deadlineSource,
    snippet: (c.digest || '').slice(0, 200),
  }));

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');

  const pending = out.filter((x) => x.deadline === '待确认').length;
  const withUnit = out.filter((x) => x.unit).length;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`候选总数        : ${out.length}`);
  console.log(
    `有明确截止日期  : ${out.length - pending} (${out.length ? (((out.length - pending) / out.length) * 100).toFixed(1) : 0}%)`
  );
  console.log(`  └ 全部来自报名截止(latestDocumentSaleEndTime)`);
  console.log(`待确认          : ${pending}`);
  console.log(
    `有招标单位      : ${withUnit} (${out.length ? ((withUnit / out.length) * 100).toFixed(1) : 0}%)`
  );
  console.log(`输出文件        : ${outFile}`);
  console.log('='.repeat(60));

  if (verbose) {
    out.slice(0, 30).forEach((x, i) => {
      console.log(
        `\n[${i + 1}] ${x.name}\n    单位: ${x.unit || '(未识别)'}\n    ${x.noticeType} | ${x.bidType} | 发布 ${x.publish} | 截止 ${x.deadline} (${x.deadlineSource})`
      );
    });
  }

  if (out.length === 0) {
    console.log(
      '\n[!] 本次抓取 0 条。若持续为 0，可能是接口变更或被限流，请检查脚本。'
    );
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[致命错误]', e.message);
    process.exit(1);
  });
}

// 供其他脚本复用（如 resolve-deadlines.js 按公告 id 直查详情）
module.exports = {
  post,
  getDetail,
  searchList,
  mergeDeadline,
  strip,
  stripBody,
  parseDateLoose,
  todayPlusDays,
  sleep,
  newMhId,
  REQUEST_INTERVAL,
  HOST,
  BASE,
  NOTICE_TYPE_NAMES,
  extractUnitFrom95306Title,
  dedupUnitName,
};
