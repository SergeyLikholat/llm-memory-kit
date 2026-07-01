#!/usr/bin/env node
'use strict';
// Накопительная память сессий через headless Claude (подписка).
// Проектные контуры: ~/projects/<X>/memory/ (темы по проекту).
// Общий контур:      ~/.claude/projects/-root/memory/ (темы по смыслу — бездомные сессии).
// 3 уровня: topics/<slug>.md (шарды, с tags) → _index.md (карта) → _memory-index.md (глобальная).
// Лимит подписки → process.exit(42) без порчи файлов (контракт с wrapper).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLAUDE = (process.env.MEMKIT_CLAUDE_BIN||(process.env.HOME||'/root')+'/.local/bin/claude');
const PROJECTS_DIR = (process.env.MEMKIT_PROJECTS_DIR||(process.env.HOME||'/root')+'/projects');
const ROOT_MEM = (process.env.MEMKIT_ROOT_MEM||(process.env.HOME||'/root')+'/.claude/projects/-root/memory');
const GLOBAL_INDEX = path.join(ROOT_MEM, '_memory-index.md');
const PRIVATE = new Set(['my-psychologist']);
const SHARD_MAX_LINES = 150;

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ONLY = (() => { const i = args.indexOf('--project'); return i >= 0 ? args[i + 1] : null; })();
const GLOBAL_ONLY = args.includes('--global-only');
const msk = () => new Intl.DateTimeFormat('en-CA', { timeZone: (process.env.MEMKIT_TZ||'Europe/Moscow') }).format(new Date());
const log = (...a) => console.log('[memory-index ' + new Date().toISOString() + ']', ...a);

function rd(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function slugify(s) { return String(s || 'topic').toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'topic'; }
class LimitError extends Error {}

function callClaude(prompt, tries = 3) {
  const tmp = path.join('/tmp', 'mib-' + process.pid + '-' + Date.now() + '.txt');
  fs.writeFileSync(tmp, prompt);
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const r = spawnSync('bash', ['-c', `cat ${JSON.stringify(tmp)} | ${CLAUDE} -p --output-format json --no-session-persistence`],
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

function buildPrompt(label, oldShards, daily, maxTopics, byTheme) {
  const grouping = byTheme
    ? `Это ОБЩИЙ контур (сессии вне конкретных проектов: инфраструктура сервера, инструменты, эксперименты). Раздели по СМЫСЛОВЫМ ТЕМАМ (не по папкам).`
    : `Раздели знание проекта на ТЕМЫ.`;
  return `Ты ведёшь НАКОПИТЕЛЬНУЮ тематическую память "${label}". Язык — русский.
${grouping} Максимум ${maxTopics} тем, близкие сливай.
- Верни ВСЕ темы: существующие (обновлённые) + новые. Ничего ценного из старого не теряй.
- Влей новое, помечай устаревшее, не дублируй. Шард ≤${SHARD_MAX_LINES} строк — если длиннее, ужми.
- oneline — одна строка для оглавления. tags — 3-6 ключевых слов (латиница/русский) для поиска.

Верни СТРОГО JSON без markdown-обёртки:
{"topics":[{"slug":"latin-kebab","title":"Название","oneline":"суть строкой","tags":["ключевое","слово"],"content":"# Название\\n\\n<тело: описание, решения/факты, статус, открытые вопросы>"}]}

=== СУЩЕСТВУЮЩИЕ ШАРДЫ ===
${oldShards || '(пусто)'}

=== СВЕЖАЯ АКТИВНОСТЬ ===
${daily || '(нет новой активности — переоглавь существующее)'}`;
}

function processTarget(label, mdir, maxTopics, byTheme) {
  const daily = rd(path.join(mdir, 'activity', 'daily.md'));
  const topicsDir = path.join(mdir, 'topics');
  let oldShards = '';
  try { for (const f of fs.readdirSync(topicsDir)) if (f.endsWith('.md')) oldShards += `\n--- ${f} ---\n` + rd(path.join(topicsDir, f)); } catch {}
  if (!daily && !oldShards) return null;

  const raw = callClaude(buildPrompt(label, oldShards, daily, maxTopics, byTheme));
  let parsed; try { parsed = extractJSON(raw); } catch { log(`  ${label}: JSON не распарсился, пропуск`); return null; }
  let topics = (Array.isArray(parsed.topics) ? parsed.topics : []).slice(0, maxTopics).map(t => ({
    slug: slugify(t.slug || t.title), title: String(t.title || '?').trim(),
    oneline: String(t.oneline || '').replace(/\s+/g, ' ').trim(),
    tags: Array.isArray(t.tags) ? t.tags.map(x => String(x).trim()).filter(Boolean).slice(0, 6) : [],
    content: String(t.content || '').trim(),
  }));
  if (!topics.length) return null;
  if (DRY) { log(`  [dry] ${label}: ${topics.length} тем — ${topics.map(t => t.slug).join(', ')}`); return { label, mdir, topics }; }

  fs.mkdirSync(topicsDir, { recursive: true });
  for (const t of topics) {
    const fm = `---\ntags: [${t.tags.join(', ')}]\nupdated: ${msk()}\n---\n\n`;
    fs.writeFileSync(path.join(topicsDir, t.slug + '.md'), fm + t.content + '\n');
  }
  const idx = [`---`, `type: memory-project-index`, `scope: ${label}`, `updated: ${msk()}`, `---`, ``,
    `# Память: ${label}`, ``, `Тематические шарды (детали — по ссылке):`, ``,
    ...topics.map(t => `- **${t.title}** — ${t.oneline}${t.tags.length ? ` _[${t.tags.join(', ')}]_` : ''} → \`topics/${t.slug}.md\``)].join('\n') + '\n';
  fs.writeFileSync(path.join(mdir, '_index.md'), idx);
  log(`  ${label}: ${topics.length} шардов + _index.md`);
  return { label, mdir, topics };
}

function loadRegistry() {
  // Назначения проектов из таблицы Projects Registry в ~/CLAUDE.md: name → «зачем» (лаконично).
  const map = {};
  const md = rd('~/CLAUDE.md');
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

function titlesOf(idxPath) {
  return (rd(idxPath).match(/^- \*\*(.+?)\*\*/gm) || []).map(x => x.replace(/^- \*\*|\*\*$/g, ''));
}

function purposeLines(blocks) {
  // Один вызов Claude: label → короткая инструкция «за чем сюда идти». Пути/структуру НЕ трогает.
  const prompt = `Ты составляешь главный путеводитель по памяти. Для каждого раздела дай ОДНУ короткую строку-инструкцию (по-русски): ЗА ЧЕМ сюда обращаться, что можно найти/вытащить — функционально, НЕ списком тем. Пример: для планировщика — "Актуальные и запланированные задачи по проектам, их статусы и что сейчас в работе". Приватные (private:true) — нейтрально, без раскрытия содержания.
Верни СТРОГО JSON: {"ЛЕЙБЛ": "инструкция", ...} для всех лейблов.
Данные:
${JSON.stringify(blocks, null, 1)}`;
  const raw = callClaude(prompt);
  return extractJSON(raw);
}

function loadRegistry() {
  const map = {};
  const md = rd('~/CLAUDE.md');
  const re = /\|\s*\*\*([a-z0-9-]+)\*\*\s*\|[^|]*\|\s*([^|]+?)\s*\|/gi;
  let m;
  while ((m = re.exec(md))) map[m[1]] = m[2].replace(/`/g, '').replace(/\*\*/g, '').trim();
  return map;
}
function titlesOf(idxPath) { return (rd(idxPath).match(/^- \*\*(.+?)\*\*/gm) || []).map(x => x.replace(/^- \*\*|\*\*$/g, '')); }
function purposeOverride(idxPath) { const m = rd(idxPath).match(/^purpose:\s*["\x27]?(.+?)["\x27]?\s*$/m); return m ? m[1].trim() : null; }

function buildGlobal() {
  const reg = loadRegistry();
  const targets = [];
  try { for (const p of fs.readdirSync(PROJECTS_DIR)) { const idx = path.join(PROJECTS_DIR, p, 'memory', '_index.md'); if (fs.existsSync(idx)) targets.push({ label: p, idx, priv: PRIVATE.has(p) }); } } catch {}
  const rootIdx = path.join(ROOT_MEM, '_index.md');
  const hasRoot = fs.existsSync(rootIdx);
  targets.sort((a, b) => a.label.localeCompare(b.label));

  // данные для LLM: назначение (реестр) + темы
  const blocks = targets.map(t => ({ label: t.label, private: t.priv, purpose_hint: reg[t.label] || '', topics: t.priv ? [] : titlesOf(t.idx).slice(0, 8) }));
  if (hasRoot) blocks.push({ label: 'общий-контур', private: false, purpose_hint: 'Всё вне конкретных проектов: инфраструктура сервера, инструменты Claude Code/VS Code, Telegram-боты, система памяти, скиллы, VPN, бэкапы, эксперименты', topics: titlesOf(rootIdx).slice(0, 8) });

  let purpose = {};
  try { purpose = purposeLines(blocks) || {}; } catch (e) { log('путеводитель: LLM недоступен (' + e.message + '), fallback на реестр'); }

  const L = ['---', 'type: memory-index', `updated: ${msk()}`, '---', '',
    '# 🧭 Память — главный путеводитель', '',
    'Карта всей памяти: куда идти по вопросу. Здесь только указатели — детали открываются по пути.', '',
    '## Слои памяти', '',
    '- **Правила про Сергея** — как обращаться, предпочтения, договорённости, рабочие приёмы.',
    '  → `~/.claude/projects/-root/memory/MEMORY.md`',
    '- **Знания из заметок (Obsidian)** — ТК, бизнес, личное, ресурсы; 44 тематические карты (MOC).',
    '  → `~/Obsidian/_wiki/index.md` _(релевантные карты также подставляются авто на каждый запрос)_',
    '- **История и задачи по проектам** — ниже, у каждого свой `_index.md`.', '',
    '## Проекты — за чем сюда идти', ''];
  const fallback = t => reg[t.label] ? (reg[t.label].split(/[.!?]\s/)[0] + '.') : ('Темы: ' + titlesOf(t.idx).slice(0, 4).join(' · ') || 'Проектная память.');
  for (const t of targets) {
    const line = purposeOverride(t.idx) || (purpose[t.label] || '').trim() || fallback(t);
    if (t.priv) L.push(`### ${t.label} 🔒`, (purpose[t.label] || 'Приватный контур, содержание скрыто.').trim(), `→ \`${t.idx}\``, '');
    else L.push(`### ${t.label}`, line, `→ \`${t.idx}\``, '');
  }
  if (hasRoot) L.push('## Общий контур (система / разное)', '', (purpose['общий-контур'] || 'Инфраструктура сервера, инструменты, Telegram-боты, память, скиллы, VPN, бэкапы, эксперименты.').trim(), `→ \`${rootIdx}\``, '');
  return L.join('\n') + '\n';
}
function main() {
  log(`старт (dry=${DRY}, project=${ONLY || '*'}, globalOnly=${GLOBAL_ONLY})`);
  if (GLOBAL_ONLY) { fs.writeFileSync(GLOBAL_INDEX, buildGlobal()); log('глобальная карта пересобрана с диска'); return; }
  const results = [];
  try {
    // проектные контуры
    let names = fs.readdirSync(PROJECTS_DIR).filter(n => fs.existsSync(path.join(PROJECTS_DIR, n, 'memory', 'activity', 'daily.md')) || fs.existsSync(path.join(PROJECTS_DIR, n, 'memory', 'topics')));
    if (ONLY) names = names.filter(n => n === ONLY);
    for (const n of names) results.push(processTarget(n, path.join(PROJECTS_DIR, n, 'memory'), 12, false));
    // общий контур (бездомные) — если не ограничен --project или явно указан 'root'
    if (!ONLY || ONLY === 'root' || ONLY === '_root') results.push(processTarget('root', ROOT_MEM, 18, true));
  } catch (e) {
    if (e instanceof LimitError) { log(`ЛИМИТ Claude (${e.message}) — выход 42`); process.exit(42); }
    log('фатально: ' + (e.stack || e)); process.exit(1);
  }
  if (!DRY) fs.writeFileSync(GLOBAL_INDEX, buildGlobal());
  log(`готово: ${results.filter(Boolean).length} контуров`);
}
main();
