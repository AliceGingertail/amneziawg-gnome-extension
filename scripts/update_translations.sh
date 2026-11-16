#!/bin/sh
# Refresh the template and merge source changes into all existing catalogs.
set -eu
project_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"
xgettext --language=JavaScript --from-code=UTF-8 --keyword=_ --keyword=_translate \
    --add-comments=Translators: --package-name=amneziawg \
    --package-version=1.0 --copyright-holder='AmneziaWG extension contributors' \
    --output=po/amneziawg.pot ./*.js
for catalog in po/*.po; do
    [ -f "$catalog" ] || continue
    msgmerge --update --backup=none "$catalog" po/amneziawg.pot
done
