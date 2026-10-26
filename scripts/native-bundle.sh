#!/bin/sh
# Packs the runner and the built helpers into dist/ for an off-device recovery
# copy, so you can still reach the TV after a bad evening.
#
# The per-device baseline is deliberately NOT included: it is specific to your
# TV and is the thing you must keep somewhere you will still have it later. Add
# it to the bundle by hand if you want.
set -eu
cd "$(dirname "$0")/.."

[ -d native/build ] || {
  echo "native/build is missing — run \`npm run native:build\` first." >&2
  exit 1
}

version=$(node -p "require('./package.json').version")
mkdir -p dist
out="dist/samsung-frame-native-home-$version.zip"
rm -f "$out"

zip -q -r "$out" \
  scripts/native-home/run.py \
  scripts/native-home/test_run.py \
  scripts/native-home/inspect.sh \
  scripts/native-home/query.sh \
  scripts/native-home/verify.sh \
  scripts/native-home/apply.sh \
  scripts/native-home/restore.sh \
  scripts/native-home/README.md \
  scripts/native-home/device.local.example.json \
  native/build

echo "Built $out"
echo "Add your saved baseline JSON by hand: it is per-device and is never bundled."
