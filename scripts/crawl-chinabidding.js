#!/usr/bin/env node
/**
 * 中国采购与招标网（www.chinabidding.cn）爬虫
 * =============================================================
 * 【站点特点】
 * - SSR + Nuxt 架构，但 .cn 域名全站有"加速乐"JS 反爬挑战（需浏览器执行 JS 拿 acw_sc__v2 cookie）
 * - 免费：列表页前 3 页可看；详情页"开标时间/招标人"等字段被登录墙遮挡（"立即注册查看"+（略）打码）
 * - 付费账号登录后：深分页开放、详情全文可见
 * - 本脚本复用付费账号登录态（.workbuddy/cb_storage.json，由 cb_login_interactive.js 生成）
 *
 * 【列表页】/sk/yunshu/ 等返回全量招标信息列表（每页 10 条）：
 *   <li><div class="title"><a class="tt_link" href="/zbgg/U-xxx.html">标题</a></div>
 *       <div class="date">2026-08-01</div><div class="ggtype">招标公告</div>
 *       <div class="area">北京</div><div class="category">行业</div></li>
 * 分页：/sk/yunshu/N.html（登录态下第 4 页起也可访问）
 *
 * 【详情页】/zbgg/U-xxx.html：标题 + 发布时间 + 正文（含 询价单位/发包单位/招标人 + 截止时间）
 *
 * 用法：
 *   node scripts/crawl-chinabidding.js [options]
 * 选项：
 *   --pages <n>    列表翻页数，默认 10（每页 10 条）
 *   --no-detail    不抓详情（仅列表字段）
 *   --max-detail <n> 详情抓取上限，默认 150
 *   --out <file>   输出路径，默认 scripts/chinabidding-candidates.json
 */

const { chromium } = require('C:/Users/ms/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const path = require('path');
const fs = require('fs');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const STORAGE = path.join(ROOT, '.workbuddy/cb_storage.json');
const LIST_URL = 'https://www.chinabidding.cn/sk/yunshu/';
const REQUEST_INTERVAL = 2500; // 低频：2.5 秒/请求（保护付费账号）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 结果类公告（不可投标）——与 95306 一致
const RESULT_NOTICE_RE = /(中标公示|中标结果|成交公告|成交公示|成交候选人|中标候选人|评审结果|结果公告|结果公示|流标|废标|终止|异常|更正|澄清|补遗|答疑|招标计划|招标预告|采购计划)/;
// 废旧/拍卖类
const AUCTION_RE = /(物资处置|废旧物资|废钢|报废|处置项目|资产处置|拍卖)/;
// 噪音词（工程/生活/车辆等无关）
const NOISE_WORDS = [
  '土建', '房建', '房屋', '厂房', '车间', '装修', '装饰', '幕墙', '门窗', '屋面', '道路', '公路',
  '桥梁', '隧道', '涵洞', '管网', '给排水', '供水', '排水', '污水处理', '水利', '市政',
  '站房', '道砟', '人行道', '围挡', '混凝土', '改扩建', '总承包', '土石方', '食堂',
  '宿舍', '办公楼', '酒店', '餐厅', '景观', '园林', '绿化', '保洁', '物业', '劳务',
  '保安', '印刷', '会议', '培训', '监理', '审计', '咨询', '广告', '空调', '电梯',
  '照明', '弱电', '安防', '消防', '家具', '办公用品', '食材', '伙食', '帆布', '服装',
  '钢筋', '钢材', '水泥', '砂石', '机动车', '汽车维修', '车辆租赁', '客车租赁', '出租车',
  '驾校', '汽车驾驶', '保险', '绿化养护', '垃圾清运', '钢结构', '钢平台', '钢护筒',
  '临建', '改版', '网站', '软件', '信息系统', '数字化', '智能化', '农产品', '粮食',
  '仓储', '物流', '产业园', '园区', '装修', '装饰工程', '劳务分包', '桩基', '基坑', '脚手架',
];
const NOISE_RE = new RegExp('(' + NOISE_WORDS.join('|') + ')');
// 强相关行为词：标题含这些词大概率是设备/检修类（不用于"采购/招标"万金油）
const ACTION_STRONG = [
  '维修', '大修', '维保', '试验', '检测', '配件', '备件', '工装', '试验台', '检修',
  '翻新', '改造', '探伤', '拆装', '压装', '清洗', '烘干', '磨合', '跑合', '试验机',
  '试验器', '试验装置', '试验设备', '测试台', '加热', '逆变', '充电机', '电源',
  '传感器', '转向架', '轴承', '受电弓', '车钩', '制动', '阀试验台', '电机', '风机',
  '落轮', '架车', '移车台', '转盘', '升降平台', '作业平台', '工器具', '量具', '夹具',
  '吊具', '探伤仪', '监测', '测试',
];

// ============ 工具 ============

function getArg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function hasFlag(name) { return process.argv.includes(`--${name}`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function stripHtml(s) {
  return String(s == null ? '' : s).replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

/** 从 COS API 拉关键词，失败 fallback 产品关键词.txt（顿号分隔） */
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

/** 列表页粗筛：设备关键词命中 或 强相关行为词命中（且非噪音/结果类） */
function isRelevant(title, noticeType, keywords) {
  if (!title) return false;
  if (RESULT_NOTICE_RE.test(noticeType + title)) return false;
  if (AUCTION_RE.test(title)) return false;
  if (NOISE_RE.test(title)) return false;
  if (keywords.some((k) => k && title.includes(k))) return true;
  return ACTION_STRONG.some((w) => title.includes(w));
}

/** 从详情正文提取招标单位（优先标签，兜底标题模式） */
function extractUnit(text, title) {
  if (!text) return '';
  const m = text.match(/(?:询价单位|发包单位|招标人|采购人|采购单位|招标单位|业主单位)[：:]\s*([^\s|，。；]{2,40})/);
  if (m) return m[1].trim();
  const m2 = title.match(/^([\u4e00-\u9fa5]{2,30}?(?:有限公司|股份有限公司|集团有限公司|有限责任公司|机务段|车辆段|供电段|电务段|工务段|检修段|公司|集团|局|段|所|厂|院|中心))(?:\d{4}年|[^：\s]*(?:采购|招标|询价|项目))/);
  return m2 ? m2[1].trim() : '';
}

// ============ 主流程 ============
/**
 * 收益驱动爬取策略（低价值补充平台 + 保护付费账号）：
 * 1. 从最新列表逐条向后扫（最多 maxItems=300 条）
 * 2. 遇到第 1 条粗筛通过（设备词/强行为词）的 → 抓详情验证
 * 3. 详情解析出明确截止日期 → 视为"有用"，立即停止，只输出这一条
 * 4. 详情无截止/失败 → 继续扫下一条
 * 5. 扫满 300 条仍无有效 → 输出空
 */
async function main() {
  if (!fs.existsSync(STORAGE)) {
    console.error('[!] 未找到登录态 .workbuddy/cb_storage.json，请先运行 cb_login_interactive.js 登录');
    process.exit(1);
  }
  const maxItems = parseInt(getArg('max-items', '300'), 10) || 300;
  const outFile = path.resolve(ROOT, getArg('out', 'scripts/chinabidding-candidates.json'));
  const keywords = await loadKeywords();
  const { parseDeadline } = require('./lib/deadline-parser');

  console.log(`[配置] 关键词 ${keywords.length} 个 | 扫描上限 ${maxItems} 条(最新) | 命中1条有效即停 | 间隔 ${REQUEST_INTERVAL}ms`);

  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'zh-CN', storageState: STORAGE });
  const page = await ctx.newPage();

  let scanned = 0;      // 已扫描条数
  let pageNum = 1;      // 列表页码
  let result = null;    // 命中的有效候选
  let hitCount = 0;     // 粗筛命中数（含详情无效的）

  console.log('\n[扫描] 从最新公告向后查找...');
  while (scanned < maxItems && !result) {
    // 1) 抓一页列表
    const url = pageNum === 1 ? LIST_URL : `${LIST_URL}${pageNum}.html`;
    let items = [];
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1200);
      items = await page.evaluate(() => {
        return [...document.querySelectorAll('.clist ul li')].map(li => {
          const a = li.querySelector('a.tt_link');
          const date = li.querySelector('.date');
          const type = li.querySelector('.ggtype');
          const area = li.querySelector('.area');
          const cat = li.querySelector('.category');
          return {
            href: a ? a.getAttribute('href') : '',
            title: a ? (a.getAttribute('title') || a.innerText || '').trim() : '',
            publish: date ? date.innerText.trim() : '',
            noticeType: type ? type.innerText.trim() : '',
            area: area ? area.innerText.trim() : '',
            category: cat ? cat.innerText.trim() : '',
          };
        });
      });
    } catch (e) {
      console.log(`  [第${pageNum}页] 失败: ${e.message.slice(0, 60)}，停止`);
      break;
    }
    console.log(`  [第${pageNum}页] ${items.length} 条（累计已扫 ${scanned}）`);
    pageNum++;
    if (!items.length) { console.log('  列表已翻到底，停止'); break; }

    // 2) 逐条粗筛 → 命中即验证详情
    for (const it of items) {
      if (scanned >= maxItems) break;
      scanned++;
      if (!it.href || !it.title) continue;
      if (!isRelevant(it.title, it.noticeType, keywords)) continue;

      hitCount++;
      const c = {
        name: it.title, publish: it.publish, noticeType: it.noticeType,
        area: it.area, category: it.category,
        link: 'https://www.chinabidding.cn' + it.href,
      };
      console.log(`  ★ 粗筛命中(第${scanned}条): ${it.title.slice(0, 42)}，抓详情验证...`);

      // 3) 详情验证：解析出明确截止 → 有效，停止
      try {
        await page.goto(c.link, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1000);
        const info = await page.evaluate(() => {
          const txt = document.body.innerText.replace(/\n+/g, ' ').replace(/\s+/g, ' ');
          const pub = txt.match(/发布时间[：:]\s*(\d{4}-\d{2}-\d{2})/);
          return { txt, pub: pub ? pub[1] : '' };
        });
        if (info.pub) c.publish = info.pub;
        c.body = info.txt;
        c.unit = extractUnit(info.txt, c.name) || '';
        const d = parseDeadline(info.txt);
        c.deadline = d && d.value ? d.value : '待确认';
        c.deadlineSource = d && d.source ? d.source : 'none';
        if (c.deadline !== '待确认') {
          result = c;
          console.log(`  ✓ 有效！截止 ${c.deadline}，停止爬取`);
          break;
        }
        console.log(`  ✗ 详情无明确截止，继续找下一条`);
      } catch (e) {
        console.log(`  ✗ 详情抓取失败: ${e.message.slice(0, 50)}，继续`);
      }
      await sleep(REQUEST_INTERVAL);
    }
  }

  await browser.close();

  // ---------- 输出 ----------
  const out = result ? [result] : [];
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');

  console.log(`\n${'='.repeat(56)}`);
  console.log(`扫描条数      : ${scanned}（上限 ${maxItems}）`);
  console.log(`粗筛命中      : ${hitCount}`);
  if (result) {
    console.log(`命中结果      : ${result.name.slice(0, 50)}`);
    console.log(`  单位:${result.unit || '无'} | 截止:${result.deadline} | 发布:${result.publish} | ${result.area}`);
  } else {
    console.log(`未找到有效候选（${scanned} 条内无"标题相关+详情有截止"的公告）`);
  }
  console.log(`输出文件      : ${outFile}`);
  console.log('='.repeat(56));
}

main().catch((e) => { console.error('[致命错误]', e.message); process.exit(1); });
