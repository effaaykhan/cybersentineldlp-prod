"""
Frozen entry point for the CyberSentinel DLP Linux agent.

PyInstaller builds one self-contained executable from this file, bundling
agent.py, policy_cache.py and print_monitor.py together with the Python
runtime and every third-party dependency.

This shim exists rather than freezing agent.py directly because the installer
needs two things the agent itself cannot provide once frozen:

  --selftest        Proves all three modules are actually inside the binary.
                    policy_cache and print_monitor are not imported by the
                    current agent, so PyInstaller's static analysis would drop
                    them; they are forced in as hidden imports at build time
                    and this is what verifies that worked.

  --install-config  Writes /etc/cybersentinel/agent_configure.json. Putting
                    this here means the target machine needs no system Python
                    and no virtualenv — the binary configures itself.

Any other argument list is passed straight through to agent.py unchanged.
"""

import runpy
import sys


def _selftest():
    """Report what is inside this binary. Exit non-zero if anything is missing."""
    import importlib
    import importlib.util

    print("  frozen     : %s" % bool(getattr(sys, "frozen", False)))
    print("  bundle dir : %s" % getattr(sys, "_MEIPASS", "<not frozen>"))
    print("  python     : %s" % sys.version.split()[0])

    missing = []

    # agent is probed rather than imported: importing it would run its
    # module-level setup, which is not something a self-test should do.
    if importlib.util.find_spec("agent") is None:
        missing.append("agent")
    else:
        print("  bundled    : agent")

    for name in ("policy_cache", "print_monitor",
                 "requests", "watchdog.observers", "watchdog.events"):
        try:
            importlib.import_module(name)
        except Exception as exc:
            missing.append("%s (%s)" % (name, exc))
        else:
            print("  bundled    : %s" % name)

    if missing:
        print("  MISSING    : %s" % ", ".join(missing), file=sys.stderr)
        return 1

    print("  selftest OK")
    return 0


def _install_config():
    """
    Create or update the agent config from environment variables.

    Identity handling is the crux of multi-machine deployment: agent_id and
    agent_key are issued per endpoint by the manager at registration. Writing
    them here — or copying a populated config between machines — would make
    every endpoint collapse into a single agent record server-side. So this
    never invents identity and never overwrites it.
    """
    import json
    import os
    import socket

    path = os.environ["CS_CONFIG_FILE"]
    server_url = os.environ.get("CS_SERVER_URL") or ""
    agent_name = os.environ.get("CS_AGENT_NAME") or ""
    quarantine = os.environ["CS_QUARANTINE_DIR"]

    existing = {}
    if os.path.exists(path):
        try:
            with open(path) as fh:
                existing = json.load(fh)
        except Exception as exc:
            print("  ! existing config unreadable (%s); regenerating." % exc,
                  file=sys.stderr)
            existing = {}

    cfg = dict(existing)

    if server_url:
        cfg["server_url"] = server_url
    elif not cfg.get("server_url"):
        print("  ! no server_url available.", file=sys.stderr)
        return 1

    if agent_name:
        cfg["agent_name"] = agent_name
    elif not cfg.get("agent_name"):
        cfg["agent_name"] = socket.gethostname()

    cfg.setdefault("heartbeat_interval", 30)
    cfg.setdefault("policy_sync_interval", 60)

    quar = dict(cfg.get("quarantine") or {})
    quar.setdefault("enabled", True)
    quar["folder"] = quar.get("folder") or quarantine
    cfg["quarantine"] = quar

    mon = dict(cfg.get("monitoring") or {})
    mon.setdefault("file_system", True)
    # Empty by design: monitored paths come from the manager's policy bundle.
    # A non-empty fallback here would have every endpoint watching directories
    # no policy asked for.
    mon.setdefault("monitored_paths", [])
    mon.setdefault("exclude_paths", [
        "/proc", "/sys", "/dev", "/run", "/snap",
        "/var/lib/docker", "/var/log",
        "~/.cache", "~/.local/share", "~/.config",
        "~/snap", "~/.mozilla", "~/.thunderbird",
        quarantine,
    ])
    cfg["monitoring"] = mon

    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(cfg, fh, indent=2)
    os.chmod(tmp, 0o600)      # holds the agent API key
    os.replace(tmp, path)     # atomic: never leave a half-written config

    kept = [k for k in ("agent_id", "agent_key") if existing.get(k)]
    print("  server_url = %s" % cfg["server_url"])
    print("  agent_name = %s" % cfg["agent_name"])
    if kept:
        print("  preserved existing identity (%s)" % ", ".join(kept))
    else:
        print("  no identity yet - agent will register on first start")

    # Machine-readable last line: on an upgrade --server-url is optional, so
    # the installer reads back whatever is actually in effect.
    print("CS_EFFECTIVE_SERVER_URL=%s" % cfg["server_url"])
    return 0


def main():
    argv = sys.argv[1:]

    if "--selftest" in argv:
        return _selftest()
    if "--install-config" in argv:
        return _install_config()

    # run_name="__main__" so agent.py's own `if __name__ == "__main__"` block
    # runs exactly as it does when the script is invoked directly.
    runpy.run_module("agent", run_name="__main__")
    return 0


if __name__ == "__main__":
    sys.exit(main())
