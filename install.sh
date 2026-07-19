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

# 1b) модель headless-вызовов
MODEL_=$(ask "Модель для ночных вызовов (sonnet экономнее opus)" "sonnet")

# 2) модули
echo; echo "Модули:"
read -r -p "  Подключить Obsidian-sync (заметки→wiki)? [y/N]: " OBS
OBSIDIAN_DIR=""; OBSIDIAN_DOMAINS="{}"
if [[ "${OBS,,}" == y* ]]; then
  OBSIDIAN_DIR=$(ask "  Папка Obsidian-волта" "$HOME/Obsidian")
  # маппинг доменов: показываем верхние папки волта, для каждой спрашиваем имя домена
  if [ -d "$OBSIDIAN_DIR" ]; then
    echo; echo "  Домены волта — крупные разделы, под которые строятся карты."
    echo "  Для каждой верхней папки задайте короткое имя домена (Enter — пропустить):"
    pairs=""
    while IFS= read -r folder; do
      base="$(basename "$folder")"
      [ "$base" = "_wiki" ] && continue                     # служебная папка кита
      read -r -p "    «$base/» → домен: " dom </dev/tty || dom=""
      [ -n "$dom" ] && pairs="$pairs\"$base/\":\"$dom\","
    done < <(find "$OBSIDIAN_DIR" -mindepth 1 -maxdepth 1 -type d | sort)
    [ -n "$pairs" ] && OBSIDIAN_DOMAINS="{${pairs%,}}"
    echo "  Маппинг: $OBSIDIAN_DOMAINS  (пусто {} = домен по имени папки)"
  fi
fi

# 2b) приватные проекты
echo
read -r -p "Приватные проекты (через запятую, Enter — нет): " PRIVATE_
PRIVATE_="${PRIVATE_// /}"

# 3) config.sh
cat > config.sh <<CFG
#!/usr/bin/env bash
export MEMKIT_CLAUDE_DIR="$CLAUDE_DIR"
export MEMKIT_PROJECTS_DIR="$PROJECTS_DIR"
export MEMKIT_ROOT_MEM="$CLAUDE_DIR/projects/-root/memory"
export MEMKIT_OBSIDIAN_DIR="$OBSIDIAN_DIR"
export MEMKIT_OBSIDIAN_DOMAINS='$OBSIDIAN_DOMAINS'
export MEMKIT_PRIVATE_PROJECTS="$PRIVATE_"
export MEMKIT_CLAUDE_BIN="$CLAUDE_BIN"
export MEMKIT_MODEL="$MODEL_"
export MEMKIT_TZ="$TZ_"
export MEMKIT_TG_ROUTING="$CLAUDE_DIR/channels/telegram/routing.json"
CFG
echo "✓ config.sh создан"

chmod +x core/*.sh obsidian/*.sh helpers/*.sh core/*.js hooks/*.js obsidian/*.js 2>/dev/null || true
mkdir -p "$CLAUDE_DIR/projects/-root/memory/activity" "$PROJECTS_DIR"

# 3b) первый проект (опционально) — чтобы было куда складывать память сразу
echo
echo "Проекты — это ваши рабочие папки в $PROJECTS_DIR. Темы внутри них система заведёт"
echo "сама из ваших сессий. Можно создать первый проект сейчас (или позже, вручную)."
read -r -p "Создать проект? Имя (Enter — пропустить): " NEWPROJ
NEWPROJ="$(echo "$NEWPROJ" | tr -cd 'a-zA-Z0-9._-')"
if [ -n "$NEWPROJ" ]; then
  mkdir -p "$PROJECTS_DIR/$NEWPROJ/memory/activity"
  PURP=$(ask "  Коротко: что относится к «$NEWPROJ»" "")
  cat > "$PROJECTS_DIR/$NEWPROJ/memory/_index.md" <<IDX
---
type: memory-project-index
scope: $NEWPROJ
purpose: "$PURP"
---

# Память: $NEWPROJ

Тематические шарды появятся здесь автоматически после первого ночного прогона.
IDX
  echo "✓ проект «$NEWPROJ» создан ($PROJECTS_DIR/$NEWPROJ/memory/)"
fi

# 4) cron
# Ночной прогон 02:30 + два дополнительных окна (09:00, 16:00) на случай, если ночью
# были исчерпаны лимиты подписки. Частые ретраи (*/30) НЕ используются намеренно:
# обёртки сами держат гард (3 попытки/сутки, sentinel, rc=42 → следующее окно) — иначе
# билдер гоняется десятки раз за ночь и сжигает лимит.
CRON_CORE="30 2 * * * /usr/bin/node $DIR/core/digest.js >> $DIR/core/digest.log 2>&1
45 2 * * * $DIR/core/memory-cron.sh
0 9 * * * $DIR/core/memory-cron.sh
0 16 * * * $DIR/core/memory-cron.sh
55 2 * * * $DIR/core/entity-cron.sh
30 9 * * * $DIR/core/entity-cron.sh"
CRON_OBS=""
[ -n "$OBSIDIAN_DIR" ] && CRON_OBS="50 2 * * * $DIR/obsidian/obsidian-cron.sh
15 9 * * * $DIR/obsidian/obsidian-cron.sh"

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
echo
echo "Что дальше:"
echo "  • Просто работайте с Claude Code как обычно — темы система заведёт сама"
echo "    из ваших сессий (вручную ничего размечать не нужно)."
echo "  • Первые карточки появятся после ночного прогона (или запустите разом:"
echo "    'node $DIR/core/digest.js && $DIR/core/memory-cron.sh')."
echo "  • Тонкая настройка (purpose, приватность, домены) — docs/customize.md"
echo "Подробности — README.md и docs/how-it-works.md"
