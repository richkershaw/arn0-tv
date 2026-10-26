#!/bin/sh
# The one write. Redirects the Home button to the launcher, with read-back and
# automatic rollback on failure (see native/Control.cs). Runs as uid=901,
# piped into bash by run.py, which gates this mode behind a saved baseline and
# an explicit confirmation.
printf 'ARN0_RUN_BEGIN\n'
/usr/bin/dotnet /home/owner/share/tmp/sdk_tools/Arn0HomeControl.dll apply /home/owner/share/tmp/sdk_tools/Arn0HomeOriginal.json
printf 'ARN0_RUN_END\n'
