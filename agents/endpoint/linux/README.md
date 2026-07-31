# CyberSentinel DLP — Linux Endpoint Agent

Deploys the DLP agent as a **systemd service** that starts at boot, restarts on
failure, and logs to journald. One command per endpoint.

## Quick start

```bash
sudo ./install.sh --server-url http://192.168.2.204:55000/api/v1
```

That's it. The agent registers itself with the manager, receives its API key,
pulls its policy bundle, and starts enforcing.

## Supported platforms

| Distro family | Package manager | Status |
|---|---|---|
| Debian / Ubuntu | `apt` | Supported |
| RHEL / Rocky / Alma / Fedora | `dnf` / `yum` | Supported |
| openSUSE / SLES | `zypper` | Supported |
| Anything else with systemd | — | Works with `--skip-deps` if Python 3.8+ and the `venv` module are present |

Requirements: systemd, Python 3.8 or newer, root, and network access to PyPI
and to the manager.

## What gets installed

| Path | Purpose |
|---|---|
| `/opt/cybersentinel/agent/agent.py` | The agent |
| `/opt/cybersentinel/venv/` | Private virtualenv (`requests`, `watchdog`) |
| `/etc/cybersentinel/agent_configure.json` | Config + endpoint identity, mode `0600` |
| `/var/log/cybersentinel/agent.log` | Rotating log, 10 MB × 4 |
| `/opt/cybersentinel/quarantine/` | Quarantined files, mode `0700` |
| `/etc/systemd/system/cybersentineldlp-agent.service` | Unit file |
| `/etc/sysctl.d/99-cybersentinel-inotify.conf` | Raised inotify watch limits |

## Options

```
--server-url URL      Manager API base, including /api/v1   (required, first install)
--agent-name NAME     Name registered with the manager       (default: hostname)
--log-level LEVEL     DEBUG|INFO|WARNING|ERROR               (default: INFO)
--install-dir PATH    Agent code directory
--config-dir PATH     Config directory
--service-name NAME   systemd unit name
--no-start            Install and enable, but don't start yet
--skip-deps           Skip OS package installation (offline / golden images)
```

## Fleet rollout

For several machines at once, over SSH:

```bash
./rollout.sh --server-url http://192.168.2.204:55000/api/v1 \
             --hosts alice@10.0.0.11,bob@10.0.0.12

# or from a file, one [user@]host per line
./rollout.sh --server-url http://192.168.2.204:55000/api/v1 --hosts-file fleet.txt
```

Needs SSH key access and passwordless sudo on the targets. It installs
`--parallel 4` at a time and prints the failing hosts' logs at the end. For
larger estates, call `install.sh` from Ansible/Salt rather than using this.

## Day-to-day

```bash
systemctl status cybersentineldlp-agent
journalctl -u cybersentineldlp-agent -f
systemctl restart cybersentineldlp-agent

# Show exactly what this endpoint would enforce, without monitoring anything
/opt/cybersentinel/venv/bin/python /opt/cybersentinel/agent/agent.py \
  --config /etc/cybersentinel/agent_configure.json --dump-policies
```

## Upgrading

Re-run `install.sh`. Code and dependencies are replaced; `agent_id` and
`agent_key` are preserved, so the endpoint keeps its identity on the manager.
`--server-url` is optional on a re-run.

```bash
sudo ./install.sh              # keeps existing manager URL
```

## Uninstalling

```bash
sudo ./uninstall.sh            # removes service + code, keeps identity
sudo ./uninstall.sh --purge    # removes everything incl. config and quarantine
```

`--purge` warns before deleting a non-empty quarantine directory — those files
may be the only remaining copy of the data they hold.

---

## Design notes

**Why a virtualenv rather than `pip3 install`.** Modern distros ship Python
marked `EXTERNALLY-MANAGED` (PEP 668). System-wide `pip install` either refuses
outright or, with `--break-system-packages`, writes to a location the next
`apt upgrade` can silently clear. That is not hypothetical: the development VM
lost its `watchdog` module exactly this way between 29 and 31 July 2026, leaving
an agent that could no longer start. The venv is owned by this installer and
nothing else touches it.

**Why identity is never packaged.** `agent_id` and `agent_key` are issued per
endpoint by the manager at registration. A config file carrying them that gets
copied across machines makes every endpoint report as the same agent record.
So `install.sh` ships `server_url` and settings only; the agent generates a UUID,
registers, and persists what the manager returns. An upgrade preserves those
fields; a fresh install never invents them.

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
mean the module imports, and `systemctl start` returning does not mean the
service stayed up. The installer imports both dependencies for real, then
watches the unit for 10 seconds and dumps `journalctl` and exits non-zero if it
died. A rollout that silently half-worked is worse than one that failed loudly.
