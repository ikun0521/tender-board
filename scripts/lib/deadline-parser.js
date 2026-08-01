/**
 * 招标公告截止日期提取与规范化模块
 *
 * 支持从公告正文中按可信度优先级提取投标/开标/响应/报名/采购文件获取截止时间，
 * 也支持对已有自由文本 deadline 进行清理和规范化。
 */

const DATE_TIME_CAPTURE =
  '\\d{4}[-/.年]\\d{1,2}[-/.月]\\d{1,2}(?:日)?(?:\\s*\\d{1,2}:\\d{2}(?::\\d{2})?)?';

// 按可信度排序的提取规则
// 【2026-08-01】用户需求：截止日期 = 报名/获取文件截止 → registration 优先级提到 bid 之前。
// 公告同时含报名截止与投标/开标截止时，优先取「报名/获取文件截止」（更早、更贴近参与窗口）。
const RULES = [
  {
    name: 'registration',
    label: '采购文件获取/报名截止',
    patterns: [
      // 获取/发售文件时间：X 至 Y → 取结束日 Y（报名窗口结束）
      /(?:获取|发售|领取|购买)(?:采购|招标)?文件(?:时间)?[：:]\s*\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?\s*[至到~]\s*(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?)/gi,
      /(?:采购文件|招标文件|获取文件|文件获取|报名|登记).*?(?:获取|发售|截止|结束|下载|领取)(?:时间)?[：:]?\s*[^\d]*?(?:\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?\s*[至到~]\s*)?(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?)/gi,
      /(?:获取|发售|领取)(?:采购|招标)?文件(?:的)?(?:截止|结束|时间)[^\d]*?(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?)/gi,
    ],
  },
  {
    name: 'bid',
    label: '投标/开标截止',
    patterns: [
      /投标(?:文件)?(?:递交|截止|提交|开启)(?:的)?(?:截止|时间)[^\d]*?(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?)/gi,
      /报价文件(?:递交|截止|提交)(?:的)?(?:截止|时间)[^\d]*?(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?)/gi,
      /开标时间[^\d]*?(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?)/gi,
      /谈判时间[^\d]*?(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?)/gi,
      /响应(?:文件)?(?:递交|截止|提交)(?:的)?(?:截止|时间)[^\d]*?(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?)/gi,
    ],
  },
];

const FALLBACK_DATE_RE =
  /(?<!\d)\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?(?!\d)/g;

function pad(n) {
  return n.toString().padStart(2, '0');
}

function formatDateLocal(date, includeTime) {
  if (!date || isNaN(date.getTime())) return null;
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  if (includeTime && (date.getHours() || date.getMinutes())) {
    const h = pad(date.getHours());
    const min = pad(date.getMinutes());
    return `${y}-${m}-${d} ${h}:${min}`;
  }
  return `${y}-${m}-${d}`;
}

function parseDateString(str) {
  if (!str) return null;
  // 预处理：把 "2026 年 7月1 日 09时 0 0分" 这种带空格的写法规范化
  let cleaned = str
    .replace(/[\s]+/g, ' ')
    .trim()
    .replace(/日(?=\s|$)/g, '');

  // 保护“日”与“时/分”之间的空格，避免被下面的数字合并误删
  const TIME_BOUNDARY = '\u0000';
  cleaned = cleaned.replace(
    /(\d{1,2})\s+(?=\d{1,2}[:时])/g,
    '$1' + TIME_BOUNDARY
  );

  // 规范化中文年月日时分中的空格：202 6 年 -> 2026年，7月1 日 -> 7月1日，09时 0 0分 -> 09:00
  // 先移除数字之间的空格，避免“202 6”被拆散
  let prev;
  do {
    prev = cleaned;
    cleaned = cleaned.replace(/(\d)\s+(\d)/g, (_, a, b) => a + b);
  } while (cleaned !== prev);

  // 恢复受保护的日期-时间边界空格
  cleaned = cleaned.replace(new RegExp(TIME_BOUNDARY, 'g'), ' ');

  cleaned = cleaned
    .replace(/(\d{4})年(\d{1,2})月(\d{1,2})/g, '$1-$2-$3')
    .replace(/(\d{1,2})时(\d{1,2})分/g, '$1:$2');

  const m = cleaned.match(
    /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10) - 1;
  const day = parseInt(m[3], 10);
  const hour = m[4] ? parseInt(m[4], 10) : 0;
  const minute = m[5] ? parseInt(m[5], 10) : 0;
  const date = new Date(year, month, day, hour, minute);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function normalizeMatchedDate(str) {
  const date = parseDateString(str);
  if (!date) return null;
  const hasTime = /\d{1,2}:\d{2}/.test(str);
  return formatDateLocal(date, hasTime);
}

function normalizeDateText(text) {
  if (!text || typeof text !== 'string') return '';
  // 先把常见的“带空格中文日期/时间”压缩成常规写法
  // 例如：202 6 年 7月1 日 8 时 30 分 -> 2026年7月1日8时30分
  let result = text.replace(/[\s]+/g, ' ');
  let prev;
  do {
    prev = result;
    result = result.replace(/(\d)\s+(\d)/g, (_, a, b) => a + b);
  } while (result !== prev);
  // 再去除数字与“年/月/日/时/分”之间的空格
  result = result
    .replace(/(\d)\s*年\s*(\d)/g, '$1年$2')
    .replace(/(\d)\s*月\s*(\d)/g, '$1月$2')
    .replace(/(\d)\s*日\s*(\d)/g, '$1日 $2')
    .replace(/(\d)\s*时\s*(\d)/g, '$1时$2')
    .replace(/(\d)\s*分/g, '$1分');
  return result;
}

function cleanDeadlineText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/[（(）)]/g, ' ')
    .replace(/\b待确认\b|\b见招标文件\b|\b已直采\b/g, ' ')
    .replace(/[\s]+/g, ' ')
    .trim();
}

function extractByRules(text) {
  for (const rule of RULES) {
    for (const re of rule.patterns) {
      re.lastIndex = 0;
      const matches = [...text.matchAll(re)];
      for (const match of matches) {
        const normalized = normalizeMatchedDate(match[1]);
        if (normalized) {
          return { value: normalized, source: rule.name };
        }
      }
    }
  }
  return null;
}

function extractFallback(text, publishDate) {
  FALLBACK_DATE_RE.lastIndex = 0;
  const all = [...text.matchAll(FALLBACK_DATE_RE)]
    .map((m) => normalizeMatchedDate(m[0]))
    .filter(Boolean);
  if (!all.length) return null;
  const publishTs = publishDate ? new Date(publishDate).getTime() : 0;
  const candidates = all
    .map((s) => ({ str: s, date: parseDateString(s) }))
    .filter((item) => item.date && !isNaN(item.date.getTime()))
    .filter((item) => item.date.getTime() >= publishTs - 86400000) // 允许比发布日期早 1 天（跨时区/日期误差）
    .sort((a, b) => b.date.getTime() - a.date.getTime());
  if (!candidates.length) return null;
  return {
    value: candidates[0].str,
    source: 'fallback',
  };
}

/**
 * 从公告正文中提取截止日期
 * @param {string} text - 公告正文
 * @param {string|Date|null} publishDate - 发布时间，用于兜底过滤
 * @returns {{value: string|null, source: string|null}}
 */
function parseDeadline(text, publishDate) {
  if (!text || typeof text !== 'string') {
    return { value: null, source: null };
  }
  const normalized = normalizeDateText(text);
  const cleaned = cleanDeadlineText(normalized);
  const byRules = extractByRules(cleaned);
  if (byRules) return byRules;
  return extractFallback(cleaned, publishDate);
}

/**
 * 对已有的 deadline 字符串做规范化（用于历史数据迁移）
 * @param {string} text
 * @returns {string|null}
 */
function normalizeDeadlineText(text) {
  if (!text || typeof text !== 'string') return null;
  const normalized = normalizeDateText(text);
  const cleaned = cleanDeadlineText(normalized);
  const byRules = extractByRules(cleaned);
  if (byRules) return byRules.value;
  const fallback = extractFallback(cleaned, null);
  return fallback ? fallback.value : null;
}

/**
 * 判断字符串是否为已规范化的 deadline
 * @param {string} value
 * @returns {boolean}
 */
function isNormalizedDeadline(value) {
  if (!value || typeof value !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(value);
}

module.exports = {
  parseDeadline,
  normalizeDeadlineText,
  isNormalizedDeadline,
  formatDateLocal,
  parseDateString,
  normalizeDateText,
  cleanDeadlineText,
};
