#!/bin/sh
# Restores the saved Home/startup values. Runs on the TV as uid=901, piped into
# bash by run.py, which requires the same saved baseline apply used.
printf 'ARN0_RUN_BEGIN\n'
/usr/bin/dotnet /home/owner/share/tmp/sdk_tools/Arn0HomeControl.dll restore /home/owner/share/tmp/sdk_tools/Arn0HomeOriginal.json
printf 'ARN0_RUN_END\n'
