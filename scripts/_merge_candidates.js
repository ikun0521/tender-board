#!/usr/bin/env node
/**
 * 合并爬虫候选(95306 / crrcgo / suzhou-metro)与 WebSearch 候选为 sync-tenders 可消费的 search-results.json。
 * 关键：sync-tenders 会重新 fetch 候选 URL 并抽取，但一手平台(95306/crrcgo/suzhou-metro)是 JS 渲染页，
 * 取不到正文 → 退化为用 candidateTitle + snippet 抽取。因此把爬虫已得的
 * 采购人/发布时间/截止时间 编码进 snippet，保证抽取质量不丢失。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(ROOT, p), 'utf8'));
  } catch (e) {
    console.log(`[合并] 读取失败 ${p}: ${e.message}`);
    return [];
  }
}

function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '').replace(/[（）()]/g, '').trim();
}

const out = [];

// ---- 国铁 95306 ----
for (const c of readJson('scripts/95306-candidates.json')) {
  // 变更公告(变更/澄清)若无真实截止日期，仅是已结/在途项目的更正说明，无可投标价值，
  // 且 sync 会从摘要里错抽到历史截止日造成过期噪音 → 丢弃；保留带真实日期的变更(如二次公告/延期)。
  const isChange = /变更|澄清|补遗/.test(c.noticeType || '');
  const noDeadline = !c.deadline || c.deadline === '待确认' || c.deadline === 'null';
  if (isChange && noDeadline) continue;

  const unit = (c.unit || '').trim();
  const publish = (c.publish || '').trim();
  const deadline = (c.deadline || '').trim();
  const digest = (c.snippet || '').trim();
  let snip = '';
  if (unit) snip += `采购人：${unit}。`;
  if (publish) snip += `发布时间：${publish}。`;
  if (deadline && deadline !== '待确认') snip += `投标/响应截止：${deadline}。`;
  snip += digest;
  if (!c.link) continue;
  out.push({
    title: (c.name || '').trim(),
    url: c.link,
    snippet: snip,
    keyword: c.keyword || '',
    _src: '95306',
    // 结构化字段：同步时直接采用，作为权威来源（权重最高）
    deadline,
    unit,
    publish,
  });
}

// ---- 中车购 crrcgo ----
for (const c of readJson('scripts/crrcgo-candidates.json')) {
  const unit = (c.unit || '').trim();
  const publish = (c.publish || '').trim();
  const deadline = (c.deadline || '').trim();
  let snip = '';
  if (unit) snip += `采购人：${unit}。`;
  if (publish) snip += `发布时间：${publish}。`;
  if (deadline && deadline !== '待确认') snip += `截止：${deadline}。`;
  const url = c.url || c.link;
  if (!url) continue;
  out.push({
    title: (c.title || c.name || '').trim(),
    url,
    snippet: snip,
    keyword: c.keyword || c.category || '',
    _src: 'crrcgo',
    // 结构化字段：同步时直接采用，作为权威来源（权重最高）
    deadline,
    unit,
    publish,
  });
}

// ---- 苏州轨道交通 suzhou-metro ----
for (const c of readJson('scripts/suzhou-metro-candidates.json')) {
  const unit = (c.unit || '').trim();
  const publish = (c.publish || '').trim();
  const deadline = (c.deadline || '').trim();
  let snip = '';
  if (unit) snip += `采购人：${unit}。`;
  if (publish) snip += `发布时间：${publish}。`;
  if (deadline && deadline !== '待确认') snip += `截止：${deadline}。`;
  const url = c.url || c.link;
  if (!url) continue;
  out.push({
    title: (c.name || c.title || '').trim(),
    url,
    snippet: snip,
    keyword: c.keyword || '',
    _src: 'suzhou-metro',
    // 结构化字段：同步时直接采用，作为权威来源（权重最高）
    deadline,
    unit,
    publish,
    platform: c.platform || '苏州轨道交通',
  });
}

// ---- 深圳轨道交通 szmetro ----
for (const c of readJson('scripts/szmetro-candidates.json')) {
  const unit = (c.unit || '').trim();
  const publish = (c.publish || '').trim();
  const deadline = (c.deadline || '').trim();
  const dlSource = (c.deadlineSource || '').trim();
  let snip = '';
  if (unit) snip += `采购人：${unit}。`;
  if (publish) snip += `发布时间：${publish}。`;
  if (deadline && deadline !== '待确认') snip += `截止：${deadline}。`;
  else if (dlSource) snip += `截止：${dlSource}。`;
  const url = c.url || c.link;
  if (!url) continue;
  out.push({
    title: (c.name || c.title || '').trim(),
    url,
    snippet: snip,
    keyword: c.keyword || '',
    _src: 'szmetro',
    // 结构化字段：同步时直接采用，作为权威来源（权重最高）
    deadline,
    unit,
    publish,
    platform: c.platform || '深圳轨道交通',
  });
}

// ---- 深圳阳光采购 szygcgpt ----
for (const c of readJson('scripts/szygcgpt-candidates.json')) {
  const unit = (c.unit || '').trim();
  const publish = (c.publish || '').trim();
  const deadline = (c.deadline || '').trim();
  let snip = '';
  if (unit) snip += `采购人：${unit}。`;
  if (publish) snip += `发布时间：${publish}。`;
  if (deadline && deadline !== '待确认') snip += `截止：${deadline}。`;
  const url = c.link;
  if (!url) continue;
  out.push({
    title: (c.name || '').trim(),
    url,
    snippet: snip,
    keyword: c.keyword || '',
    _src: 'szygcgpt',
    deadline,
    unit,
    publish,
    platform: c.platform || '深圳阳光采购',
  });
}

// ---- 中国招标投标公共服务平台 cebpubservice（法定聚合兜底，覆盖全平台） ----
for (const c of readJson('scripts/cebpubservice-candidates.json')) {
  const unit = (c.unit || '').trim();
  const publish = (c.publish || '').trim();
  const deadline = (c.deadline || '').trim();
  const srcPlat = (c.sourcePlatform || '').trim();
  let snip = '';
  if (srcPlat) snip += `来源平台：${srcPlat}（中国招标投标公共服务平台聚合）。`;
  if (unit) snip += `采购人：${unit}。`;
  if (publish) snip += `发布时间：${publish}。`;
  if (deadline && deadline !== '待确认') snip += `开标/截止：${deadline}。`;
  const url = c.url || c.link;
  if (!url) continue;
  out.push({
    title: (c.title || '').trim(),
    url,
    snippet: snip,
    keyword: c.keyword || '',
    _src: 'cebpubservice',
    // 结构化字段：同步时直接采用，作为权威来源（权重最高）
    deadline,
    deadlineSource: c.deadlineSource || '',
    sourcePlatform: srcPlat,
    unit,
    publish,
    platform: c.platform || srcPlat || '中国招标投标公共服务平台',
  });
}

// ---- WebSearch 补充 ----
for (const c of readJson('scripts/websearch-candidates.json')) {
  if (!c.url || !c.title) continue;
  out.push({
    title: c.title.trim(),
    url: c.url,
    snippet: (c.snippet || '').trim(),
    keyword: c.keyword || '',
    _src: 'websearch',
  });
}

// ---- 去重：按 url 与 规范化标题 ----
const seenUrl = new Set();
const seenName = new Set();
const merged = [];
for (const c of out) {
  const u = (c.url || '').trim();
  const n = norm(c.title);
  if (u && seenUrl.has(u)) continue;
  if (n && seenName.has(n)) continue;
  if (u) seenUrl.add(u);
  if (n) seenName.add(n);
  merged.push(c);
}

// 统计来源
const bySrc = {};
for (const c of merged) bySrc[c._src] = (bySrc[c._src] || 0) + 1;

fs.writeFileSync(
  path.resolve(ROOT, 'scripts/search-results.json'),
  JSON.stringify(merged, null, 2),
  'utf8'
);

console.log(`[合并] 候选合计 ${merged.length} 条`, bySrc);
console.log(`[合并] 已写入 scripts/search-results.json`);
