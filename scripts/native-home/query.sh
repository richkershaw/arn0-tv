#!/bin/sh
# Read-only: prints the current Home/startup values from the Arn0HomeQuery
# assembly. Runs on the TV as uid=901, piped into bash by run.py.
printf 'ARN0_RUN_BEGIN\n'
/usr/bin/dotnet /home/owner/share/tmp/sdk_tools/Arn0HomeQuery.dll
printf 'ARN0_RUN_END\n'
