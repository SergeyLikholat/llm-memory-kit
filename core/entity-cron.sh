#!/usr/bin/env bash
# Обёртка entity-builder (граф сущностей): sentinel + устойчивость к лимиту.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/../config.sh" 2>/dev/null || source "$DIR/../config.example.sh"
export PATH="$(dirname "$MEMKIT_CLAUDE_BIN"):$PATH"
STAMP="$DIR/.entity.lastrun"; LOCK="$DIR/.entity.lock"; LOG="$DIR/entity.log"
TODAY="$(TZ="$MEMKIT_TZ" date +%F)"; NOW="$(TZ="$MEMKIT_TZ" date '+%F %T')"
log(){ echo "[$NOW] $*" >> "$LOG"; }
exec 9>"$LOCK"; flock -n 9 || exit 0
[ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$TODAY" ] && exit 0
log "построение entity-хабов…"; node "$DIR/entity-builder.js" >> "$LOG" 2>&1; rc=$?
if [ $rc -eq 0 ]; then echo "$TODAY" > "$STAMP"; log "успех"
elif [ $rc -eq 42 ]; then log "лимит подписки — отложено"
else log "ошибка (rc=$rc)"; fi
exit 0
