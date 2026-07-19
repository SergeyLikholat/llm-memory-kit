#!/usr/bin/env node
'use strict';
// Накопительная память сессий через headless Claude (подписка).
// Проектные контуры: <projects>/<X>/memory/ (темы по проекту).
// Общий контур:      <root-mem>/ (темы по смыслу — бездомные сессии).
// 3 уровня: topics/<slug>.md (шарды, с tags) → _index.md (карта) → _memory-index.md (глобальная).
// Лимит подписки → process.exit(42) без порчи файлов (контракт с wrapper).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = process.env.HOME || '/root';
const CLAUDE = (process.env.MEMKIT_CLAUDE_BIN || HOME + '/.local/bin/claude');
const PROJECTS_DIR = (process.env.MEMKIT_PROJECTS_DIR || HOME + '/projects');
const ROOT_MEM = (process.env.MEMKIT_ROOT_MEM || HOME + '/.claude/projects/-root/memory');
const GLOBAL_INDEX = path.join(ROOT_MEM, '_memory-index.md');
const CLAUDE_MD = (process.env.MEMKIT_CLAUDE_MD || HOME + '/CLAUDE.md');
const OBSIDIAN_DIR = (process.env.MEMKIT_OBSIDIAN_DIR || '');
const MODEL = process.env.MEMKIT_MODEL || 'sonnet';
const TZ = process.env.MEMKIT_TZ || 'Europe/Moscow';
// Приватные контуры: содержание скрыто в глобальной карте. Настраивается через env
// MEMKIT_PRIVATE_PROJECTS (список имён через запятую). По умолчанию — пусто.
const PRIVATE = new Set((process.env.MEMKIT_PRIVATE_PROJECTS || '').split(',').map(s => s.trim()).filter(Boolean));
const SHARD_MAX_LINES = 150;

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ONLY = (() => { const i = args.indexOf('--project'); return i >= 0 ? args[i + 1] : null; })();
const GLOBAL_ONLY = args.includes('--global-only');
const FORCE = args.includes('--force');
const REINDEX = args.includes('--reindex');   // пересобрать _index со всех шардов, без LLM
const msk = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const log = (...a) => console.log('[memory-index ' + new Date().toISOString() + ']', ...a);

function hasFreshData(mdir) {
  // Обрабатываем контур ТОЛЬКО если буфер новее собранного индекса (экономия лимита).
  try {
    const daily = fs.statSync(path.join(mdir, 'activity', 'daily.md')).mtimeMs;
    let idx = 0; try { idx = fs.statSync(path.join(mdir, '_index.md')).mtimeMs; } catch { return true; }
    return daily > idx;
  } catch { return false; }
}
function rd(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function slugify(s) { return String(s || 'topic').toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'topic'; }
class LimitError extends Error {}

function callClaude(prompt, tries = 3) {
  const tmp = path.join('/tmp', 'mib-' + process.pid + '-' + Date.now() + '.txt');
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

function readShards(topicsDir) {
  const out = [];
  try { for (const f of fs.readdirSync(topicsDir)) if (f.endsWith('.md')) {
    const body = rd(path.join(topicsDir, f));
    const title = (body.match(/^#\s+(.+)$/m) || [, f.replace(/\.md$/, '')])[1].trim();
    out.push({ slug: f.replace(/\.md$/, ''), title, body });
  } } catch {}
  return out;
}
function splitBlocks(md) { return md.split(/(?=^## \d{4}-\d{2}-\d{2})/m).filter(b => /^## \d{4}-\d{2}-\d{2}/.test(b)); }

// ФАЗА 1 (дёшево): к каким темам относятся новые блоки; какие темы создать.
function routeBlocks(label, shards, blocks, maxTopics, byTheme) {
  const topicList = shards.map(s => `- ${s.slug}: ${s.title}`).join('\n') || '(тем ещё нет)';
  const blockList = blocks.map((b, i) => `#${i}: ${b.replace(/\s+/g, ' ').slice(0, 700)}`).join('\n\n');
  const p = `Есть накопительная тематическая память "${label}"${byTheme ? ' (общий контур: всё вне конкретных проектов)' : ''}. Язык русский.
Ниже СУЩЕСТВУЮЩИЕ ТЕМЫ и НОВЫЕ ЗАПИСИ активности. Для каждой записи определи, к какой теме она относится.
- Если подходит существующая тема — верни её slug.
- Если новая по смыслу — верни "NEW" и предложи короткий slug (латиница) и title.
- Ориентир по числу тем: ${maxTopics}. Близкие по смыслу не плоди — сливай в существующие.
- НО: если запись про то, чего в темах реально нет (новая область работы или жизни) — верни NEW и заведи тему.
  Впихивать несвязанное в «ближайшую подходящую» нельзя: знание там растворяется и его не найти.

Верни СТРОГО JSON: {"route":[{"block":0,"topic":"<slug|NEW>","new_slug":"...","new_title":"..."}]}

СУЩЕСТВУЮЩИЕ ТЕМЫ:
${topicList}

НОВЫЕ ЗАПИСИ:
${blockList.slice(0, 45000)}`;
  const raw = callClaude(p);
  return extractJSON(raw);
}

// ФАЗА 2 (точечно): обновить ОДНУ тему её блоками.
function updateShard(label, topicTitle, oldBody, blocks) {
  const p = `Обнови ОДИН тематический шард накопительной памяти "${label}". Язык русский.
Тема: "${topicTitle}".
Правила: сохрани всё ценное из старого шарда, влей новое из записей, убери дубли/шум, помечай устаревшее.
Структура: # Заголовок, краткое описание, ## Ключевые решения/факты, ## Статус / открытые вопросы. Не длиннее ${SHARD_MAX_LINES} строк.
В начале верни frontmatter с тегами: ---\ntags: [3-6 ключевых слов]\nupdated: ${msk()}\n---

Верни ТОЛЬКО markdown шарда, без пояснений.

=== СТАРЫЙ ШАРД ===
${oldBody || '(новая тема — создай с нуля)'}

=== НОВЫЕ ЗАПИСИ ПО ТЕМЕ ===
${blocks.join('\n\n').slice(0, 30000)}`;
  return callClaude(p);
}

function processTarget(label, mdir, maxTopics, byTheme) {
  const daily = rd(path.join(mdir, 'activity', 'daily.md'));
  const topicsDir = path.join(mdir, 'topics');
  const shards = readShards(topicsDir);
  const blocks = splitBlocks(daily);
  if (!blocks.length && !shards.length) return null;
  // Переполнение видно и требует слияния — но НЕ молча и не отбрасыванием хвоста (так терялись темы).
  if (shards.length > maxTopics) log(`  ⚠ ${label}: тем ${shards.length} > ${maxTopics} — дубли множатся, нужна консолидация: node consolidate-topics.js --project ${label} --dry-run`);
  if (!blocks.length) { log(`  ${label}: новых записей нет — только переоглавление`); return { label, mdir, topics: shards.map(s => ({ slug: s.slug, title: s.title, oneline: '', tags: [] })) }; }

  // ФАЗА 1
  let route;
  try { route = routeBlocks(label, shards, blocks, maxTopics, byTheme); }
  catch (e) { if (e instanceof LimitError) throw e; log(`  ${label}: маршрутизация не удалась (${e.message})`); return null; }
  const byTopic = {};   // slug → {title, blocks[], old}
  for (const r of (route.route || [])) {
    const b = blocks[r.block]; if (!b) continue;
    let slug = r.topic, title = null;
    if (!slug || slug === 'NEW') { slug = slugify(r.new_slug || r.new_title || 'тема'); title = r.new_title || slug; }
    const ex = shards.find(s => s.slug === slug);
    (byTopic[slug] ||= { title: title || (ex ? ex.title : slug), old: ex ? ex.body : '', blocks: [] }).blocks.push(b);
  }
  if (DRY) { log(`  [dry] ${label}: затронуто тем ${Object.keys(byTopic).length} — ${Object.keys(byTopic).join(', ')}`); return { label, mdir, topics: [] }; }

  // ФАЗА 2 — только затронутые темы
  fs.mkdirSync(topicsDir, { recursive: true });
  let updated = 0;
  for (const [slug, t] of Object.entries(byTopic)) {
    let md;
    try { md = updateShard(label, t.title, t.old, t.blocks); }
    catch (e) { if (e instanceof LimitError) throw e; log(`    ${slug}: ошибка (${e.message}) — пропуск`); continue; }
    if (!md) continue;
    md = String(md).replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/, '').trim();
    fs.writeFileSync(path.join(topicsDir, slug + '.md'), md + '\n');
    updated++; log(`    ✓ ${slug}`);
  }
  log(`  ${label}: обновлено тем ${updated}/${Object.keys(byTopic).length} (не тронуто ${Math.max(0, shards.length - Object.keys(byTopic).length)})`);

  return writeIndex(label, mdir, topicsDir);
}

// _index строится из ВСЕХ шардов на диске. Раньше здесь стоял срез до 30 — темы за границей
// молча выпадали из индекса, а retrieval-хук ищет только по индексу: файл есть, найти нельзя.
// Не вызывает LLM — можно гонять отдельно (--reindex) после ручных правок или консолидации.
function writeIndex(label, mdir, topicsDir) {
  const all = readShards(topicsDir);
  const idx = [`---`, `type: memory-project-index`, `scope: ${label}`, ...(rd(path.join(mdir, '_index.md')).match(/^purpose:.*$/m) ? [rd(path.join(mdir, '_index.md')).match(/^purpose:.*$/m)[0]] : []), `updated: ${msk()}`, `---`, ``,
    `# Память: ${label}`, ``, `Тематические шарды (детали — по ссылке):`, ``,
    ...all.map(s => { const tg = (s.body.match(/^tags:\s*\[(.*?)\]/m) || [, ''])[1]; const first = (s.body.replace(/^---[\s\S]*?---/, '').split('\n').find(l => l.trim() && !l.startsWith('#')) || '').trim().slice(0, 90); return `- **${s.title}** — ${first}${tg ? ` _[${tg}]_` : ''} → \`topics/${s.slug}.md\``; })].join('\n') + '\n';
  fs.writeFileSync(path.join(mdir, '_index.md'), idx);
  return { label, mdir, topics: all.map(s => ({ slug: s.slug, title: s.title })) };
}

function loadRegistry() {
  // Назначения проектов из таблицы Projects Registry в CLAUDE.md: name → «зачем» (лаконично).
  const map = {};
  const md = rd(CLAUDE_MD);
  const re = /\|\s*\*\*([a-z0-9-]+)\*\*\s*\|[^|]*\|\s*([^|]+?)\s*\|/gi;
  let m;
  while ((m = re.exec(md))) {
    let d = m[2].replace(/`/g, '').replace(/\*\*/g, '').trim();
    const dot = d.search(/[.!?]\s/);
    if (dot > 30 && dot < 200) d = d.slice(0, dot + 1); else if (d.length > 180) d = d.slice(0, 180) + '…';
    map[m[1]] = d;
  }
  return map;
}
function titlesOf(idxPath) { return (rd(idxPath).match(/^- \*\*(.+?)\*\*/gm) || []).map(x => x.replace(/^- \*\*|\*\*$/g, '')); }
function purposeOverride(idxPath) { const m = rd(idxPath).match(/^purpose:\s*["\x27]?(.+?)["\x27]?\s*$/m); return m ? m[1].trim() : null; }
function purposeLines(blocks) {
  // Один вызов Claude: label → короткая инструкция «за чем сюда идти». Пути/структуру НЕ трогает.
  const prompt = `Ты составляешь главный путеводитель по памяти. Для каждого раздела дай ОДНУ короткую строку-инструкцию (по-русски): ЗА ЧЕМ сюда обращаться, что можно найти/вытащить — функционально, НЕ списком тем. Пример: для планировщика — "Актуальные и запланированные задачи по проектам, их статусы и что сейчас в работе". Приватные (private:true) — нейтрально, без раскрытия содержания.
Верни СТРОГО JSON: {"ЛЕЙБЛ": "инструкция", ...} для всех лейблов.
Данные:
${JSON.stringify(blocks, null, 1)}`;
  const raw = callClaude(prompt);
  return extractJSON(raw);
}

function buildGlobal() {
  const reg = loadRegistry();
  const targets = [];
  try { for (const p of fs.readdirSync(PROJECTS_DIR)) { const idx = path.join(PROJECTS_DIR, p, 'memory', '_index.md'); if (fs.existsSync(idx)) targets.push({ label: p, idx, priv: PRIVATE.has(p) }); } } catch {}
  const rootIdx = path.join(ROOT_MEM, '_index.md');
  const hasRoot = fs.existsSync(rootIdx);
  targets.sort((a, b) => a.label.localeCompare(b.label));

  // данные для LLM: назначение (реестр) + темы
  const blocks = targets.map(t => ({ label: t.label, private: t.priv, purpose_hint: reg[t.label] || '', topics: t.priv ? [] : titlesOf(t.idx).slice(0, 8) }));
  if (hasRoot) blocks.push({ label: 'общий-контур', private: false, purpose_hint: 'Всё вне конкретных проектов: инфраструктура сервера, инструменты Claude Code/VS Code, боты, система памяти, скиллы, бэкапы, эксперименты', topics: titlesOf(rootIdx).slice(0, 8) });

  let purpose = {};
  try { purpose = purposeLines(blocks) || {}; } catch (e) { log('путеводитель: LLM недоступен (' + e.message + '), fallback на реестр'); }

  const L = ['---', 'type: memory-index', `updated: ${msk()}`, '---', '',
    '# 🧭 Память — главный путеводитель', '',
    'Карта всей памяти: куда идти по вопросу. Здесь только указатели — детали открываются по пути.', '',
    '## Слои памяти', '',
    '- **Личные правила и предпочтения** — как обращаться, договорённости, рабочие приёмы.',
    `  → \`${path.join(ROOT_MEM, 'MEMORY.md')}\``];
  if (OBSIDIAN_DIR) L.push(
    '- **Знания из заметок (Obsidian)** — тематические карты (MOC).',
    `  → \`${path.join(OBSIDIAN_DIR, '_wiki/index.md')}\` _(релевантные карты также подставляются авто на каждый запрос)_`);
  L.push('- **История и задачи по проектам** — ниже, у каждого свой `_index.md`.', '',
    '## Проекты — за чем сюда идти', '');
  const fallback = t => reg[t.label] ? (reg[t.label].split(/[.!?]\s/)[0] + '.') : ('Темы: ' + titlesOf(t.idx).slice(0, 4).join(' · ') || 'Проектная память.');
  for (const t of targets) {
    const line = purposeOverride(t.idx) || (purpose[t.label] || '').trim() || fallback(t);
    if (t.priv) L.push(`### ${t.label} 🔒`, (purpose[t.label] || 'Приватный контур, содержание скрыто.').trim(), `→ \`${t.idx}\``, '');
    else L.push(`### ${t.label}`, line, `→ \`${t.idx}\``, '');
  }
  if (hasRoot) L.push('## Общий контур (система / разное)', '', (purpose['общий-контур'] || 'Инфраструктура сервера, инструменты, боты, память, скиллы, бэкапы, эксперименты.').trim(), `→ \`${rootIdx}\``, '');
  return L.join('\n') + '\n';
}
function main() {
  log(`старт (dry=${DRY}, project=${ONLY || '*'}, globalOnly=${GLOBAL_ONLY})`);
  if (GLOBAL_ONLY) { fs.writeFileSync(GLOBAL_INDEX, buildGlobal()); log('глобальная карта пересобрана с диска'); return; }
  if (REINDEX) {
    let n = 0;
    for (const p of fs.readdirSync(PROJECTS_DIR)) {
      const mdir = path.join(PROJECTS_DIR, p, 'memory'), td = path.join(mdir, 'topics');
      if (!fs.existsSync(td)) continue;
      const r = writeIndex(p, mdir, td); log(`  ${p}: ${r.topics.length} тем в индексе`); n++;
    }
    const r = writeIndex('root', ROOT_MEM, path.join(ROOT_MEM, 'topics'));
    log(`  root: ${r.topics.length} тем в индексе`); n++;
    fs.writeFileSync(GLOBAL_INDEX, buildGlobal());
    log(`переиндексация без LLM: ${n} контуров + глобальная карта`); return;
  }
  const results = [];
  try {
    // проектные контуры
    let names = fs.readdirSync(PROJECTS_DIR).filter(n => fs.existsSync(path.join(PROJECTS_DIR, n, 'memory', 'activity', 'daily.md')) || fs.existsSync(path.join(PROJECTS_DIR, n, 'memory', 'topics')));
    if (ONLY) names = names.filter(n => n === ONLY);
    for (const n of names) {
      const mdir = path.join(PROJECTS_DIR, n, 'memory');
      if (!FORCE && !ONLY && !hasFreshData(mdir)) { log(`  ${n}: нет новых данных — пропуск (экономия)`); continue; }
      results.push(processTarget(n, mdir, 12, false));
    }
    // общий контур (бездомные) — если не ограничен --project или явно указан 'root'
    if (!ONLY || ONLY === 'root' || ONLY === '_root') {
      if (FORCE || ONLY || hasFreshData(ROOT_MEM)) results.push(processTarget('root', ROOT_MEM, 18, true));
      else log('  root: нет новых данных — пропуск (экономия)');
    }
  } catch (e) {
    if (e instanceof LimitError) { log(`ЛИМИТ Claude (${e.message}) — выход 42`); process.exit(42); }
    log('фатально: ' + (e.stack || e)); process.exit(1);
  }
  if (!DRY) fs.writeFileSync(GLOBAL_INDEX, buildGlobal());
  log(`готово: ${results.filter(Boolean).length} контуров`);
}
main();
