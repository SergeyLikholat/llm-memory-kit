#!/usr/bin/env bash
# Создать следующую ПОДВЕРСИЮ файла (снапшот перед работами). Оригинал не трогается.
# Схемы: "...верс10-1.xlsm" → "...верс10-2.xlsm"; "...верс10.xlsm" → "...верс10-1.xlsm";
#        "..._v3.xlsx" → "..._v4.xlsx". Без версии → добавит "_верс1".
# Usage: next-excel-version.sh "/path/to/current.xlsm"
set -euo pipefail
SRC="$1"
[ -f "$SRC" ] || { echo "нет файла: $SRC" >&2; exit 1; }
dir=$(dirname "$SRC"); base=$(basename "$SRC"); ext="${base##*.}"; name="${base%.*}"
if [[ "$name" =~ ^(.*верс[0-9]+)-([0-9]+)$ ]]; then           # верс10-1 → верс10-2
  new="${BASH_REMATCH[1]}-$(( BASH_REMATCH[2] + 1 ))"
elif [[ "$name" =~ ^(.*верс)([0-9]+)$ ]]; then                # верс10 → верс10-1
  new="${BASH_REMATCH[1]}${BASH_REMATCH[2]}-1"
elif [[ "$name" =~ ^(.*[_-][vвВ])([0-9]+)$ ]]; then           # _v3 → _v4
  new="${BASH_REMATCH[1]}$(( BASH_REMATCH[2] + 1 ))"
else
  new="${name}_верс1"
fi
dst="$dir/$new.$ext"
[ -e "$dst" ] && { echo "уже существует: $dst" >&2; exit 2; }
cp -p "$SRC" "$dst"
echo "$dst"
