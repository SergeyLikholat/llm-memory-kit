#!/usr/bin/env bash
# llm-memory-kit — конфигурация. Скопируй в config.sh и поправь под свой сервер.
# Все скрипты читают эти значения (через окружение MEMKIT_*).

# Домашняя папка Claude Code (где .claude)
export MEMKIT_CLAUDE_DIR="${MEMKIT_CLAUDE_DIR:-$HOME/.claude}"

# Папка с твоими проектами (у каждого будет memory/)
export MEMKIT_PROJECTS_DIR="${MEMKIT_PROJECTS_DIR:-$HOME/projects}"

# Общий контур памяти (для сессий вне проектов)
export MEMKIT_ROOT_MEM="${MEMKIT_ROOT_MEM:-$HOME/.claude/projects/-root/memory}"

# Obsidian-волт (нужно только для модуля obsidian). Пусто = модуль выключен.
export MEMKIT_OBSIDIAN_DIR="${MEMKIT_OBSIDIAN_DIR:-}"
# Маппинг папок волта в домены (JSON). Пусто = домен по верхней папке. Пример структуры волта:
export MEMKIT_OBSIDIAN_DOMAINS='${MEMKIT_OBSIDIAN_DOMAINS:-{"Projects/":"projects","Areas/":"areas","Resources/":"resources","Inbox/":"inbox"}}'

# Приватные проекты: их шарды НЕ индексируются телом (только указатель на _index).
# Список имён проектов через запятую. Пусто = приватного контура нет.
export MEMKIT_PRIVATE_PROJECTS="${MEMKIT_PRIVATE_PROJECTS:-}"

# Бинарь Claude Code (headless-вызовы на подписке)
export MEMKIT_CLAUDE_BIN="${MEMKIT_CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}"
export MEMKIT_MODEL="${MEMKIT_MODEL:-sonnet}"   # модель headless-вызовов (sonnet экономнее opus)

# Часовой пояс для расписания и дат
export MEMKIT_TZ="${MEMKIT_TZ:-Europe/Moscow}"

# Telegram (опционально): routing по топикам. Пусто = topic-routing выключен.
export MEMKIT_TG_ROUTING="${MEMKIT_TG_ROUTING:-$HOME/.claude/channels/telegram/routing.json}"
