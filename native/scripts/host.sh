#!/usr/bin/env bash
# Builds the native app into this checkout's own `target/`. The first time, target/ is
# seeded with a copy of svelte-gpui's GPUI artifacts (SHARED), so GPUI is not compiled
# again; on btrfs the copy is a reflink, instant and free until a file changes.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
target=$root/target
shared=${SHARED:-$HOME/Documents/neoworks/svelte-gpui/target}

if [ ! -d "$target/release/deps" ] && [ -d "$shared/release/deps" ]; then
  echo "seeding $target from $shared" >&2
  mkdir -p "$target"
  cp -r --reflink=auto "$shared/release" "$target/"
fi

CARGO_TARGET_DIR=$target cargo build --release --manifest-path "$root/Cargo.toml"
