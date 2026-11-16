#!/bin/sh
# Compile every translation catalog into the extension's local gettext tree.
set -eu
project_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"
for catalog in po/*.po; do
    [ -f "$catalog" ] || continue
    language=$(basename "$catalog" .po)
    destination="locale/$language/LC_MESSAGES"
    mkdir -p "$destination"
    msgfmt --check --check-format --statistics --output-file="$destination/amneziawg.mo" "$catalog"
done
