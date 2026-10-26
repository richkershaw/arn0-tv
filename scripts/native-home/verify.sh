#!/bin/sh
# Compares the live values against a saved baseline and writes nothing.
# Runs on the TV as uid=901, piped into bash by run.py.
printf 'ARN0_RUN_BEGIN\n'
/usr/bin/dotnet /home/owner/share/tmp/sdk_tools/Arn0HomeControl.dll verify /home/owner/share/tmp/sdk_tools/Arn0HomeOriginal.json
printf 'ARN0_RUN_END\n'
