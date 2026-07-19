#!/usr/bin/env node
'use strict';
// Классификатор бездомных сессий: раскидывает общий буфер по проектам через LLM + каталог purpose.
// Порог уверенности: <0.7 → остаётся в общем. Ручной override: "сохрани в проект X" в тексте.
// Лимит подписки → не трогает буферы, выходит (классификация повторится). Запускается 02:40, до билдера.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLAUDE = (process.env.MEMKIT_CLAUDE_BIN||(process.env.HOME||'/root')+'/.local/bin/claude');
const PROJECTS_DIR = (process.env.MEMKIT_PROJECTS_DIR||(process.env.HOME||'/root')+'/projects');
const HOMELESS = (process.env.MEMKIT_ROOT_MEM||(process.env.HOME||'/root')+'/.claude/projects/-root/memory')+'/activity/daily.md';
const WINDOW = 30, MIN_CONF = 0.7;
const DRY = process.argv.includes('--dry-run');
const msk = () => new Intl.DateTimeFormat('en-CA', { timeZone: (process.env.MEMKIT_TZ||'Europe/Moscow') }).format(new Date());
const log = (...a) => console.log('[classify ' + new Date().toISOString() + ']', ...a);
const rd = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

function catalog() {
  const cat = {};
  try { for (const p of fs.readdirSync(PROJECTS_DIR)) {
    const idx = path.join(PROJECTS_DIR, p, 'memory', '_index.md'); if (!fs.existsSync(idx)) continue;
    const m = rd(idx).match(/^purpose:\s*["']?(.+?)["']?\s*$/m);
    cat[p] = m ? m[1].trim() : p;
  } } catch {}
  return cat;
}
function callClaude(prompt) {
  const tmp = path.join('/tmp', 'cls-' + process.pid + '-' + Date.now() + '.txt');
  fs.writeFileSync(tmp, prompt);
  try {
    const r = spawnSync('bash', ['-c', `cat ${JSON.stringify(tmp)} | ${CLAUDE} -p --output-format json --no-session-persistence`], { encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024, cwd: '/tmp' });
    let o = null; try { o = JSON.parse(r.stdout || ''); } catch {}
    const aes = o ? String(o.api_error_status || '') : '', sub = o ? String(o.subtype || '') : '';
    if (/limit|rate|429|overload/i.test(aes) || /limit|rate/i.test(sub) || /usage limit/i.test(r.stdout || '')) throw new Error('LIMIT');
    if (o && o.is_error !== true && o.subtype === 'success' && o.result) return String(o.result);
    return null;
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
function extractJSON(t) { t = String(t).trim(); const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) t = f[1].trim(); const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a >= 0 && b > a) t = t.slice(a, b + 1); return JSON.parse(t); }
function splitBlocks(md) { return md.split(/(?=^## \d{4}-\d{2}-\d{2})/m).filter(b => /^## \d{4}-\d{2}-\d{2}/.test(b)); }
function header(b) { const m = b.match(/^(## [^\n]+)/); return m ? m[1].trim() : ''; }
function overrideOf(text) { const m = text.match(/сохран[а-я]*\s+(?:в\s+)?(?:проект\s+)?["'`]?([a-z0-9-]{3,})["'`]?/i); return m ? m[1].toLowerCase() : null; }

function appendToProject(proj, blocks) {
  const dir = path.join(PROJECTS_DIR, proj, 'memory', 'activity'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'daily.md');
  const hdr = `# Recent activity — последние ${WINDOW} дней (auto)\n\n`;
  let ex = fs.existsSync(file) ? rd(file) : hdr; if (!ex.startsWith('#')) ex = hdr + ex;
  const seen = new Set(splitBlocks(ex).map(header));
  const fresh = blocks.filter(b => !seen.has(header(b)));
  if (!fresh.length) return 0;
  const he = ex.indexOf('\n\n') + 2;
  fs.writeFileSync(file, ex.slice(0, he) + fresh.join('\n') + '\n' + ex.slice(he));
  return fresh.length;
}

function main() {
  const md = rd(HOMELESS); const blocks = splitBlocks(md);
  if (!blocks.length) { log('общий буфер пуст'); return; }
  const cat = catalog();
  const items = blocks.map((b, i) => ({ id: i, header: header(b), text: b.slice(0, 1200) }));
  const prompt = `Классифицируй записи активности по проектам. Для каждой записи реши, к какому проекту она относится, опираясь на КАТАЛОГ назначений. Если ни к одному явно — верни "общее". Не угадывай: сомневаешься → "общее" с низкой confidence.

КАТАЛОГ ПРОЕКТОВ (что куда относится):
${Object.entries(cat).map(([k, v]) => `- ${k}: ${v}`).join('\n')}
- общее: инфраструктура сервера, инструменты Claude Code/VS Code, система памяти, эксперименты, всё вне конкретных проектов

Верни СТРОГО JSON: {"assign":[{"id":0,"project":"<имя|общее>","confidence":0.0-1.0}]}

ЗАПИСИ:
${JSON.stringify(items, null, 1).slice(0, 50000)}`;

  const BATCH = 10;
  const assign = {};
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const p = prompt.replace(/ЗАПИСИ:\n[\s\S]*$/, 'ЗАПИСИ:\n' + JSON.stringify(chunk, null, 1).slice(0, 40000));
    let parsed;
    try { const raw = callClaude(p); parsed = extractJSON(raw); }
    catch (e) {
      if (String(e.message) === 'LIMIT') { log('лимит подписки — буферы не трогаю, повтор позже'); return; }
      log(`батч ${i / BATCH + 1}: ошибка (${e.message}) — пропуск батча`); continue;
    }
    for (const a of (parsed.assign || [])) assign[a.id] = a;
    log(`  батч ${i / BATCH + 1}/${Math.ceil(items.length / BATCH)}: ${(parsed.assign || []).length} решений`);
  }

  const byProj = {}; const keep = [];
  blocks.forEach((b, i) => {
    const ov = overrideOf(b);
    let proj = ov && fs.existsSync(path.join(PROJECTS_DIR, ov)) ? ov : null;
    if (!proj) { const a = assign[i]; if (a && a.project && a.project !== 'общее' && (a.confidence ?? 0) >= MIN_CONF && fs.existsSync(path.join(PROJECTS_DIR, a.project))) proj = a.project; }
    if (proj) (byProj[proj] ||= []).push(b); else keep.push(b);
  });

  const moved = Object.entries(byProj).map(([p, bs]) => `${p}:${bs.length}`);
  if (DRY) { log(`[dry] разложил бы: ${moved.join(', ') || 'ничего'}; в общем остаётся ${keep.length}`); return; }
  let total = 0;
  for (const [p, bs] of Object.entries(byProj)) { const n = appendToProject(p, bs); total += n; log(`→ ${p}: +${n} блоков`); }
  // переписать общий буфер только оставшимся
  const hdr = `# Recent activity — бездомные сессии (вне ~/projects), последние ${WINDOW} дней (auto)\n\n`;
  fs.writeFileSync(HOMELESS, hdr + keep.join('\n') + (keep.length ? '\n' : ''));
  log(`готово: разложено ${total} блоков по проектам, в общем осталось ${keep.length}`);
}
main();
