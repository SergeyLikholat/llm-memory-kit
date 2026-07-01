#!/usr/bin/env bash
# Ночная обёртка: classify → builder, sentinel «сделано сегодня», устойчивость к лимиту подписки.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/../config.sh" 2>/dev/null || source "$DIR/../config.example.sh"
export PATH="$(dirname "$MEMKIT_CLAUDE_BIN"):$PATH"
STAMP="$DIR/.memory.lastrun"; LOCK="$DIR/.memory.lock"; LOG="$DIR/memory-cron.log"
TODAY="$(TZ="$MEMKIT_TZ" date +%F)"; NOW="$(TZ="$MEMKIT_TZ" date '+%F %T')"
log(){ echo "[$NOW] $*" >> "$LOG"; }
exec 9>"$LOCK"; flock -n 9 || { log "уже выполняется"; exit 0; }
[ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$TODAY" ] && exit 0
log "классификация бездомных…"; node "$DIR/classify.js" >> "$LOG" 2>&1 || log "classify пропущен"
log "построение шардов…"; node "$DIR/builder.js" >> "$LOG" 2>&1; rc=$?
if [ $rc -eq 0 ]; then echo "$TODAY" > "$STAMP"; log "успех"
elif [ $rc -eq 42 ]; then log "лимит подписки — отложено, ретрай позже"
else log "ошибка (rc=$rc)"; fi
exit 0
