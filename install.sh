#!/usr/bin/env bash
# llm-memory-kit — установщик. Спрашивает пути, выбирает модули, ставит cron.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "════════════════════════════════════════════"
echo "  llm-memory-kit — установка памяти для Claude Code"
echo "════════════════════════════════════════════"
echo
ask(){ local p="$1" d="$2" a; read -r -p "$p [$d]: " a; echo "${a:-$d}"; }

# 1) пути
CLAUDE_DIR=$(ask "Папка Claude Code (.claude)" "$HOME/.claude")
PROJECTS_DIR=$(ask "Папка проектов" "$HOME/projects")
CLAUDE_BIN=$(ask "Бинарь claude" "$(command -v claude || echo "$HOME/.local/bin/claude")")
TZ_=$(ask "Часовой пояс" "Europe/Moscow")

# 2) модули
echo; echo "Модули:"
read -r -p "  Подключить Obsidian-sync (заметки→wiki)? [y/N]: " OBS
OBSIDIAN_DIR=""
if [[ "${OBS,,}" == y* ]]; then OBSIDIAN_DIR=$(ask "  Папка Obsidian-волта" "$HOME/Obsidian"); fi

# 3) config.sh
cat > config.sh <<CFG
#!/usr/bin/env bash
export MEMKIT_CLAUDE_DIR="$CLAUDE_DIR"
export MEMKIT_PROJECTS_DIR="$PROJECTS_DIR"
export MEMKIT_ROOT_MEM="$CLAUDE_DIR/projects/-root/memory"
export MEMKIT_OBSIDIAN_DIR="$OBSIDIAN_DIR"
export MEMKIT_CLAUDE_BIN="$CLAUDE_BIN"
export MEMKIT_TZ="$TZ_"
export MEMKIT_TG_ROUTING="$CLAUDE_DIR/channels/telegram/routing.json"
CFG
echo "✓ config.sh создан"

chmod +x core/*.sh obsidian/*.sh helpers/*.sh core/*.js hooks/*.js obsidian/*.js 2>/dev/null || true
mkdir -p "$CLAUDE_DIR/projects/-root/memory/activity" "$PROJECTS_DIR"

# 4) cron
CRON_CORE="30 2 * * * /usr/bin/node $DIR/core/digest.js >> $DIR/core/digest.log 2>&1
45 2 * * * $DIR/core/memory-cron.sh
*/30 3-23 * * * $DIR/core/memory-cron.sh
55 2 * * * $DIR/core/entity-cron.sh
*/30 3-23 * * * $DIR/core/entity-cron.sh"
CRON_OBS=""
[ -n "$OBSIDIAN_DIR" ] && CRON_OBS="50 2 * * * $DIR/obsidian/obsidian-cron.sh
*/30 3-23 * * * $DIR/obsidian/obsidian-cron.sh"

echo; echo "Строки cron (расписание по $TZ_):"
echo "$CRON_CORE"; [ -n "$CRON_OBS" ] && echo "$CRON_OBS"
read -r -p "Добавить в crontab автоматически? [y/N]: " C
if [[ "${C,,}" == y* ]]; then
  ( crontab -l 2>/dev/null | grep -v 'llm-memory-kit\|memory-cron\|obsidian-cron\|core/digest.js'; echo "$CRON_CORE"; [ -n "$CRON_OBS" ] && echo "$CRON_OBS" ) | crontab -
  echo "✓ cron установлен"
fi

# 5) хуки — вывести JSON для settings.json
echo
echo "════════════════════════════════════════════"
echo "ПОСЛЕДНИЙ ШАГ — хуки (авто-извлечение памяти)."
echo "Добавь в $CLAUDE_DIR/settings.json → \"hooks\":"
cat <<HOOKS
  "SessionStart": [{ "matcher": "*", "hooks": [
    { "type": "command", "command": "node \"$DIR/hooks/session-start-memory-index.js\"" }
  ]}],
  "UserPromptSubmit": [{ "matcher": "*", "hooks": [
    { "type": "command", "command": "node \"$DIR/hooks/memory-retrieval.js\"", "timeout": 5 }
  ]}]
HOOKS
echo "════════════════════════════════════════════"
echo "Готово. Подробности — README.md и docs/how-it-works.md"
