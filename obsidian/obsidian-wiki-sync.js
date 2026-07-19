#!/usr/bin/env node
'use strict';
// Ночной sync: изменения в заметках Obsidian (raw) → обновление _wiki (MOC) через LLM.
// Детект через git. Заметки НЕ редактируются — меняется только _wiki. Авто-коммит (raw+wiki).
// Лимит подписки → git reset + exit 42 (wrapper повторит). Заметки без явного MOC → LLM размещает с ⚠️.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLAUDE = (process.env.MEMKIT_CLAUDE_BIN||(process.env.HOME||'/root')+'/.local/bin/claude');
const VAULT = (process.env.MEMKIT_OBSIDIAN_DIR||(process.env.HOME||'/root')+'/Obsidian');
const WIKI = path.join(VAULT, '_wiki');
const DRY = process.argv.includes('--dry-run');
const log = (...a) => console.log('[obsidian-sync ' + new Date().toISOString() + ']', ...a);
const git = (...args) => spawnSync('git', ['-C', VAULT, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });

// Маппинг «префикс папки волта → домен» задаётся пользователем через MEMKIT_OBSIDIAN_DOMAINS
// (JSON: {"Projects/":"projects", "Areas/":"areas", ...}), т.к. структура волта у каждого своя.
// Более длинный (специфичный) префикс имеет приоритет. Не задан → домен по первому сегменту пути.
const DOMAIN_MAP = (() => {
  try { return JSON.parse(process.env.MEMKIT_OBSIDIAN_DOMAINS || '{}'); } catch { return {}; }
})();
const DOMAIN_PREFIXES = Object.keys(DOMAIN_MAP).sort((a, b) => b.length - a.length);
function domainOf(rel) {
  for (const p of DOMAIN_PREFIXES) if (rel.startsWith(p)) return DOMAIN_MAP[p];
  const seg = rel.split('/')[0];                    // фолбэк: верхняя папка как домен
  return seg && seg !== rel ? seg.toLowerCase().replace(/\s+/g, '-') : null;
}
class LimitError extends Error {}
function callClaude(prompt) {
  const tmp = path.join('/tmp', 'obs-' + process.pid + '-' + Date.now() + '.txt');
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

function mocsOfDomain(dom) {
  const dir = path.join(WIKI, dom); const out = [];
  try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.md') && !f.startsWith('_audit')) out.push({ name: f, content: fs.readFileSync(path.join(dir, f), 'utf8') }); } catch {}
  return out;
}
function buildPrompt(dom, changes, mocs) {
  const changed = changes.filter(c => c.status !== 'D').map(c => `### ${c.rel}\n${(c.content || '').slice(0, 3000)}`).join('\n\n');
  const deleted = changes.filter(c => c.status === 'D').map(c => `- ${c.rel}`).join('\n');
  return `Ты обновляешь машинную вики (MOC-карты) домена "${dom}" под изменения в заметках Obsidian. Язык русский.
Правила:
- Новую заметку добавь ссылкой [[Имя без .md]] в наиболее подходящую MOC (или создай новую MOC этого домена), с короткой аннотацией и маркером ⚠️.
- Удалённые заметки — убери ссылки на них из карт.
- Изменённые — при необходимости актуализируй аннотацию/связи.
- Сохрани формат: frontmatter (type: moc, domain, updated), заголовок, группы "## ...", строки "- [[Имя]] — аннотация ⚠️".
Верни СТРОГО JSON, только изменённые/новые MOC: {"moc":[{"name":"Название MOC.md","content":"<полный markdown файла>"}]}

=== ТЕКУЩИЕ MOC ДОМЕНА ===
${mocs.map(m => `--- ${m.name} ---\n${m.content}`).join('\n\n') || '(в домене ещё нет MOC — создай)'}

=== ИЗМЕНЕНИЯ ЗАМЕТОК ===
Добавлены/изменены:
${changed || '(нет)'}

Удалены:
${deleted || '(нет)'}`;
}

function main() {
  if (!fs.existsSync(path.join(VAULT, '.git'))) { log('волт не под git — пропуск'); return; }
  git('add', '-A');
  const diff = git('diff', '--cached', '--name-status', 'HEAD').stdout || '';
  const changes = [];
  for (const line of diff.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0][0];
    const rel = status === 'R' ? parts[2] : parts[1];
    if (!rel || !rel.endsWith('.md')) continue;
    if (rel.startsWith('_wiki/') || rel.startsWith('.')) continue;   // только raw-заметки
    const dom = domainOf(rel);
    if (!dom) continue;
    let content = '';
    if (status !== 'D') { try { content = fs.readFileSync(path.join(VAULT, rel), 'utf8'); } catch {} }
    changes.push({ status, rel, dom, content });
  }
  if (!changes.length) { log('изменений в заметках нет'); git('reset', '-q'); return; }

  const byDom = {};
  for (const c of changes) (byDom[c.dom] ||= []).push(c);
  log(`изменения: ${changes.length} заметок в доменах ${Object.keys(byDom).join(', ')}`);
  if (DRY) { for (const [d, cs] of Object.entries(byDom)) log(`  [dry] ${d}: ${cs.map(c => c.status + ' ' + path.basename(c.rel)).join(', ')}`); git('reset', '-q'); return; }

  try {
    for (const [dom, cs] of Object.entries(byDom)) {
      const raw = callClaude(buildPrompt(dom, cs, mocsOfDomain(dom)));
      if (!raw) { log(`  ${dom}: пустой ответ, пропуск`); continue; }
      let parsed; try { parsed = extractJSON(raw); } catch { log(`  ${dom}: JSON fail, пропуск`); continue; }
      const dir = path.join(WIKI, dom); fs.mkdirSync(dir, { recursive: true });
      for (const m of (parsed.moc || [])) {
        if (!m.name || !m.content) continue;
        const safe = m.name.replace(/[\/\\]/g, '-').replace(/\.md$/, '') + '.md';
        fs.writeFileSync(path.join(dir, safe), String(m.content).trim() + '\n');
      }
      log(`  ${dom}: обновлено ${((parsed.moc || []).length)} MOC`);
    }
  } catch (e) {
    if (e instanceof LimitError) { log(`ЛИМИТ (${e.message}) — git reset, выход 42`); git('reset', '-q'); process.exit(42); }
    log('ошибка: ' + (e.stack || e)); git('reset', '-q'); process.exit(1);
  }

  git('add', '-A');
  const st = (git('status', '--porcelain').stdout || '').trim();
  if (!st) { log('нечего коммитить'); return; }
  const r = git('-c', 'user.name=claude', '-c', 'user.email=claude@local', 'commit', '-qm', `chore(obsidian): ночной raw→wiki sync (${changes.length} заметок)`);
  log('коммит: ' + (r.status === 0 ? 'OK' : 'rc=' + r.status));
}
main();
