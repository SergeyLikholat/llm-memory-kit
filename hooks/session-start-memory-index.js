#!/usr/bin/env node
// SessionStart hook: инжектит свежий глобальный путеводитель по памяти сессий
// (_memory-index.md) в начало каждой сессии. Заменяет recent-context от claude-mem.
// Fail-safe: ошибка/нет файла → exit 0, пустой контекст.
'use strict';
const fs = require('fs');
const INDEX = '~/.claude/projects/-root/memory/_memory-index.md';
const MAX = 16 * 1024;
let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch {}
function emit(ctx) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx || '' },
  }));
  process.exit(0);
}
try {
  if (!fs.existsSync(INDEX)) emit('');
  let body = fs.readFileSync(INDEX, 'utf8');
  if (body.length > MAX) body = body.slice(0, MAX) + '\n\n…(обрезано — полностью в ' + INDEX + ')';
  emit('# 🧠 Память сессий — свежий путеводитель\n\n' +
       'Авто-выжимка активности последних дней по проектам (обновляется ночью).\n' +
       'Детали проекта — в его `memory/_index.md`.\n\n---\n\n' + body);
} catch { emit(''); }
