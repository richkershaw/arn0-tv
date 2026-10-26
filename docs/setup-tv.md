# Putting it on a TV

This guide has two halves. The first installs the launcher as an ordinary web app, which is
reversible by uninstalling it. The second changes which app the TV treats as Home and starts at
power-on, which is reversible only if you keep a baseline. Read the second half completely before
running any part of it.

**Everything here was tested on one TV.** The native helpers check for a 32-bit process, UID 901,
and the expected firmware string. They do not check the TV's model, and a matching firmware string
does not prove another model is compatible. Do not weaken or change these guards to make the
helper run elsewhere; the calls have not been validated on other hardware.

## Reference device

| | |
| --- | --- |
| Model | QE65Q70BATXXC (Samsung Q70B, 2022) |
| Firmware | T-PTMDEUC-1720.7 |
| Platform | Tizen 6.5, armv7 / 32-bit |
| Launcher app id | `Arn0Lnchr0.Launcher` |
| Developer user | UID 901, no root |

No compatibility claim for any other model, year or firmware. Tizen 7/8/9 TVs, The Frame, and
other regions' firmware are all untested here.

> **This fork.** It targets one TV — a 2022 Samsung The Frame, `QE65LS03BAUXXU` (LS03B), Tizen
> 6.5, firmware `T-PTMDEUC-1720.7`. That is the same firmware string the helpers guard on, and
> the guard does not check the model. Art Mode makes a Frame different from the reference Q70B;
> read *Art Mode and cold boot* under Part 2 before you change Home.

## Part 1 — install the launcher

Prerequisites: Node.js 20+, and the TV in Developer Mode on the same network.

1. Build the package:

   ```sh
   npm run build          # -> dist/arn0-launcher.wgt
   ```

2. Install it. Either Apps2Samsung's **Custom WGT File** option, or Tizen Studio's CLI. Use the
   same Samsung author certificate/profile used for the existing installation when updating.
   Apps2Samsung certificate options depend on its version and signing setup; do not assume that
   **Force Samsung certificate** should always be on or always be off. If an update reports an
   author-certificate mismatch, preserve the current install and resolve signing consistency
   before uninstalling, since uninstalling clears the launcher's saved settings.

3. Open it from the Samsung app list and check it works: apps launch, HDMI tiles switch inputs,
   Settings saves across a restart.

Stop here if you only want the dashboard. You can open it manually from the app list forever and
nothing about the TV's own behaviour has changed. **Part 2 is not required for the launcher to
work** — it only removes the manual step.

## Part 2 — Home button and power-on

### What this actually does

There is no public web-app API for assigning the remote's Home button. On the tested setup, the
existing Developer Mode connection provided a way to run the guarded helper on the TV as UID 901
(not root). The helper uses platform C APIs to read and update the preferences associated with
the `main` app-control operation and Home app id. This is undocumented TV behavior, not a
supported consumer API.

Two small .NET console assemblies in [native/](../native/) do exactly that and nothing else:

- **`Query.cs`** → `Arn0HomeQuery`. Read-only. Prints the current values and exits. It cannot
  write anything; there is no write call in the file.
- **`Control.cs`** → `Arn0HomeControl`. Takes `query`, `verify`, `apply` or `restore`.

Both refuse to start unless all three guards pass: the process is 32-bit, `getuid()` is 901, and
`/etc/prd_info.ini` contains the expected firmware string. Any mismatch aborts before a single
value is read.

`apply` changes the Home operation and `home_appid`; it also writes the saved `auto_start` value
back unchanged:

| Setting | From | To |
| --- | --- | --- |
| `main` app-control operation (via `app_operation_set_current_app`) | `com.samsung.tv.csfs` | `Arn0Lnchr0.Launcher` |
| `db/appfw/home_appid` | `com.samsung.tv.csfs` | `Arn0Lnchr0.Launcher` |
| `db/menu/smart_hub/ontvsetting/auto_start` | saved baseline (`1` on reference TV) | same value |

It reads three further keys (`db/appfw/startup_appid`, `db/appfw/booting_appid_backup`,
`db/first_screen/type`) into the baseline but does not write them. On the reference TV,
`auto_start` was already `1` and remains `1`. The Home-button behavior was tested; the helper does
not itself configure power-on behavior. Do not infer that setting `auto_start` to `1` is sufficient
for startup on another model or firmware. If the saved value is `0`, stop before applying and
research that configuration separately.

Safety properties worth knowing before you trust it:

- Every write is followed by a read-back, and a mismatch throws.
- `apply` refuses to run unless the current values match your saved baseline exactly, so it will
  not stack on top of a half-finished previous run.
- If anything fails mid-apply, it restores the baseline automatically and says so. If that restore
  also fails it prints `URGENT:` and the underlying error.
- `restore` refuses if a value changed to something that is neither the baseline nor the launcher,
  on the grounds that something else has been editing these keys and you should look first.

### The runner

The runner this guide refers to now ships with the project:
[`scripts/native-home/`](../scripts/native-home/README.md). A plain `sdb shell` is not
sufficient on these TVs — the interactive shell is closed to the SDK user — so the runner uses
the SVE-2025-50109 "package-name" injection to run one script on the TV as uid=901 (**not**
root), stages the helper beside it, and streams the output back over a loopback callback. Use it;
do not hand-run `sdb shell` or substitute your own command. Method credit:
[CleanFrame](https://github.com/nthnclrk/CleanFrame), which documented it on a 2024 Frame.

### Order of operations

Do these in order. Do not skip the query.

1. **Build and configure.** `npm run native:build` (needs the .NET SDK). Copy
   `scripts/native-home/device.local.example.json` to `device.local.json` and set `host` (TV IP)
   and `sdb` (path to Tizen Studio's `sdb`). The TV must be in Developer Mode on the same network.

2. **Inspect, read-only.** `npm run native:inspect`. It confirms the environment the guards need:
   uid, architecture, firmware, the .NET runtime, the current `vconftool` values and the native
   libraries. It changes nothing.

3. **Query, read-only.** `npm run native:query` runs `Arn0HomeQuery` — before `Arn0HomeControl`
   is staged at all. You are checking three things: the guards pass, the keys read back values you
   recognise, and `launcher_boot_supported=1`. If that last one is `0`, the TV is telling you the
   app is not eligible for boot and `apply` will refuse anyway — stop and investigate.

4. **Save the baseline.** Write the query output to a JSON file off the TV, in the shape
   `Control.cs` expects. **Use your TV's own values, never the reference ones**, and keep the file
   somewhere you will still have it after a bad evening — not only on the TV and not only in the
   repo. `.gitignore` excludes `*-baseline.json` and `original-*.json`; a baseline is per-device.

   ```json
   {
     "Home": "com.samsung.tv.csfs",
     "Strings": {
       "db/appfw/home_appid": "com.samsung.tv.csfs",
       "db/appfw/startup_appid": "com.samsung.tv.csfs",
       "db/appfw/booting_appid_backup": "com.samsung.tv.csfs",
       "db/first_screen/type": "com.samsung.tv.csfs"
     },
     "Autostart": 1
   }
   ```

5. **Verify the baseline.** `npm run native:verify -- <baseline.json>`. It compares the live values
   against the file and prints `ARN0_BASELINE_MATCH=` on success. Nothing is written.

6. **Apply.** `npm run native:apply -- <baseline.json>`. The runner asks you to type `APPLY`
   first, and refuses outright if the baseline's `Autostart` is `0`. A successful result prints
   `ARN0_APPLIED=` and a read-back of the Home operation, `home_appid` and `auto_start`. Test Home
   from another app, then do the physical checks below. The helper does not change power-on
   settings; validate cold-start behaviour separately before claiming it works.

7. **Know your way back.** `npm run native:restore -- <baseline.json>` restores all saved Home and
   startup values and prints `ARN0_RESTORED=`.

### Art Mode and cold boot (Samsung The Frame)

`apply` writes the `main` app-control operation and `db/appfw/home_appid`, and writes `auto_start`
back unchanged. On a Frame this interacts with Art Mode, and arn0 rated the Frame untested — treat
it as an experiment, not a supported flow.

- **Not at risk.** The Art Mode app (`org.tizen.art-app`: artwork, mattes, brightness) and
  entering/leaving Art Mode with the Power key, which is a firmware event rather than the Home
  operation.
- **Can change.** Where the Home button goes, and what appears at cold boot, because `home_appid`
  is what the boot manager uses to choose the Home app. A Frame often wakes into Art Mode, so this
  is the behaviour to watch.
- **The `auto_start = 0` gate.** If your baseline's `Autostart` is `0`, stop and research that case
  before applying. The runner enforces this and will not stage the write-capable helper.

Before keeping any apply, confirm on the TV: the launcher's **Settings → Samsung Home** entry
opens something usable, the **Power-key art toggle** still works, a **cold start** lands where you
expect, and the **art screen** still renders and exits. Keep the baseline and the runner available
throughout — on a Frame the art app can wedge and stop answering its own power key, and a power
cycle is the usual fix.

## Recovery

In rough order of how much you have to lose:

- **Home goes somewhere unexpected, TV otherwise fine.** Run `restore` through the same reviewed
  runner. This is the normal recovery path and is why the baseline must be saved off the TV.
- **The launcher misbehaves.** Restore the baseline before uninstalling the launcher, if the
  developer connection and runner are available. Do not rely on uninstalling an app that is still
  assigned as Home to make the TV recover automatically.
- **You cannot reach the TV over `sdb`.** Developer Mode is toggled from the TV's own menus, which
  are reachable through Samsung's Home — which is what you just redirected. Expect to work via the
  launcher's **Settings → Samsung Home** entry, which opens `com.samsung.tv.csfs` and puts TV
  settings one press away. Leaving that path in the launcher is not decoration; it is the reason
  a bad apply is survivable.
- If neither the launcher nor the developer connection is usable, use Samsung's documented
  consumer support/recovery path for the exact model. Do not enter the service menu or perform a
  factory reset based only on this guide.

A firmware update can change or undo any of this. These are undocumented platform preferences,
not an API with a compatibility promise. Re-run the read-only query after any firmware update
before assuming the state is what you left.

## If you are forking this

The honest summary: Part 1 transfers to any Tizen TV with modest effort. Part 2 does not transfer —
it transfers as a *method*. The method is: find the keys read-only, save a baseline, write the two
values with read-back, keep an automatic rollback, and keep a route back to the TV's own menus.
The specific firmware string and app id in `native/` are mine and must become yours deliberately.

A coding agent is genuinely useful for the browser-preview and launcher work. For Part 2 it needs
access to your actual TV on your local network, so a hosted chat that can only read this repo
cannot do it. Ask it to query before it controls, and do not let it skip the baseline.
