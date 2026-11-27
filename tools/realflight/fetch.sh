#!/usr/bin/env bash
# Fetch the two public flight-log datasets that check.py reads, pinned to the commits it was
# run against. Nothing here is stored in the repo.
#
#   NanoBench, Crazyflie 2.1 (BSD-3-Clause)        github.com/syediu/nanobench-iros2026
#   ARPL data-driven system identification (MIT)  github.com/arplaboratory/data-driven-system-identification
#
# Usage: tools/realflight/fetch.sh [dest]    (default dest: .realflight-data, about 550 MB)
set -euo pipefail
dest="${1:-.realflight-data}"
mkdir -p "$dest"

fetch() {  # name url commit
  local dir="$dest/$1"
  if [ ! -d "$dir/.git" ]; then
    git clone --filter=blob:none --no-checkout "$2" "$dir"
  fi
  git -C "$dir" fetch --filter=blob:none origin "$3"
  git -C "$dir" -c advice.detachedHead=false checkout "$3"
}

fetch nanobench https://github.com/syediu/nanobench-iros2026.git 934a1ab92c458cad99c9278a5cb63bf68af6e56c
fetch arpl https://github.com/arplaboratory/data-driven-system-identification.git 2d267dd07b4262f579ee223d20b26a6dc9d17147

echo "Data ready in $dest. Run:"
echo "  python tools/realflight/check.py --data $dest --out docs/realflight"
