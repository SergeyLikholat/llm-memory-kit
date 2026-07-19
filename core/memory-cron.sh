#!/usr/bin/env bash
# Ночная обёртка: classify → builder.
# Защита от сжигания лимита: sentinel (успех = раз в сутки), максимум 3 попыток/сутки,
# ошибка кода (rc=1) → ретраи прекращаются до фикса. Лимит подписки (rc=42) → попытка в след. окно.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/../config.sh" 2>/dev/null || source "$DIR/../config.example.sh"
export PATH="$(dirname "$MEMKIT_CLAUDE_BIN"):$PATH"
STAMP="$DIR/.memory.lastrun"; LOCK="$DIR/.memory.lock"; LOG="$DIR/memory-cron.log"; ATT="$DIR/.memory.attempts"
TODAY="$(TZ="$MEMKIT_TZ" date +%F)"; NOW="$(TZ="$MEMKIT_TZ" date '+%F %T')"
log(){ echo "[$NOW] $*" >> "$LOG"; }

exec 9>"$LOCK"; flock -n 9 || { log "уже выполняется — пропуск"; exit 0; }
[ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$TODAY" ] && exit 0   # успех сегодня → всё

# ── гард попыток ──
ad=""; ac=0; ar=0
[ -f "$ATT" ] && read -r ad ac ar < "$ATT" 2>/dev/null
[ "$ad" != "$TODAY" ] && { ac=0; ar=0; }
if [ "${ac:-0}" -ge 3 ]; then log "исчерпан лимит попыток (3/сутки) — до завтра"; exit 0; fi
if [ "${ar:-0}" = "1" ]; then log "прошлая попытка упала с ошибкой кода — ретрай отключён (нужен фикс)"; exit 0; fi
ac=$((ac+1)); echo "$TODAY $ac 0" > "$ATT"
log "попытка $ac/3"

log "классификация бездомных…"; node "$DIR/classify.js" >> "$LOG" 2>&1 || log "classify пропущен"
log "построение шардов…"; node "$DIR/builder.js" >> "$LOG" 2>&1; rc=$?

if [ $rc -eq 0 ]; then echo "$TODAY" > "$STAMP"; rm -f "$ATT"; log "успех"
elif [ $rc -eq 42 ]; then echo "$TODAY $ac 42" > "$ATT"; log "лимит подписки — попробую в следующее окно"
else echo "$TODAY $ac 1" > "$ATT"; log "ошибка кода (rc=$rc) — ретраи остановлены до фикса"; fi
exit 0
