# Native Home runner

The runner that [docs/setup-tv.md](../../docs/setup-tv.md) Part 2 refers to. It
stages the guarded helpers in [`native/`](../../native/) onto the TV and runs
them as **uid=901** (the SDK user, *not* root) over the existing SDB developer
connection. Nothing here is a public Samsung API.

## Why a runner at all

A plain `sdb shell` is not enough on these TVs: the interactive shell is closed
to the SDK user, so the preference and app-control APIs — which only answer to
uid=901 — are unreachable that way. The runner uses the **SVE-2025-50109
"package-name" injection**: a crafted `appinstall` package name that the TV's
installer hands to a shell, running our script as uid=901. Because that channel
does not return stdout cleanly, the script dials back to a loopback TCP listener
on this computer and streams its output there. Temporary files are staged under
`/home/owner/share/tmp/sdk_tools` and cleaned up by the SDK; the runner re-stages
them on every run.

Method credit: [CleanFrame](https://github.com/nthnclrk/CleanFrame)
(`scripts/native-home/`), which documented it on a 2024 Frame. See also
[chris-ritsen/samsung-tv-root](https://github.com/chris-ritsen/samsung-tv-root)
for the same foothold taken further.

## Setup

1. Build the helpers (needs the .NET SDK): `npm run native:build`.
2. Copy `device.local.example.json` to `device.local.json` (gitignored) and fill
   in `host` (TV IP) and `sdb` (path to Tizen Studio's `sdb`).
3. The TV must be in Developer Mode on the same network, and the launcher
   installed under its own identity.

## Commands

| Command | Writes? | What it does |
| --- | --- | --- |
| `npm run native:inspect` | no | environment probe: uid, arch, firmware, .NET runtime, current `vconftool` values, native libs |
| `npm run native:query` | no | runs `Arn0HomeQuery`: Home operation, the five settings, `launcher_boot_supported` |
| `npm run native:verify -- <baseline.json>` | no | compares live values against the saved baseline |
| `npm run native:apply -- <baseline.json>` | **yes** | redirects Home to the launcher (read-back + auto-rollback) |
| `npm run native:restore -- <baseline.json>` | **yes** | restores the saved Home/startup values |
| `npm run native:test` | no | unit-tests the runner's pure logic (no TV) |

Pass a baseline path through npm with `--`, e.g.
`npm run native:verify -- ~/arn0-frame-baseline.json`.

`inspect` and `query` stage only the read-only `Arn0HomeQuery` assembly;
`verify`, `apply` and `restore` stage the write-capable `Arn0HomeControl`. The
two are never mixed.

## Order of operations

Do these in order. Do not skip the query.

```sh
npm run native:build
cp scripts/native-home/device.local.example.json scripts/native-home/device.local.json
$EDITOR scripts/native-home/device.local.json

npm run native:inspect
npm run native:query          # -> save the ARN0_QUERY / QUERY output as a baseline
                              #    off the TV, in Control.cs's snapshot shape
npm run native:verify  -- <baseline.json>
#   -> physical checks (see below)
npm run native:apply   -- <baseline.json>
#   -> on a Frame, REBOOT the TV now: the Home key does not pick up the
#      change until the TV restarts, even though the read-back is already correct
npm run native:restore -- <baseline.json>     # the way back
```

The baseline JSON is the shape `Control.cs` loads:

```json
{
  "Home": "...",
  "Strings": {
    "db/appfw/home_appid": "...",
    "db/appfw/startup_appid": "...",
    "db/appfw/booting_appid_backup": "...",
    "db/first_screen/type": "..."
  },
  "Autostart": 1
}
```

Use **your TV's** values, never the reference ones. Keep the file somewhere you
will still have it after a bad evening — not only on the TV and not only in the
repo. `.gitignore` excludes `*-baseline.json` and `original-*.json`; the
recovery bundle (`npm run native:bundle`) deliberately does not include it.

## Safety

- Read-only is the default; every write is its own command.
- The runner refuses `apply`/`restore` without a baseline, and refuses to even
  stage anything if it is not shaped the way `Control.cs` expects.
- **`apply` refuses when the baseline's `Autostart` is `0`** — see below. This
  blocks `apply` only; `verify` and `restore` still work on such a baseline.
- `apply` asks you to type `APPLY` (or set `ARN0_CONFIRM_APPLY=1` to confirm
  non-interactively). No typing, no write.
- The helpers themselves re-check 32-bit, uid=901 and the firmware string, read
  back every write, roll back a failed apply, and refuse `restore` on values
  that are neither the baseline nor the launcher.
- Nothing device-specific is committed: the TV IP and baseline live in
  gitignored files, and captured output goes to `scripts/native-home/out/`
  (gitignored).

## Art Mode and cold boot (Samsung The Frame)

`apply` writes the `main` app-control operation and `db/appfw/home_appid`, and
writes `auto_start` back unchanged. On a Frame this interacts with Art Mode, and
arn0 rated the Frame untested, so treat it as an experiment:

- **Not at risk:** the Art Mode app (`org.tizen.art-app`, artwork, mattes,
  brightness), and entering/leaving Art Mode with the Power key (a firmware
  event, not the Home operation).
- **Can change:** where the Home button goes, and what appears at cold boot,
  because `home_appid` is what the boot manager uses to choose the Home app.

Before keeping any apply, confirm on the TV: the launcher's **Settings →
Samsung Home** entry opens something usable, the **Power-key art toggle** still
works, a **cold start** lands where you expect, and the **art screen** still
renders and exits. If `auto_start` is `0`, stop and research that case first —
the runner will refuse it for you.

## Config

`device.local.json` (gitignored; all fields optional, environment overrides win):

| Field | Env | Default | Meaning |
| --- | --- | --- | --- |
| `host` | `ARN0_TV_IP` | — (required) | TV IP address |
| `model` | `ARN0_MODEL` | `QE65LS03BAUXXU` | expected model, checked at `:8001` when the TV reports one |
| `firmware` | `ARN0_FIRMWARE` | `T-PTMDEUC-1720.7` | expected firmware (the helper enforces this on the TV too) |
| `sdb` | `ARN0_SDB` | `sdb` | path to Tizen Studio's `sdb` |
| `dotnet` | `ARN0_DOTNET` | `/usr/bin/dotnet` | .NET host on the TV (baked into the `*.sh`; edit those if it differs) |
| `helper_dir` | `ARN0_HELPER_DIR` | `native/build` | where the built assemblies live |

## Files

| File | Role |
| --- | --- |
| `run.py` | host runner: preflight, staging, injection, capture, gates |
| `inspect.sh`, `query.sh`, `verify.sh`, `apply.sh`, `restore.sh` | the script each mode runs on the TV |
| `test_run.py` | unit tests for the pure logic |
| `device.local.example.json` | template config |
| `out/` (gitignored) | captured output and transport logs per run |
