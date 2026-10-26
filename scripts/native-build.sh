#!/bin/sh
# Builds the two guarded native helpers (native/*.csproj) into native/build/.
# These run on the TV; they are NOT part of dist/arn0-launcher.wgt.
#
# Needs a .NET SDK: https://dotnet.microsoft.com/download
# The projects target netcoreapp3.1, whose targeting pack recent SDKs no longer
# bundle. If the build cannot resolve Microsoft.NETCore.App 3.1, install the
# .NET 6 SDK (6.0.x) or add the 3.1 reference pack. Do not retarget the projects
# just to make them build: the firmware and API guards in them are the reviewed
# safety boundary.
set -eu
cd "$(dirname "$0")/.."

command -v dotnet >/dev/null 2>&1 || {
  echo "dotnet not found on PATH. Install the .NET SDK first." >&2
  exit 1
}

mkdir -p native/build
for project in Query Control; do
  dotnet build -c Release native/"$project".csproj -o native/build
done

echo "Built native helpers into native/build:"
ls -l native/build/Arn0HomeQuery.* native/build/Arn0HomeControl.* 2>/dev/null || true
echo
echo "Next: npm run native:inspect   (needs device.local.json, see scripts/native-home/README.md)"
