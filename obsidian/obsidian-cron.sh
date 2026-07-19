#!/usr/bin/env bash
# Ночная обёртка Obsidian→wiki sync, sentinel + устойчивость к лимиту.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/../config.sh" 2>/dev/null || source "$DIR/../config.example.sh"
export PATH="$(dirname "$MEMKIT_CLAUDE_BIN"):$PATH"
STAMP="$DIR/.obsidian.lastrun"; LOCK="$DIR/.obsidian.lock"; LOG="$DIR/obsidian-cron.log"; ATT="$DIR/.obsidian.attempts"
TODAY="$(TZ="$MEMKIT_TZ" date +%F)"; NOW="$(TZ="$MEMKIT_TZ" date '+%F %T')"
log(){ echo "[$NOW] $*" >> "$LOG"; }
[ -z "${MEMKIT_OBSIDIAN_DIR:-}" ] && { log "OBSIDIAN_DIR не задан — модуль выключен"; exit 0; }
exec 9>"$LOCK"; flock -n 9 || exit 0
[ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$TODAY" ] && exit 0
# гард попыток: максимум 3/сутки, ошибка кода (rc=1) → ретраи стоп до фикса
ad=""; ac=0; ar=0
[ -f "$ATT" ] && read -r ad ac ar < "$ATT" 2>/dev/null
[ "$ad" != "$TODAY" ] && { ac=0; ar=0; }
if [ "${ac:-0}" -ge 3 ]; then log "исчерпан лимит попыток (3/сутки) — до завтра"; exit 0; fi
if [ "${ar:-0}" = "1" ]; then log "прошлая попытка упала с ошибкой кода — ретрай отключён"; exit 0; fi
ac=$((ac+1)); echo "$TODAY $ac 0" > "$ATT"
log "obsidian raw→wiki sync… (попытка $ac/3)"; node "$DIR/obsidian-wiki-sync.js" >> "$LOG" 2>&1; rc=$?
if [ $rc -eq 0 ]; then echo "$TODAY" > "$STAMP"; rm -f "$ATT"; log "успех"
elif [ $rc -eq 42 ]; then echo "$TODAY $ac 42" > "$ATT"; log "лимит подписки — попробую в следующее окно"
else echo "$TODAY $ac 1" > "$ATT"; log "ошибка кода (rc=$rc) — ретраи остановлены до фикса"; fi
exit 0
