#!/usr/bin/env node
'use strict';
// Daily per-project digest v2.
// Reads Claude Code's native session transcripts ($MEMKIT_CLAUDE_DIR/projects/*/*.jsonl),
// groups sessions by project, and writes a rolling activity buffer into each
// $MEMKIT_PROJECTS_DIR/<name>/memory/activity/daily.md, plus a shared buffer at
// $MEMKIT_ROOT_MEM/activity/daily.md for sessions that don't belong to a project.
//
// Why v2: the old digest read pre-summarised session-data/*.tmp files and lost
// ~93% of the content (truncated to ~10 turns, same-day sessions overwrote each
// other, answers were dropped). This version parses the raw transcripts directly,
// deduplicates by sessionId, and scans incrementally by file mtime.
//
// All paths are parametrised via MEMKIT_* environment variables (see config.example.sh).
//
// Usage:
//   node digest.js               # real run (incremental, since last mtime)
//   node digest.js --dry-run     # show what would be written, change nothing
//   node digest.js --all         # one-off: reprocess the whole history

const fs = require('node:fs');
const path = require('node:path');

const H = process.env.HOME || '/root';
const CLAUDE_DIR = process.env.MEMKIT_CLAUDE_DIR || (H + '/.claude');
const PROJECTS_DIR = process.env.MEMKIT_PROJECTS_DIR || (H + '/projects');
const ROOT_MEM = process.env.MEMKIT_ROOT_MEM || (CLAUDE_DIR + '/projects/-root/memory');
const SRC = path.join(CLAUDE_DIR, 'projects');                       // native transcripts live here
const ROUTING = process.env.MEMKIT_TG_ROUTING || (CLAUDE_DIR + '/channels/telegram/routing.json');
const STATE = path.join(CLAUDE_DIR, 'scripts', 'cron', '.digest-jsonl.state.json');
const TZ = process.env.MEMKIT_TZ || 'Europe/Moscow';
const WINDOW_DAYS = 14, MAX_Q = 20, MAX_A = 8, Q_LEN = 260, A_LEN = 420;
const MIN_CHARS = 400, MIN_Q = 2, MAX_BLOCKS = 90;   // noise filter + buffer cap

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ALL = args.includes('--all');           // one-off full-history pass
const log = (...a) => console.log('[digest2 ' + new Date().toISOString() + ']', ...a);
const dstr = iso => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso)); } catch { return null; } };
const tstr = iso => { try { return new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); } catch { return '?'; } };

function loadState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } }
function saveState(s) { try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s)); } catch {} }
function loadRouting() { try { const d = JSON.parse(fs.readFileSync(ROUTING, 'utf8')); const m = {}; for (const [t, v] of Object.entries(d.topics || {})) { const dir = (v.project_dir || '').replace(/\/+$/, ''); if (dir) m[t] = path.basename(dir); } return m; } catch { return {}; } }
const TOPIC_MAP = loadRouting();

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n');
  return '';
}
function cleanPrompt(t) {
  const thread = (String(t).match(/message_thread_id="(\d+)"/) || [])[1];
  let s = String(t).replace(/<channel[^>]*>/g, '').replace(/<\/channel>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ide_[^>]*>[\s\S]*?<\/ide_[^>]*>/g, '')
    .replace(/<persisted-output>[\s\S]*?<\/persisted-output>/g, '')
    .replace(/\s+/g, ' ').trim();
  return { text: s, thread };
}
function projectFromCwd(cwd) {
  if (!cwd) return null;
  const m = String(cwd).match(new RegExp('^' + PROJECTS_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/([^/]+)'));
  return m ? m[1] : null;
}

function parseSession(file) {
  let q = [], a = [], files = new Set(), cwd = null, sid = null, first = null, last = null, threads = {};
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.sessionId && !sid) sid = d.sessionId;
    if (d.cwd && !cwd) cwd = d.cwd;
    if (d.timestamp) { if (!first) first = d.timestamp; last = d.timestamp; }
    if (d.type === 'user') {
      const raw = textOf(d.message && d.message.content);
      if (!raw) continue;
      const { text, thread } = cleanPrompt(raw);
      if (thread) threads[thread] = (threads[thread] || 0) + 1;
      if (text && !/^\s*$/.test(text) && !text.startsWith('Caveat:')) q.push(text.slice(0, Q_LEN));
    } else if (d.type === 'assistant') {
      const c = d.message && d.message.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'text' && (b.text || '').length > 120) a.push(b.text.replace(/\s+/g, ' ').slice(0, A_LEN));
          if (b.type === 'tool_use' && /Write|Edit/i.test(b.name || '')) { const p = b.input && (b.input.file_path || b.input.path); if (p) files.add(p); }
        }
      }
    }
  }
  let thread = null, best = 0;
  for (const [t, n] of Object.entries(threads)) if (n > best) { best = n; thread = t; }
  return { sid, cwd, first, last, q, a, files: [...files], thread };
}

function blockOf(s, project) {
  const date = dstr(s.last) || dstr(s.first);
  const L = [`## ${date} — ${project} (${tstr(s.first)}–${tstr(s.last)}) [session ${String(s.sid || '').slice(0, 8)}]`];
  if (s.q.length) { L.push('**Вопросы/задачи:**'); s.q.slice(-MAX_Q).forEach(x => L.push('- ' + x)); }
  if (s.a.length) { L.push('**Ключевое из ответов:**'); s.a.slice(0, MAX_A).forEach(x => L.push('- ' + x)); }
  if (s.files.length) { L.push(`**Файлы (${s.files.length}):**`); s.files.slice(0, 10).forEach(f => L.push('- ' + f)); }
  L.push('');
  return L.join('\n');
}
function splitBlocks(md) { return md.split(/(?=^## \d{4}-\d{2}-\d{2})/m).filter(b => /^## \d{4}-\d{2}-\d{2}/.test(b)); }
function sidOf(b) { const m = b.match(/\[session ([0-9a-f]+)\]/); return m ? m[1] : null; }

function writeTo(target, blocks, label) {
  const dir = path.dirname(target); fs.mkdirSync(dir, { recursive: true });
  const hdr = `# Recent activity — ${label}, последние ${WINDOW_DAYS} дней (auto, из транскриптов)\n\n`;
  let ex = ''; try { ex = fs.readFileSync(target, 'utf8'); } catch {}
  if (!ex.startsWith('#')) ex = hdr + ex;
  const he = ex.indexOf('\n\n') + 2;
  const old = splitBlocks(ex.slice(he));
  const newSids = new Set(blocks.map(sidOf).filter(Boolean));
  const kept = old.filter(b => { const s = sidOf(b); return !s || !newSids.has(s); });   // drop the stale version of a session
  const all = [...blocks, ...kept];
  // date window
  const today = new Date();
  const fresh = all.filter(b => { const m = b.match(/^## (\d{4}-\d{2}-\d{2})/); if (!m) return true; return (today - new Date(m[1])) / 86400000 <= WINDOW_DAYS; });
  const capped = fresh.slice(0, MAX_BLOCKS);
  fs.writeFileSync(target, ex.slice(0, he) + capped.join('\n'));
  return capped.length;
}

function main() {
  log(`старт (dry=${DRY}, all=${ALL})`);
  const state = loadState();
  const byTarget = {};   // target file → blocks
  let scanned = 0, taken = 0;
  let dirs = []; try { dirs = fs.readdirSync(SRC); } catch { log('нет ' + SRC); return; }
  for (const d of dirs) {
    const dp = path.join(SRC, d);
    let files = []; try { files = fs.readdirSync(dp).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const full = path.join(dp, f); scanned++;
      let st; try { st = fs.statSync(full); } catch { continue; }
      const key = full, mt = st.mtimeMs;
      if (!ALL && state[key] === mt) continue;                       // unchanged — skip
      let s; try { s = parseSession(full); } catch { continue; }
      const bulk = s.q.join(' ').length + s.a.join(' ').length;
      if (s.q.length < MIN_Q || bulk < MIN_CHARS) { state[key] = mt; continue; }   // service/empty session
      const ageDays = (Date.now() - new Date(s.last || 0)) / 86400000;
      if (!ALL && ageDays > WINDOW_DAYS) { state[key] = mt; continue; }
      if (s.cwd && !String(s.cwd).startsWith(PROJECTS_DIR) && String(s.cwd) !== H && !String(s.cwd).startsWith('/tmp')) { state[key] = mt; continue; } // foreign tree — not my memory
      // project: telegram topic → cwd → shared buffer
      let project = (s.thread && TOPIC_MAP[s.thread] && TOPIC_MAP[s.thread] !== 'root') ? TOPIC_MAP[s.thread] : projectFromCwd(s.cwd);
      let target, label;
      if (project && fs.existsSync(path.join(PROJECTS_DIR, project))) { target = path.join(PROJECTS_DIR, project, 'memory', 'activity', 'daily.md'); label = project; }
      else { target = path.join(ROOT_MEM, 'activity', 'daily.md'); label = 'общий контур'; project = project || 'root'; }
      (byTarget[target] ||= { blocks: [], label }).blocks.push(blockOf(s, project));
      state[key] = mt; taken++;
    }
  }
  log(`просканировано ${scanned} транскриптов, свежих/новых сессий: ${taken}`);
  if (DRY) { for (const [t, v] of Object.entries(byTarget)) log(`  [dry] ${v.label}: +${v.blocks.length} → ${t}`); return; }
  for (const [t, v] of Object.entries(byTarget)) { const n = writeTo(t, v.blocks, v.label); log(`  ${v.label}: +${v.blocks.length} блоков (всего ${n}) → ${t}`); }
  saveState(state);
  log('готово');
}
main();
