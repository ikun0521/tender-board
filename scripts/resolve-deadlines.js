#!/usr/bin/env node
/**
 * 重新爬取看板中「截止未确认」的国铁(95306)公告详情，解析权威截止日期并写回 index.html。
 * =====================================================================
 * - 复用 crawl-95306.js 的 getDetail / mergeDeadline：
 *   latestDocumentSaleEndTime（报名截止）为权威基准，与 crawl-95306 口径一致
 * - latestEnd 为空时，用正文 deadline-parser 兜底解析（过滤早于发布日期的历史噪音）
 * - 写回采用行级精准替换：只改对应 id 对象的 "deadline" 值，不重排数组、不动其他字段
 *
 * 用法：
 *   node scripts/resolve-deadlines.js            # 解析并写回（先备份 index_backup.html）
 *   node scripts/resolve-deadlines.js --dry-run  # 仅预览，不写盘
 */
const fs = require('fs');
const path = require('path');
const crawl = require('./crawl-95306');
const sync = require('./sync-tenders');
const { parseDeadline } = require('./lib/deadline-parser');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'index.html');
const BACKUP_PATH = path.join(ROOT, 'index_backup.html');

const UNCLEAR_RE =
  /待确认|未确认|见(?:招标文件|公告|平台|中车购|国铁)|已直采|公示期|可能已截止|截止待定/i;
const DRY_RUN = process.argv.includes('--dry-run');

/** 行级精准替换：定位 id 对应对象块，仅替换其中 "deadline" 字段的值 */
function replaceDeadlineInHtml(html, id, newValue) {
  const { lines, blocks } = sync.parseTenderBlocks(html);
  const block = blocks.find((b) => String(b.id) === String(id));
  if (!block) return html;
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  let hit = false;
  for (let i = block.start; i <= block.end; i++) {
    const m = lines[i].match(/^(\s*"deadline"\s*:\s*)"([^"]*)"(,?)\s*$/);
    if (m) {
      lines[i] = `${m[1]}"${newValue}"${m[3]}`;
      hit = true;
      break;
    }
  }
  return hit ? lines.join(eol) : html;
}

/** 截止日期不能早于发布时间（防正文抓到历史日期噪音）；非法则返回 null */
function sanityDeadline(value, publish) {
  const d = crawl.parseDateLoose(value);
  if (!d) return null;
  const p = crawl.parseDateLoose(publish);
  if (p && d < p) return null;
  return value;
}

async function main() {
  let html = fs.readFileSync(HTML_PATH, 'utf8');
  const tenders = sync.loadTendersFromHtml(html);
  const unclear = tenders.filter((t) => !t.deadline || UNCLEAR_RE.test(t.deadline));
  const targets = unclear.filter((t) => /cg\.95306\.cn/.test(t.link || ''));
  const skipped = unclear.length - targets.length;
  console.log(`看板总数 ${tenders.length} | 截止未确认 ${unclear.length} | 国铁可重爬 ${targets.length}${skipped ? ` | 非国铁跳过 ${skipped}` : ''}`);
  if (!targets.length) {
    console.log('没有可重爬的目标，退出。');
    return;
  }

  const results = [];
  let idx = 0;
  const CONCURRENCY = 3;

  async function worker() {
    while (idx < targets.length) {
      const t = targets[idx++];
      const m = (t.link || '').match(/informationShow\?id=([0-9a-zA-Z_-]+)/);
      if (!m) {
        results.push({ id: t.id, name: t.name, ok: false, deadline: null, src: '', reason: '链接无 noticeId' });
        continue;
      }
      try {
        const d = await crawl.getDetail(m[1]);
        if (!d) {
          results.push({ id: t.id, name: t.name, ok: false, deadline: null, src: '', reason: '详情接口无数据' });
          continue;
        }
        let deadline = crawl.mergeDeadline(d.latestEnd).value;
        let src = d.latestEnd ? '报名截止(latestEnd)' : '';
        // 兜底：latestEnd 为空 → 正文 deadline-parser。
        // 关键：只接受有明确截止语义的规则命中（source != fallback），
        // 拒绝无规则 fallback 抓到的日期（常把发布时间误当截止日）。
        if (!deadline || deadline === '待确认') {
          const parsed = parseDeadline(d.body, t.publish);
          const v = parsed && parsed.value ? String(parsed.value) : '';
          const ruleHit = parsed && parsed.source && parsed.source !== 'fallback';
          if (ruleHit && v && sanityDeadline(v, t.publish)) {
            deadline = v;
            src = `正文解析(${parsed.source})`;
          }
        }
        const sd = deadline && deadline !== '待确认' ? sanityDeadline(deadline, t.publish) : null;
        const final = sd || '待确认';
        results.push({
          id: t.id,
          name: t.name,
          ok: sd != null,
          deadline: final,
          src: sd != null ? src : '',
          reason: sd != null ? '' : '未解析到合理截止',
        });
        if (sd != null && String(t.deadline) !== final) {
          html = replaceDeadlineInHtml(html, t.id, final);
        }
      } catch (e) {
        results.push({ id: t.id, name: t.name, ok: false, deadline: null, src: '', reason: e.message });
      }
      await crawl.sleep(crawl.REQUEST_INTERVAL);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const done = results.filter((r) => r.ok);
  console.log(`\n解析成功 ${done.length}/${targets.length}`);
  for (const r of results) {
    console.log(
      `  [${r.ok ? '✓' : '✗'}] id=${r.id} ` +
        (r.ok ? `截止 ${r.deadline} (${r.src})` : r.reason || '保持待确认') +
        ` | ${r.name.slice(0, 36)}`
    );
  }

  if (DRY_RUN) {
    console.log('\n--dry-run：不写盘。');
    return;
  }
  if (!done.length) {
    console.log('\n无可更新项，跳过写盘。');
    return;
  }
  fs.copyFileSync(HTML_PATH, BACKUP_PATH);
  fs.writeFileSync(HTML_PATH, html, 'utf8');
  console.log(`\n已备份 ${BACKUP_PATH}，写回 index.html`);
}

main().catch((e) => {
  console.error('[致命错误]', e.message);
  process.exit(1);
});
