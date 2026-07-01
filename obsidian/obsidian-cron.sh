#!/usr/bin/env bash
# Ночная обёртка Obsidian→wiki sync, sentinel + устойчивость к лимиту.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/../config.sh" 2>/dev/null || source "$DIR/../config.example.sh"
export PATH="$(dirname "$MEMKIT_CLAUDE_BIN"):$PATH"
STAMP="$DIR/.obsidian.lastrun"; LOCK="$DIR/.obsidian.lock"; LOG="$DIR/obsidian-cron.log"
TODAY="$(TZ="$MEMKIT_TZ" date +%F)"; NOW="$(TZ="$MEMKIT_TZ" date '+%F %T')"
log(){ echo "[$NOW] $*" >> "$LOG"; }
[ -z "${MEMKIT_OBSIDIAN_DIR:-}" ] && { log "OBSIDIAN_DIR не задан — модуль выключен"; exit 0; }
exec 9>"$LOCK"; flock -n 9 || exit 0
[ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$TODAY" ] && exit 0
log "obsidian raw→wiki sync…"; node "$DIR/obsidian-wiki-sync.js" >> "$LOG" 2>&1; rc=$?
if [ $rc -eq 0 ]; then echo "$TODAY" > "$STAMP"; log "успех"
elif [ $rc -eq 42 ]; then log "лимит — отложено"
else log "ошибка (rc=$rc)"; fi
exit 0
