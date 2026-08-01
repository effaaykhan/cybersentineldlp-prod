# CyberSentinel DLP — Linux Endpoint Agent

Builds the agent into **one self-contained executable** and installs it as a
**systemd service** that starts at boot, restarts on failure, and logs to
journald. One command per endpoint.

There are two entry points, and which one you want depends on who is running it:

| | Script | Who runs it | Needs |
|---|---|---|---|
| **Client endpoints** | `install_agent.sh` (repo root) | The person installing on a workstation | Nothing but `curl` — it fetches the executable from GitHub |
| **Build / packaging** | `install.sh` (this directory) | You, to produce the executable | The source tree and a Python toolchain |

## Client install (the one-liner)

This is the Linux counterpart of `install-agent.ps1`. It is the **only** file a
client machine needs; the executable, its checksum and the systemd unit are all
fetched from the repo.

```bash
curl -fsSL https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/install_agent.sh | sudo bash
```

Unattended, for imaging or config management:

```bash
curl -fsSL .../install_agent.sh | sudo bash -s -- \
     --server-host dlp.corp.local --agent-name web-01 --yes
```

It prompts for the server, agent name and intervals (reading from `/dev/tty`,
so prompts still work through the pipe), removes any previous agent while
carrying its identity forward, verifies the downloaded binary's SHA-256 against
the sidecar in the repo and **refuses to install on a mismatch**, then installs
and starts the service.

### Publishing what it downloads

`install_agent.sh` expects these in the repo. Regenerate them whenever the agent
changes:

```bash
sudo ./install.sh --build-only
cp /opt/cybersentinel/build/dist/cybersentineldlp-agent agents/endpoint/linux/dist/
cd agents/endpoint/linux/dist
sha256sum cybersentineldlp-agent > cybersentineldlp-agent.sha256
```

Without the `.sha256` sidecar the installer warns loudly and continues; with a
mismatched one it exits `2` and installs nothing.

## Build / packaging

```bash
sudo ./install.sh --server-url http://192.168.2.204:55000/api/v1
```

That's it. The installer freezes `agent.py`, `policy_cache.py` and
`print_monitor.py` — together with the Python runtime, `requests` and
`watchdog` — into a single 13 MB binary, installs it, and starts it. The agent
registers itself with the manager, receives its API key, pulls its policy
bundle, and starts enforcing.

## Build once, ship everywhere

Building on every endpoint means a Python toolchain and PyPI access on every
endpoint. For a fleet, build once and ship the binary instead:

```bash
# on a build host (ideally the OLDEST distro you deploy to — see glibc note below)
sudo ./install.sh --build-only

# then, on machines that have no Python at all
sudo ./install.sh --prebuilt-binary ./cybersentineldlp-agent \
     --server-url http://192.168.2.204:55000/api/v1
```

## Supported platforms

| Distro family | Package manager | Status |
|---|---|---|
| Debian / Ubuntu | `apt` | Supported |
| RHEL / Rocky / Alma / Fedora | `dnf` / `yum` | Supported |
| openSUSE / SLES | `zypper` | Supported |
| Anything else with systemd | — | Works with `--skip-deps`, or with `--prebuilt-binary` and no Python at all |

- **To build:** systemd, Python 3.8+, root, network access to PyPI.
- **To install a prebuilt binary:** systemd, root, and a compatible glibc.
  No Python, no virtualenv, no PyPI.

## What gets installed

| Path | Purpose |
|---|---|
| `/opt/cybersentinel/agent/cybersentineldlp-agent` | The agent — one executable, mode `0750` |
| `/opt/cybersentinel/run/` | Where the executable unpacks itself at start |
| `/etc/cybersentinel/agent_configure.json` | Config + endpoint identity, mode `0600` |
| `/var/log/cybersentinel/agent.log` | Rotating log, 10 MB × 4 |
| `/opt/cybersentinel/quarantine/` | Quarantined files, mode `0700` |
| `/etc/systemd/system/cybersentineldlp-agent.service` | Unit file |
| `/etc/sysctl.d/99-cybersentinel-inotify.conf` | Raised inotify watch limits |

`/opt/cybersentinel/build/` exists only during a build and is deleted afterwards
unless you pass `--keep-build`. No Python source is left on the endpoint.

## Options

```
--server-url URL      Manager API base, including /api/v1   (required, first install)
--agent-name NAME     Name registered with the manager       (default: hostname)
--log-level LEVEL     DEBUG|INFO|WARNING|ERROR               (default: INFO)
--install-dir PATH    Where the executable is installed
--config-dir PATH     Config directory
--service-name NAME   systemd unit name
--prebuilt-binary P   Install an executable built elsewhere; skips the build
--build-only          Build the executable and stop; installs nothing
--keep-build          Keep the build venv so re-runs rebuild faster
--no-start            Install and enable, but don't start yet
--skip-deps           Skip OS package installation (offline / golden images)
```

## Fleet rollout

For several machines at once, over SSH:

```bash
# each target builds its own binary (needs a toolchain on each)
./rollout.sh --server-url http://192.168.2.204:55000/api/v1 \
             --hosts alice@10.0.0.11,bob@10.0.0.12

# or build once here and ship only the binary (nothing needed on the targets)
sudo ./install.sh --build-only
./rollout.sh --server-url http://192.168.2.204:55000/api/v1 --hosts-file fleet.txt \
             --prebuilt-binary /opt/cybersentinel/build/dist/cybersentineldlp-agent
```

Needs SSH key access and passwordless sudo on the targets. It installs
`--parallel 4` at a time and prints the failing hosts' logs at the end. For
larger estates, call `install.sh` from Ansible/Salt rather than using this.

## Day-to-day

```bash
systemctl status cybersentineldlp-agent
journalctl -u cybersentineldlp-agent -f
systemctl restart cybersentineldlp-agent

# Confirm what the binary actually contains
/opt/cybersentinel/agent/cybersentineldlp-agent --selftest

# Show exactly what this endpoint would enforce, without monitoring anything
/opt/cybersentinel/agent/cybersentineldlp-agent \
  --config /etc/cybersentinel/agent_configure.json --dump-policies
```

## Upgrading

Re-run `install.sh`. The executable is rebuilt and replaced; `agent_id` and
`agent_key` are preserved, so the endpoint keeps its identity on the manager.
`--server-url` is optional on a re-run.

```bash
sudo ./install.sh              # keeps existing manager URL
```

Upgrading from the older interpreted install is automatic: the superseded
`agent.py` and its ~50 MB runtime virtualenv are removed, but only after the
new binary is confirmed running.

## Uninstalling

```bash
sudo ./uninstall.sh            # removes service + executable, keeps identity
sudo ./uninstall.sh --purge    # removes everything incl. config and quarantine
```

`--purge` warns before deleting a non-empty quarantine directory — those files
may be the only remaining copy of the data they hold.

---

## Design notes

**Why a single executable.** Every endpoint previously needed a matching Python,
a working `venv` module, and reachable PyPI at install time — three things that
vary across a mixed fleet and each of which fails differently. Freezing removes
all three from the endpoint: the binary carries its own interpreter and
libraries, so the target needs nothing but a kernel and systemd. It also means
the unit file is byte-identical everywhere, with no interpreter path in it.

**What is inside it, and the one thing that isn't obvious.** `agent.py`,
`policy_cache.py`, `print_monitor.py`, CPython, `requests` and `watchdog`. Note
that the current v2 agent imports neither `policy_cache` nor `print_monitor` —
`print_monitoring` is explicitly `False` in its defaults. PyInstaller's static
analysis therefore drops them, so they are forced in with `--hidden-import` and
are inert payload until the agent actually calls them. `--selftest` imports all
three and fails loudly if any is missing, so the day v2 starts using them, the
binary already carries them.

**Why the build still uses a virtualenv.** It is a build artifact now, not a
runtime dependency, and it is deleted when the build finishes. It is still a
venv rather than system `pip` because modern distros ship Python marked
`EXTERNALLY-MANAGED` (PEP 668), where `pip install --break-system-packages`
writes to a location the next `apt upgrade` can silently clear. That is not
hypothetical: this VM lost its `watchdog` module exactly that way between 29 and
31 July 2026, leaving an agent that could no longer start.

**Why the unpack directory is not `/tmp`.** A onefile binary extracts itself on
every start. The default location is `/tmp`, which is mounted `noexec` on plenty
of hardened and CIS-benchmarked hosts; the binary then fails at exec time with a
message that points nowhere near the real cause. It is built with
`--runtime-tmpdir /opt/cybersentinel/run` instead. Because a `SIGKILL` leaves
the extracted copy behind — and `Restart=always` means crashes recur — the unit
sweeps stale `_MEI*` directories in `ExecStartPre` rather than accumulating one
per crash.

**Why glibc decides your build host.** A PyInstaller binary links against the
glibc it was built on and will not start on an older one. Build on the oldest
distro in the fleet, or build per distro family. Building on each target (the
default) sidesteps this entirely, which is why it stayed the default.

**Why identity is never packaged.** `agent_id` and `agent_key` are issued per
endpoint by the manager at registration. A config file carrying them that gets
copied across machines makes every endpoint report as the same agent record. So
`install.sh` ships `server_url` and settings only; the agent generates a UUID,
registers, and persists what the manager returns. An upgrade preserves those
fields; a fresh install never invents them.

**Why the binary writes its own config.** The config step runs
`cybersentineldlp-agent --install-config`, not a Python script. If the installer
shelled out to `python3` for this, every `--prebuilt-binary` install would still
need an interpreter on the target — which would defeat the point of shipping a
frozen binary at all.

**Why the unit runs as root and isn't sandboxed.** Process suspension and
termination (`SIGSTOP`/`SIGKILL` on transfer tools), USB device control, and
inotify watches across other users' homes all require root. The usual hardening
directives — `ProtectSystem`, `ProtectHome`, `PrivateTmp` — would each break a
core capability: a DLP agent must read arbitrary files, move them into
quarantine, and signal other users' processes. Adding them would look like
hardening while quietly disabling enforcement.

**Why `StartLimitIntervalSec=0`.** By default systemd gives up after 5 restarts
in 10 seconds and parks the unit in `failed`. For a security control, "the
manager was briefly unreachable during a reboot, so monitoring is now off until
someone notices" is the wrong failure mode. `RestartSec=10` already bounds
retries to roughly six per minute.

**Why inotify limits are raised.** Recursive monitoring consumes one watch per
directory. The stock `max_user_watches` of 65536 is reachable on a workstation
or file server, and exhaustion is silent — `watchdog` simply stops delivering
events for paths it could not register. 524288 costs about 50 MB of kernel
memory at full use.

**Why the installer verifies rather than reports.** `pip` exiting 0 does not
mean the module imports; PyInstaller producing a file does not mean it runs; and
`systemctl start` returning does not mean the service stayed up. So the
installer imports the dependencies for real, runs the finished binary's
`--selftest` and `--help` before it goes anywhere near a service unit, then
watches the unit for 15 seconds and dumps `journalctl` and exits non-zero if it
died. A rollout that silently half-worked is worse than one that failed loudly.
