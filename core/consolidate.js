#!/usr/bin/env node
'use strict';
// Слияние дублирующихся тем накопительной памяти.
// Builder умеет только обновлять существующую тему и создавать новую — операции «объединить»
// у него нет, поэтому за время миграций темы расплодились (feedback-* × 4, telegram-* × 3 …).
// Здесь: LLM группирует близкие темы → сливает тела в один шард → лишние файлы удаляются.
// Разовая/редкая операция, запускается руками. Ночной cron её не трогает.
//
//   node consolidate.js --project root --dry-run    # показать план слияния
//   node consolidate.js --project root              # применить
//
// Лимит подписки → exit 42 (тот же контракт, что у builder), файлы не портятся.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLAUDE = (process.env.MEMKIT_CLAUDE_BIN||(process.env.HOME||'/root')+'/.local/bin/claude');
const PROJECTS_DIR = (process.env.MEMKIT_PROJECTS_DIR||(process.env.HOME||'/root')+'/projects');
const ROOT_MEM = (process.env.MEMKIT_ROOT_MEM||(process.env.HOME||'/root')+'/.claude/projects/-root/memory');
const MODEL = process.env.MEMKIT_MODEL||'sonnet';
const SHARD_MAX_LINES = 150;

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ONLY = (() => { const i = args.indexOf('--project'); return i >= 0 ? args[i + 1] : 'root'; })();
const msk = () => new Intl.DateTimeFormat('en-CA', { timeZone: (process.env.MEMKIT_TZ||'Europe/Moscow') }).format(new Date());
const log = (...a) => console.log('[consolidate ' + new Date().toISOString() + ']', ...a);
const rd = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
class LimitError extends Error {}

function callClaude(prompt, tries = 3) {
  const tmp = path.join('/tmp', 'cons-' + process.pid + '-' + Date.now() + '.txt');
  fs.writeFileSync(tmp, prompt);
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const r = spawnSync('bash', ['-c', `cat ${JSON.stringify(tmp)} | ${CLAUDE} -p --model ${MODEL} --output-format json --no-session-persistence`],
      { encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024, cwd: '/tmp' });
    let obj = null; try { obj = JSON.parse(r.stdout || ''); } catch {}
    const aes = obj ? String(obj.api_error_status || '') : '', sub = obj ? String(obj.subtype || '') : '';
    if (/limit|rate|429|overload|exhaust/i.test(aes) || /limit|rate/i.test(sub) || /usage limit|rate limit/i.test(r.stdout || '')) { try { fs.unlinkSync(tmp); } catch {} throw new LimitError(aes || sub || 'limit'); }
    if (obj && obj.is_error !== true && obj.subtype === 'success' && obj.result) { try { fs.unlinkSync(tmp); } catch {} return String(obj.result); }
    lastErr = 'rc=' + r.status + ' sub=' + sub; log(`  попытка ${attempt}/${tries}: ${lastErr}`);
  }
  try { fs.unlinkSync(tmp); } catch {}
  throw new Error('claude failed: ' + lastErr);
}
function extractJSON(t) { t = String(t).trim(); const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) t = f[1].trim(); const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a >= 0 && b > a) t = t.slice(a, b + 1); return JSON.parse(t); }

function readShards(dir) {
  const out = [];
  try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.md')) {
    const body = rd(path.join(dir, f));
    const title = (body.match(/^#\s+(.+)$/m) || [, f.replace(/\.md$/, '')])[1].trim();
    const first = (body.replace(/^---[\s\S]*?---/, '').split('\n').find(l => l.trim() && !l.startsWith('#')) || '').trim().slice(0, 120);
    out.push({ slug: f.replace(/\.md$/, ''), title, body, first, bytes: body.length });
  } } catch {}
  return out;
}

// ФАЗА 1: какие темы дублируют друг друга.
function planMerge(shards, maxTopics) {
  const list = shards.map(s => `- ${s.slug} | ${s.title} | ${s.first}`).join('\n');
  const p = `Есть накопительная тематическая память. Тем накопилось ${shards.length}, целевой максимум — ${maxTopics}.
Многие темы дублируют друг друга (расплодились при миграциях). Сгруппируй те, что по смыслу об ОДНОМ, чтобы слить в одну.

Правила:
- Сливай только реальные дубли/подтемы одного предмета. Разное по смыслу НЕ трогай.
- В группе 2+ темы. Тема, которой нет в группах, останется как есть.
- target_slug — лучший из существующих слагов группы (латиница), target_title — понятный заголовок по-русски.
- Ориентир: после слияния тем должно стать примерно ${maxTopics}. Не пережимай: лучше оставить отдельным, чем свалить несвязанное.

Верни СТРОГО JSON:
{"merge":[{"target_slug":"...","target_title":"...","sources":["slug1","slug2"],"why":"кратко"}]}

ТЕМЫ (slug | title | первая строка):
${list}`;
  return extractJSON(callClaude(p));
}

// ФАЗА 2: слить тела группы в один шард.
function mergeShards(title, bodies) {
  const p = `Слей несколько шардов памяти в ОДИН по теме "${title}". Язык русский.
Правила: сохрани ВСЁ ценное из каждого (факты, решения, пути, модели, открытые вопросы), убери дубли и воду,
противоречия разреши в пользу более свежего, помечай устаревшее. Ничего важного не потеряй — это единственная копия.
Структура: # Заголовок, краткое описание, ## Ключевые решения/факты, ## Статус / открытые вопросы. Не длиннее ${SHARD_MAX_LINES} строк.
В начале верни frontmatter: ---\ntags: [3-6 ключевых слов]\nupdated: ${msk()}\n---

Верни ТОЛЬКО markdown итогового шарда, без пояснений.

${bodies.map((b, i) => `=== ШАРД ${i + 1} ===\n${b}`).join('\n\n')}`;
  return callClaude(p);
}

function main() {
  const mdir = (ONLY === 'root' || ONLY === '_root') ? ROOT_MEM : path.join(PROJECTS_DIR, ONLY, 'memory');
  const topicsDir = path.join(mdir, 'topics');
  const maxTopics = (ONLY === 'root' || ONLY === '_root') ? 18 : 12;
  const shards = readShards(topicsDir);
  log(`контур ${ONLY}: тем ${shards.length}, целевой максимум ${maxTopics}`);
  if (shards.length <= maxTopics) { log('консолидация не нужна'); return; }

  let plan;
  try { plan = planMerge(shards, maxTopics); }
  catch (e) { if (e instanceof LimitError) { log('ЛИМИТ Claude — выход 42'); process.exit(42); } log('план не удался: ' + e.message); process.exit(1); }
  const groups = (plan.merge || []).filter(g => Array.isArray(g.sources) && g.sources.length >= 2);
  if (!groups.length) { log('LLM не нашла дублей — вручную'); return; }

  const after = shards.length - groups.reduce((n, g) => n + g.sources.filter(s => shards.some(x => x.slug === s)).length - 1, 0);
  log(`план: ${groups.length} групп слияния, тем станет ~${after}`);
  for (const g of groups) log(`  ${g.sources.join(' + ')} → ${g.target_slug} (${g.target_title}) — ${g.why || ''}`);
  if (DRY) { log('[dry-run] ничего не записано'); return; }

  // бэкап перед разрушающей операцией — шарды единственная копия знания
  const bak = path.join(mdir, 'topics.bak.' + Date.now());
  fs.cpSync(topicsDir, bak, { recursive: true });
  log(`бэкап: ${bak}`);

  let merged = 0;
  for (const g of groups) {
    const src = g.sources.map(s => shards.find(x => x.slug === s)).filter(Boolean);
    if (src.length < 2) { log(`  ${g.target_slug}: исходников <2 — пропуск`); continue; }
    let md;
    try { md = mergeShards(g.target_title || g.target_slug, src.map(s => s.body)); }
    catch (e) { if (e instanceof LimitError) { log('ЛИМИТ Claude на слиянии — выход 42, остальное цело'); process.exit(42); } log(`  ${g.target_slug}: ошибка (${e.message}) — группа пропущена`); continue; }
    md = String(md).replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/, '').trim();
    if (md.length < 200) { log(`  ${g.target_slug}: подозрительно короткий результат — группа пропущена`); continue; }
    fs.writeFileSync(path.join(topicsDir, g.target_slug + '.md'), md + '\n');
    for (const s of src) if (s.slug !== g.target_slug) { try { fs.unlinkSync(path.join(topicsDir, s.slug + '.md')); } catch {} }
    merged++; log(`  ✓ ${g.sources.join(' + ')} → ${g.target_slug}`);
  }
  log(`слито групп: ${merged}/${groups.length}; тем на диске: ${readShards(topicsDir).length}`);
  log('дальше: node builder.js --reindex');
}
main();
