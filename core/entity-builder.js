#!/usr/bin/env node
'use strict';
// Entity-хабы: горизонтальный слой связей по сущностям (люди/объекты/организации/инструменты)
// поверх памяти сессий И Obsidian. Единый слой: хаб ссылается в обе базы.
// Место: _wiki/entities/ (если есть Obsidian) иначе -root/memory/entities/. Лимит → exit 42.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const H = process.env.HOME || '/root';
const CLAUDE = process.env.MEMKIT_CLAUDE_BIN || (H + '/.local/bin/claude');
const PROJECTS_DIR = process.env.MEMKIT_PROJECTS_DIR || (H + '/projects');
const ROOT_MEM = process.env.MEMKIT_ROOT_MEM || (H + '/.claude/projects/-root/memory');
const OBSIDIAN_DIR = process.env.MEMKIT_OBSIDIAN_DIR || (H + '/Obsidian');
const WIKI = path.join(OBSIDIAN_DIR, '_wiki');
const HAS_OBS = fs.existsSync(WIKI);
const ENTITIES = HAS_OBS ? path.join(WIKI, 'entities') : path.join(ROOT_MEM, 'entities');
const MIN_LINKS = 2, MAX_ENTITIES = 60;
const DRY = process.argv.includes('--dry-run');
const msk = () => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.MEMKIT_TZ || 'Europe/Moscow' }).format(new Date());
const log = (...a) => console.log('[entity ' + new Date().toISOString() + ']', ...a);
const rd = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const slugify = s => String(s || 'e').toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'e';
class LimitError extends Error {}

function callClaude(prompt) {
  const tmp = path.join('/tmp', 'ent-' + process.pid + '-' + Date.now() + '.txt');
  fs.writeFileSync(tmp, prompt);
  try {
    const MODEL = process.env.MEMKIT_MODEL || 'sonnet';
    const r = spawnSync('bash', ['-c', `cat ${JSON.stringify(tmp)} | ${CLAUDE} -p --model ${MODEL} --output-format json --no-session-persistence`], { encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024, cwd: '/tmp' });
    let o = null; try { o = JSON.parse(r.stdout || ''); } catch {}
    const aes = o ? String(o.api_error_status || '') : '', sub = o ? String(o.subtype || '') : '';
    if (/limit|rate|429|overload/i.test(aes) || /limit|rate/i.test(sub) || /usage limit/i.test(r.stdout || '')) throw new LimitError(aes || sub);
    if (o && o.is_error !== true && o.subtype === 'success' && o.result) return String(o.result);
    return null;
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
function extractJSON(t) { t = String(t).trim(); const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) t = f[1].trim(); const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a >= 0 && b > a) t = t.slice(a, b + 1); return JSON.parse(t); }

// узлы: шарды памяти + MOC Obsidian. hint компактный (заголовок+теги+первые строки).
function collectNodes() {
  const nodes = [];
  const addShard = (kind, ref, file) => {
    const body = rd(file);
    const title = (body.match(/^#\s+(.+)$/m) || [, path.basename(file, '.md')])[1];
    const tags = (body.match(/^tags:\s*\[(.*?)\]/m) || [, ''])[1];
    const hint = body.replace(/^---[\s\S]*?---/, '').replace(/\s+/g, ' ').slice(0, 600);
    nodes.push({ id: nodes.length, kind, ref, title: String(title).trim(), tags: tags.trim(), hint });
  };
  // память: шарды проектов + общий контур
  const scanTopics = (base, label) => { const d = path.join(base, 'topics'); try { for (const f of fs.readdirSync(d)) if (f.endsWith('.md')) addShard('memory', `${label} → \`${path.join(d, f)}\``, path.join(d, f)); } catch {} };
  try { for (const p of fs.readdirSync(PROJECTS_DIR)) scanTopics(path.join(PROJECTS_DIR, p, 'memory'), p); } catch {}
  scanTopics(ROOT_MEM, 'общее');
  // Obsidian: MOC-карты
  if (HAS_OBS) {
    const walk = d => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const full = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'entities') walk(full); continue; } if (!e.name.endsWith('.md') || e.name.startsWith('_')) continue; addShard('obsidian', `\`${full}\``, full); } };
    walk(WIKI);
  }
  return nodes;
}

function buildPrompt(nodes) {
  const list = nodes.map(n => `#${n.id} [${n.kind}] ${n.title}${n.tags ? ' {' + n.tags + '}' : ''} :: ${n.hint.slice(0, 220)}`).join('\n');
  let projNames = [];
  try { projNames = fs.readdirSync(PROJECTS_DIR).filter(p => fs.existsSync(path.join(PROJECTS_DIR, p, 'memory'))); } catch {}
  return `Ты строишь ГРАФ ИМЕНОВАННЫХ СУЩНОСТЕЙ поверх памяти — чтобы горизонтально связать узлы, где встречается одна и та же сущность. Язык русский.

ЧТО ВЫДЕЛЯТЬ (приоритет сверху вниз):
1. ЛЮДИ — конкретные имена/фамилии: заказчики, коллеги, подрядчики, клиенты, врачи.
2. ОБЪЕКТЫ — конкретные именованные объекты/площадки/продукты, вокруг которых идёт работа.
3. ОРГАНИЗАЦИИ — компании-контрагенты, заказчики, поставщики.
4. ИНСТРУМЕНТЫ — ТОЛЬКО ключевые доменные платформы, которые реально связывают несколько узлов (напр. «Plane», «n8n»).

ЧЕГО НЕ ВЫДЕЛЯТЬ (важно, иначе каша):
- Имена проектов памяти — это контейнеры, НЕ сущности: ${projNames.join(', ')}, общее.
- Общие инструменты разработки и инфраструктура: Docker, VSCode, Git, GitHub, npm, bash, cron, claude-mem, restic, Telegram (как транспорт), сам Claude Code.
- Абстрактные темы/концепции (они покрыты тегами) — только именованные кто/что/где.

ПРАВИЛА:
- Сущность включай ТОЛЬКО если встречается в ${MIN_LINKS}+ РАЗНЫХ узлах.
- Имя — как в жизни (человека — по имени/фамилии, объект — как называют).
- Максимум ${MAX_ENTITIES}, самые связующие. Лучше меньше, но точных, чем много мусорных.

Верни СТРОГО JSON: {"entities":[{"name":"Имя","type":"человек|объект|организация|инструмент","slug":"latin-kebab","nodes":[id,id,...]}]}

УЗЛЫ (id [тип] заголовок {теги} :: подсказка):
${list}`;
}
function main() {
  log(`старт (dry=${DRY}, база=${HAS_OBS ? 'Obsidian+память' : 'память'})`);
  const nodes = collectNodes();
  log(`узлов: ${nodes.length}`);
  if (nodes.length < 3) { log('мало узлов'); return; }
  let parsed;
  try { const raw = callClaude(buildPrompt(nodes)); parsed = extractJSON(raw); }
  catch (e) { if (e instanceof LimitError) { log(`ЛИМИТ (${e.message}) — выход 42`); process.exit(42); } log('ошибка: ' + (e.stack || e)); process.exit(1); }
  const ents = (parsed.entities || []).filter(e => Array.isArray(e.nodes) && e.nodes.length >= MIN_LINKS);
  log(`сущностей-хабов: ${ents.length}`);
  if (DRY) { for (const e of ents) log(`  [dry] ${e.type}: ${e.name} (${e.nodes.length} связей)`); return; }
  fs.mkdirSync(ENTITIES, { recursive: true });
  // очистить старые (производный слой) — но бережно: только *.md в entities
  try { for (const f of fs.readdirSync(ENTITIES)) if (f.endsWith('.md')) fs.unlinkSync(path.join(ENTITIES, f)); } catch {}
  for (const e of ents) {
    const byKind = { memory: [], obsidian: [] };
    for (const id of e.nodes) { const n = nodes[id]; if (n) byKind[n.kind].push(n.ref); }
    const L = [`---`, `type: entity`, `entity_type: ${e.type}`, `updated: ${msk()}`, `---`, ``, `# ${e.name} — ${e.type}`, ``, `Сущность-хаб: связывает данные из разных мест.`, ``];
    if (byKind.memory.length) { L.push(`## В памяти сессий`); byKind.memory.forEach(r => L.push(`- ${r}`)); L.push(``); }
    if (byKind.obsidian.length) { L.push(`## В Obsidian`); byKind.obsidian.forEach(r => L.push(`- ${r}`)); L.push(``); }
    fs.writeFileSync(path.join(ENTITIES, slugify(e.slug || e.name) + '.md'), L.join('\n'));
  }
  // индекс сущностей
  const idx = [`---`, `type: entity-index`, `updated: ${msk()}`, `---`, ``, `# Сущности (граф связей)`, ``,
    ...ents.map(e => `- **${e.name}** _(${e.type})_ — ${e.nodes.length} связей → \`${path.join(ENTITIES, slugify(e.slug || e.name) + '.md')}\``)].join('\n') + '\n';
  fs.writeFileSync(path.join(ENTITIES, '_index.md'), idx);
  log(`готово: ${ents.length} хабов в ${ENTITIES}`);
}
main();
