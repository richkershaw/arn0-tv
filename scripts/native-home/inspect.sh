#!/bin/sh
# Read-only environment probe. Runs on the TV as uid=901, piped into bash by the
# host runner (run.py) — the shebang is not used. Writes nothing to the device.
printf 'ARN0_RUN_BEGIN\n'
id
uname -m
sed -n '/^Version=/p;/^Model=/p' /etc/prd_info.ini
cat /etc/tizen-release 2>/dev/null
printf '\nDOTNET\n'
ls -l /usr/bin/dotnet 2>/dev/null
ls -d /usr/share/dotnet/shared/Microsoft.NETCore.App/* 2>/dev/null
printf '\nHOME_PREFERENCES\n'
for k in db/appfw/home_appid db/appfw/startup_appid db/appfw/booting_appid_backup db/first_screen/type db/menu/smart_hub/ontvsetting/auto_start; do vconftool get "$k"; done
printf '\nNATIVE_LIBRARIES\n'
ls -l /usr/lib/libapp-context-manager-common.so /usr/lib/libcapi-appfw-app-operation-tv.so.0 /usr/lib/libvconf.so.0 2>/dev/null
printf 'ARN0_INSPECT_END\n'
printf 'ARN0_RUN_END\n'
