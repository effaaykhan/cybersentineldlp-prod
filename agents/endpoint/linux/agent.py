"""
CyberSentinel DLP - Linux Endpoint Agent
Monitors file operations for data loss prevention on Linux systems

Enforcement is policy-driven: every action (log / alert / block / quarantine)
comes from the bundle the server issues at /agents/{id}/policies/sync, and every
content decision comes from the server at /agents/{id}/policy/evaluate. The
agent never invents a policy, never changes file ownership or permissions, and
never emits an event for a channel the server has no active policy for.
"""

import os
import re
import sys
import ctypes
import errno
import time
import json
import base64
import logging
import logging.handlers
import hashlib
import socket
import struct
import platform
import threading
import uuid
import signal
import atexit
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, Optional, List, Set, Tuple

import requests
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileSystemEvent

AGENT_VERSION = "2.0.0"

# Configure logging. INFO by default — the previous DEBUG default wrote a line
# per inotify event and was itself a large part of the noise. Rotate so a busy
# endpoint cannot fill the disk.
log_file = os.environ.get("CYBERSENTINEL_LOG_FILE") or os.path.expanduser('~/cybersentinel_agent.log')
_log_dir = os.path.dirname(log_file)
if _log_dir:
    os.makedirs(_log_dir, exist_ok=True)
_log_level = getattr(logging, os.environ.get("CYBERSENTINEL_LOG_LEVEL", "INFO").upper(), logging.INFO)
logging.basicConfig(
    level=_log_level,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.handlers.RotatingFileHandler(log_file, maxBytes=10 * 1024 * 1024, backupCount=3),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger('CyberSentinelAgent')
logging.getLogger("watchdog").setLevel(logging.WARNING)
logging.getLogger("watchdog.observers.inotify_buffer").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)


class AgentConfig:
    """Agent configuration"""
    def __init__(self, config_path: str = None):
        if config_path is None:
            # Look for agent_configure.json in a few standard locations,
            # in priority order. If none exist yet, a fresh one is created
            # next to this script (so it's easy to find/edit) and saved
            # with defaults on first run.
            script_dir = os.path.dirname(os.path.abspath(__file__))
            candidates = [
                "/etc/cybersentinel/agent_configure.json",
                os.path.join(script_dir, "agent_configure.json"),
                os.path.join(os.getcwd(), "agent_configure.json"),
                os.path.expanduser("~/agent_configure.json"),
            ]
            existing = next((c for c in candidates if os.path.exists(c)), None)
            self.config_path = existing if existing else os.path.join(script_dir, "agent_configure.json")
        else:
            self.config_path = config_path
        self.config = self._load_config()

    def _load_config(self) -> Dict[str, Any]:
        """Load configuration from file"""
        # Check environment variable first, then config file, then default
        default_server_url = os.getenv("CYBERSENTINEL_SERVER_URL", "http://localhost:55000/api/v1")
        default_config = {
            "server_url": default_server_url,
            "agent_id": str(uuid.uuid4()),
            # Hostname, not a hardcoded person's name — the server keys the
            # agent record on (name, os) and a shared literal would make two
            # endpoints collapse into one record.
            "agent_name": socket.gethostname(),
            # Issued by the server on registration and sent as X-Agent-Key on
            # every subsequent call. Persisted here so a restart keeps it.
            "agent_key": "",
            "heartbeat_interval": 30,
            "policy_sync_interval": 60,
            "monitoring": {
                "file_system": True,
                # Fallback only. When the server's file_system_monitoring
                # policies carry monitoredPaths, those win — see
                # DLPAgent._resolve_monitored_paths(). Left empty so an agent
                # with no policy watches nothing rather than all of /home.
                "monitored_paths": [],
                "exclude_paths": [
                    "/proc", "/sys", "/dev", "/run", "/snap",
                    "/var/lib/docker", "/var/log",
                    "~/.cache", "~/.local/share", "~/.config",
                    "~/snap", "~/.mozilla", "~/.thunderbird",
                ],
                "file_extensions": [".pdf", ".docx", ".doc", ".xlsx", ".xls", ".csv", ".pptx", ".ppt", ".txt", ".json", ".xml", ".sql", ".zip", ".rar", ".7z", ".db", ".conf"]
            },
            "quarantine": {
                # Global quarantine toggle for this agent
                "enabled": True,
                # Default quarantine folder on Linux endpoints
                "folder": "/opt/cybersentinel/quarantine"
            },
            "classification": {
                "enabled": True,
                "max_file_size_mb": 10
            },
            "network": {
                # Network DLP mirrors the Windows agent: watch process
                # creation, inspect only the file a transfer tool actually
                # references, ask the server, then allow or kill. Never
                # touches file ownership or permissions.
                "enabled": True,
                # Poll interval used only when the netlink proc connector is
                # unavailable (agent not running as root).
                "scan_interval_seconds": 1.0,
                # Freeze a candidate with SIGSTOP while it is evaluated so the
                # upload cannot complete during the round trip to the server.
                "suspend_during_evaluation": True,
                # Extra process names to treat as transfer tools.
                "extra_watched_processes": [],
                # Never signalled, whatever a policy says. Server daemons and
                # session processes belong to the "inbound" channel and are not
                # user-initiated exfiltration.
                # sshd/smbd are DAEMONS — killing them drops unrelated
                # sessions. sftp-server is deliberately NOT here: it is the
                # per-transfer worker that actually reads the file for an SFTP
                # pull, so it must be stoppable or `scp host:file .` walks out.
                "never_terminate_processes": [
                    "sshd", "smbd", "nmbd", "systemd",
                    "dockerd", "containerd", "init", "NetworkManager",
                ],
                # Local file servers (python -m http.server and friends) hold
                # the file open while streaming it. Only inspected while the
                # process has a live remote connection on a policy-monitored
                # port.
                "inspect_local_file_servers": True,
                # Catch transfers by processes that were already running when
                # the agent started (browsers, long-lived uploaders) by pairing
                # live remote connections with open protected files.
                "egress_guard": True,
                "egress_scan_interval_seconds": 1.0,
                # Refuse network reads of individual sensitive files (fanotify
                # FAN_OPEN_PERM). This is what lets a file server keep serving
                # its harmless files while the sensitive ones are unreadable
                # over the network. Needs root.
                "file_read_guard": True,
                "file_read_guard_max_files": 500,
                "file_read_guard_refresh_seconds": 60,
                # Fallback ONLY for when the read guard is unavailable: stop a
                # file server that exposes protected data outright. Off by
                # default because it denies the whole directory, not just the
                # sensitive files.
                "block_file_servers": False,
                "max_inspect_bytes": 10485760,
            },
        }

        if os.path.exists(self.config_path):
            try:
                with open(self.config_path, 'r') as f:
                    loaded_config = json.load(f)
                default_config = self._deep_merge(default_config, loaded_config)
            except Exception as e:
                logger.error(f"Error loading config: {e}, using defaults")

        self._write(default_config)
        return default_config

    @staticmethod
    def _deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
        """Merge nested sections instead of replacing them wholesale, so a
        config that omits e.g. "network" still gets its defaults."""
        merged = dict(base)
        for key, value in (override or {}).items():
            if isinstance(value, dict) and isinstance(merged.get(key), dict):
                merged[key] = AgentConfig._deep_merge(merged[key], value)
            else:
                merged[key] = value
        return merged

    def _write(self, config: Dict[str, Any]):
        try:
            config_dir = os.path.dirname(self.config_path)
            if config_dir and not os.path.exists(config_dir):
                try:
                    os.makedirs(config_dir, exist_ok=True)
                except PermissionError:
                    # Fall back to current directory if can't create parent
                    self.config_path = os.path.basename(self.config_path)
            with open(self.config_path, 'w') as f:
                json.dump(config, f, indent=2)
            # The file holds the agent API key.
            try:
                os.chmod(self.config_path, 0o600)
            except Exception:
                pass
        except Exception as e:
            logger.warning(f"Could not save config: {e}")

    def save(self):
        """Persist the in-memory config (used after the server hands back the
        canonical agent_id and API key on registration)."""
        self._write(self.config)

    def get(self, key: str, default=None):
        """Get configuration value"""
        return self.config.get(key, default)

    def set(self, key: str, value):
        self.config[key] = value


class FileMonitorHandler(FileSystemEventHandler):
    """Handles file system events"""

    def __init__(self, agent):
        self.agent = agent
        super().__init__()

    def on_created(self, event: FileSystemEvent):
        """Handle file creation"""
        if not event.is_directory and self._should_monitor(event.src_path):
            self.agent.handle_file_event("file_created", event.src_path)

    def on_modified(self, event: FileSystemEvent):
        """Handle file modification"""
        if not event.is_directory and self._should_monitor(event.src_path):
            self.agent.handle_file_event("file_modified", event.src_path)

    def on_moved(self, event: FileSystemEvent):
        """Handle file move/rename"""
        if not event.is_directory and self._should_monitor(event.dest_path):
            self.agent.handle_file_event("file_moved", event.dest_path)

    def on_opened(self, event: FileSystemEvent):
        """A read of a watched file.

        This is NOT a DLP event on its own — every `cat`, editor, indexer and
        backup job opens files, and the previous build turned each one into a
        "network transfer" alert. It is only forwarded to the network module,
        which discards it unless a policy-monitored local file server actually
        has the file open and a live remote connection.
        """
        if not event.is_directory and self._should_monitor(event.src_path):
            self.agent.on_watched_file_read(event.src_path)

    def on_deleted(self, event: FileSystemEvent):
        """Handle file deletion"""
        if not event.is_directory and self._should_monitor(event.src_path):
            self.agent.handle_file_event("file_deleted", event.src_path)

    def _should_monitor(self, file_path: str) -> bool:
        """Check if file should be monitored"""
        if self.agent.is_excluded_path(file_path):
            return False

        # Extensions come from the matching server policy when it declares
        # them; the local config list is only a fallback.
        ext = Path(file_path).suffix.lower()
        policy_exts = self.agent.policy_file_extensions
        monitored_exts = policy_exts or self.agent.config.get("monitoring", {}).get("file_extensions", [])
        return ext in monitored_exts if monitored_exts else True


class TransferDestinationHandler(FileSystemEventHandler):
    """Handles file events on monitored destination paths (non-USB transfers)"""

    def __init__(self, agent):
        self.agent = agent
        super().__init__()

    def on_created(self, event: FileSystemEvent):
        if not event.is_directory:
            self.agent.handle_transfer_destination_event(event.src_path)

    def on_modified(self, event: FileSystemEvent):
        if not event.is_directory:
            self.agent.handle_transfer_destination_event(event.src_path)


class UsbTransferHandler(FileSystemEventHandler):
    """Handles file events on a mounted USB drive for USB file-transfer policies."""

    def __init__(self, agent, mountpoint: str):
        self.agent = agent
        self.mountpoint = mountpoint
        super().__init__()

    def on_created(self, event: FileSystemEvent):
        if not event.is_directory:
            self.agent.handle_usb_transfer_event(event.src_path, self.mountpoint)

    def on_moved(self, event: FileSystemEvent):
        if not event.is_directory:
            self.agent.handle_usb_transfer_event(event.dest_path, self.mountpoint)


class DLPAgent:
    """Main DLP Agent class"""

    def __init__(self, config_path: str = None):
        self.config = AgentConfig(config_path)
        self.dry_run = False
        self.agent_id = self.config.get("agent_id")
        self.agent_key = self.config.get("agent_key") or ""
        self.server_url = (self.config.get("server_url") or "").rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": f"CyberSentinelLinuxAgent/{AGENT_VERSION}"})
        self._apply_agent_key_header()
        self.running = False
        self.observers = []
        self.monitored_paths_set = set()  # Track which paths we're monitoring to prevent duplicates
        self.policy_bundle = None
        self.policy_file_paths: List[str] = []
        self.policy_file_extensions: List[str] = []
        self.file_transfer_policies: List[Dict[str, Any]] = []
        self.transfer_protected_paths: List[str] = []
        self.transfer_destination_paths: List[str] = []
        self.has_file_policies: bool = False
        self.has_file_transfer_policies: bool = False
        self.allow_events: bool = False
        self.active_policy_version: Optional[str] = None
        self.policy_sync_interval = self.config.get("policy_sync_interval", 60)
        # These keys are the ones POLICY_CAPABILITY_MAP in the server's
        # agent_policy_transformer looks up. Sending our own names meant the
        # lookup always missed and every policy type fell through to the
        # "unknown capability -> allow" default, so the flags were decorative.
        self.policy_capabilities = {
            "file_monitoring": bool(self.config.get("monitoring", {}).get("file_system", True)),
            "usb_monitoring": True,
            "clipboard_monitoring": True,
            "network_monitoring": bool(self.config.get("network", {}).get("enabled", True)),
            "print_monitoring": False,          # not implemented in this agent
            "screen_capture_monitoring": False,  # not implemented in this agent
            "policy_enforcement": True,
            "audit_logging": True,
        }
        self.last_policy_sync_at: Optional[str] = None
        self.last_policy_sync_status: str = "never"
        self.last_policy_sync_error: Optional[str] = None
        self.file_policies: List[Dict[str, Any]] = []
        self.transfer_observers: List[Observer] = []
        self.monitored_transfer_destinations_set = set()  # Track transfer destinations to prevent duplicates

        # ---- USB device / USB file-transfer policy state ----
        self.usb_device_policies: List[Dict[str, Any]] = []
        self.usb_transfer_policies: List[Dict[str, Any]] = []
        self.usb_protected_paths: List[str] = []
        self.has_usb_device_policies: bool = False
        self.has_usb_transfer_policies: bool = False
        self.usb_blocking_active: bool = False
        self.usb_monitor_interval: int = 2  # seconds between USB device polls
        self.known_usb_drives: Dict[str, Dict[str, str]] = {}  # /dev/sdX1 -> {mountpoint, disk, label}
        self.usb_transfer_observers: Dict[str, Observer] = {}  # mountpoint -> Observer
        self._usb_blacklist_file = "/etc/modprobe.d/cybersentinel-usb-block.conf"

        quarantine_cfg = self.config.get("quarantine", {})
        self.quarantine_enabled: bool = quarantine_cfg.get("enabled", False)
        self.quarantine_folder: Optional[str] = quarantine_cfg.get("folder")
        if self.quarantine_enabled and self.quarantine_folder:
            try:
                os.makedirs(self.quarantine_folder, exist_ok=True)
            except Exception as exc:
                # Do not disable quarantine; policies may supply an alternate folder.
                logger.warning(f"Could not create quarantine folder {self.quarantine_folder}: {exc}")
        # Ensure quarantine folder is excluded from monitoring to prevent loops
        if self.quarantine_folder:
            monitoring_cfg = self.config.get("monitoring", {}) or {}
            exclude_paths = monitoring_cfg.get("exclude_paths", []) or []
            if self.quarantine_folder not in exclude_paths:
                exclude_paths.append(self.quarantine_folder)
                monitoring_cfg["exclude_paths"] = exclude_paths
                # Persist back onto config dictionary safely
                if isinstance(self.config, AgentConfig) and isinstance(self.config.config, dict):
                    self.config.config["monitoring"] = monitoring_cfg
        
        # Deduplication: Track recent events to prevent duplicates
        self.recent_events = {}  # {(file_path, event_type): timestamp}
        self.dedup_window_seconds = 5  # Ignore duplicate events within 5 seconds (increased from 2)
        self.dedup_lock = threading.Lock()  # Lock for thread-safe deduplication

        # USB monitoring state tracking
        self.evaluated_usb_files = set()  # Track evaluated/ignored files on USB to avoid loops/false alerts
        self.has_classification_only_policies = False
        self._usb_event_times: Dict[Tuple[str, str], float] = {}  # debounce connect/disconnect flapping
        # ---- Clipboard policy state ----
        self.clipboard_policies: List[Dict[str, Any]] = []
        self.has_clipboard_policies: bool = False
        self.clipboard_monitor_thread: Optional[threading.Thread] = None
        self.clipboard_running: bool = False
        self.last_clipboard_content: str = ""

        # ---- Network DLP policy state ----
        network_cfg = self.config.get("network", {}) or {}
        self.network_cfg = network_cfg
        self.network_policies: List[Dict[str, Any]] = []
        self.has_network_policies: bool = False
        self.network_monitor_thread: Optional[threading.Thread] = None
        self.network_running: bool = False
        # Rules distilled from the active network_exfiltration_prevention
        # policies: which transfer methods / ports / data types the server
        # actually asked us to watch.
        self.network_methods: Set[str] = set()
        self.network_ports: Set[int] = set()
        self.network_data_types: Set[str] = set()
        self.network_block_on: Set[str] = set()
        self.network_direction: str = "outbound"
        self._net_seen_pids: Dict[int, float] = {}      # pid -> first seen
        self._net_handled: Set[Tuple[int, str]] = set()  # (pid, path) already decided
        self._recent_execs: Dict[int, List[Tuple[float, int, List[str]]]] = {}  # pgid -> recent execs
        self._net_lock = threading.Lock()
        self._net_boot_pids: Set[int] = set()            # PIDs alive at startup
        self._suspended_pids: Set[int] = set()           # frozen pending a verdict
        self._server_read_cooldown: Dict[str, float] = {}
        # ---- sensitive-file read guard (fanotify) state ----
        self._fan_fd: Optional[int] = None
        self._libc = None
        self._marked_files: Set[str] = set()
        self._sensitive_cache: Dict[str, Tuple[Tuple[int, int], bool]] = {}
        self._denied_reported: Dict[Tuple[int, str], float] = {}
        self.read_guard_active: bool = False
        self._never_terminate = {
            str(p).lower() for p in network_cfg.get("never_terminate_processes", []) or []
        }

        logger.info(f"Agent initialized: {self.agent_id} (v{AGENT_VERSION})")

    # ------------------------------------------------------------------
    # Shared helpers
    # ------------------------------------------------------------------

    def _apply_agent_key_header(self):
        """Attach X-Agent-Key so /policies/sync and /policy/evaluate authenticate.

        The server accepts an absent key for backward compatibility, so a
        missing key fails silently rather than loudly — hence sending it
        whenever we have one.
        """
        if self.agent_key:
            self.session.headers["X-Agent-Key"] = self.agent_key
        else:
            self.session.headers.pop("X-Agent-Key", None)

    def is_excluded_path(self, file_path: str) -> bool:
        """True when the path is under a configured exclusion, the quarantine
        folder, or the agent's own log/config."""
        try:
            normalized = os.path.normpath(os.path.abspath(file_path))
        except Exception:
            return True

        if self._is_in_quarantine(normalized):
            return True

        for own in (log_file, getattr(self.config, "config_path", "")):
            if own and normalized == os.path.normpath(os.path.abspath(own)):
                return True

        for exclude in self.config.get("monitoring", {}).get("exclude_paths", []) or []:
            if not exclude:
                continue
            # "/home/*/.cache" style globs never matched with the old
            # startswith(exclude.replace("*","")) test — it produced "/home/"
            # and excluded every home directory. Match per-segment instead.
            pattern = os.path.normpath(self._expand_path(str(exclude).replace("*", "__CS_STAR__")))
            pattern = pattern.replace("__CS_STAR__", "*")
            if "*" in pattern:
                import fnmatch
                if fnmatch.fnmatch(normalized, pattern) or fnmatch.fnmatch(normalized, pattern.rstrip("/") + "/*"):
                    return True
            elif normalized == pattern or normalized.startswith(pattern.rstrip("/") + os.sep):
                return True
        return False

    def start(self):
        """Start the agent"""
        logger.info("Starting CyberSentinel DLP Agent...")
        self.running = True

        # Register agent with server
        self.register_agent()
        self.sync_policies(initial=True)
        if self.policy_sync_interval:
            threading.Thread(target=self.policy_sync_loop, daemon=True).start()

        # Start file system monitoring
        if self.config.get("monitoring", {}).get("file_system", True) and self.has_file_policies:
            self.start_file_monitoring()

        # Start heartbeat
        threading.Thread(target=self.heartbeat_loop, daemon=True).start()

        # Start USB device monitoring (connect/disconnect + USB file transfer enforcement)
        threading.Thread(target=self.usb_monitor_loop, daemon=True, name="CS_UsbMonitor").start()

        # Start Network DLP (process-creation interception, mirroring the
        # Windows agent). Only runs while a network_exfiltration_prevention
        # policy is active — see network_monitor_loop.
        #
        # NOTE: the old "sensitive file protector" thread is gone. It walked
        # every monitored directory in a 0.1s loop, classified every file with
        # a local regex, and chown'd anything that matched to root:root 0600 —
        # which is what locked the files under test, and its own reads
        # generated the inotify storm that produced an event per file.
        # Enforcement now happens at the transfer, never on data at rest.
        threading.Thread(target=self.network_monitor_loop, daemon=True, name="CS_NetworkMonitor").start()

        # Per-file read guard: refuse network reads of sensitive files while
        # leaving everything else — and the serving process itself — alone.
        self.read_guard_active = self.start_read_guard()
        if self.read_guard_active:
            threading.Thread(target=self.refresh_sensitive_marks, daemon=True,
                             name="CS_MarkSeed").start()

        logger.info("Agent started successfully")

        # Keep main thread alive
        try:
            while self.running:
                time.sleep(1)
        except KeyboardInterrupt:
            logger.info("Shutting down agent...")
            self.stop()

    def unregister_agent(self):
        """Unregister agent from server"""
        try:
            response = self.session.delete(
                f"{self.server_url}/agents/{self.agent_id}/unregister",
                timeout=5
            )
            if response.status_code in [200, 204]:
                logger.info("Agent unregistered from server")
            else:
                logger.debug(f"Unregister response: {response.status_code}")
        except Exception as e:
            logger.debug(f"Failed to unregister agent: {e}")

    def stop(self):
        """Stop the agent"""
        if not self.running:
            return  # Already stopped
        
        self.running = False
        self.network_running = False

        # Release anything we suspended for evaluation, so a stop never leaves
        # a user's process frozen, and drop the fanotify fd so no process is
        # left waiting on a verdict that will never come.
        self._resume_all_suspended()
        self.stop_read_guard()

        # Unregister from server
        self.unregister_agent()

        # Stop file observers
        for observer in self.observers:
            observer.stop()
            observer.join()
        logger.info("Agent stopped")

        # Stop transfer observers
        for observer in self.transfer_observers:
            observer.stop()
            observer.join()
        self.transfer_observers = []

        # Stop USB transfer observers
        self._stop_all_usb_transfer_watches()

        # Stop Clipboard monitoring
        self.stop_clipboard_monitoring()

    def register_agent(self):
        """Register agent with server.

        The server is the authority on both the agent_id and the API key: it
        may return a different (canonical) id when this endpoint already has a
        record, and it issues the key that /policies/sync and /policy/evaluate
        authenticate with. Both are adopted and persisted here — the previous
        build discarded the response, so a config with a stale or mistyped
        agent_id kept 404-ing on policy sync and the agent ran with an empty
        policy set while still emitting events.
        """
        try:
            logged_in = self._logged_in_users()
            data = {
                "agent_id": self.agent_id,
                "name": self.config.get("agent_name") or socket.gethostname(),
                "hostname": socket.gethostname(),
                "os": "linux",
                # os_name = precise product ("Ubuntu 22.04.3 LTS"); os_version =
                # granular kernel release ("6.8.0-124-generic"). Previously
                # os_version carried the whole platform.platform() blob.
                "os_name": self._os_name(),
                "os_version": self._os_version_detail(),
                # All logged-in users; username = the primary/first for back-compat.
                "logged_in_users": logged_in,
                "username": logged_in[0] if logged_in else self._current_user(),
                # Use a real interface IP instead of hostname resolution to avoid 127.0.x/WSL artifacts
                "ip_address": self._get_real_ip_address(),
                "version": AGENT_VERSION,
                "capabilities": self.policy_capabilities
            }

            response = self.session.post(
                f"{self.server_url}/agents/",
                json=data,
                timeout=10
            )

            if response.status_code in [200, 201]:
                changed = False
                try:
                    body = response.json() or {}
                except Exception:
                    body = {}

                canonical_id = body.get("agent_id")
                if canonical_id and canonical_id != self.agent_id:
                    logger.warning(
                        f"Server assigned canonical agent_id {canonical_id} "
                        f"(local was {self.agent_id}); adopting it"
                    )
                    self.agent_id = canonical_id
                    self.config.set("agent_id", canonical_id)
                    changed = True

                api_key = body.get("api_key")
                if api_key and api_key != self.agent_key:
                    self.agent_key = api_key
                    self.config.set("agent_key", api_key)
                    self._apply_agent_key_header()
                    changed = True

                if changed:
                    self.config.save()
                logger.info(f"Agent registered with server as {self.agent_id}")
            else:
                logger.warning(f"Failed to register agent: {response.status_code} {response.text[:200]}")

        except Exception as e:
            logger.error(f"Error registering agent: {e}")

    def policy_sync_loop(self):
        while self.running and self.policy_sync_interval:
            time.sleep(self.policy_sync_interval)
            try:
                self.sync_policies()
            except Exception as exc:
                logger.debug(f"Policy sync loop error: {exc}")

    def sync_policies(self, initial: bool = False):
        try:
            logger.info("Syncing policy bundle", extra={"installed_version": self.active_policy_version})
            payload = {
                "platform": "linux",
                "capabilities": self.policy_capabilities,
            }
            if self.active_policy_version:
                payload["installed_version"] = self.active_policy_version

            response = self.session.post(
                f"{self.server_url}/agents/{self.agent_id}/policies/sync",
                json=payload,
                timeout=15,
            )
            if response.status_code == 404:
                # The configured agent_id is unknown to the server (mistyped id,
                # restored config, agent deleted in the console). Re-register to
                # obtain the canonical id, then retry once. Without this the
                # agent ran forever with zero policies.
                logger.warning("Policy sync returned 404 — re-registering agent")
                self.register_agent()
                response = self.session.post(
                    f"{self.server_url}/agents/{self.agent_id}/policies/sync",
                    json=payload,
                    timeout=15,
                )
            if response.status_code != 200:
                logger.warning(f"Policy sync failed ({response.status_code}): {response.text[:300]}")
                self.last_policy_sync_status = f"error_{response.status_code}"
                self.last_policy_sync_error = response.text[:500]
                self.last_policy_sync_at = datetime.utcnow().isoformat() + "Z"
                # A failed sync must not leave stale enforcement running.
                self._disable_all_enforcement("policy sync failed")
                return

            data = response.json()
            if data.get("status") == "up_to_date":
                logger.info(
                    "Agent policy bundle up to date",
                    extra={"version": self.active_policy_version or data.get("version")}
                )
                self.last_policy_sync_status = "up_to_date"
                self.last_policy_sync_error = None
                self.last_policy_sync_at = datetime.utcnow().isoformat() + "Z"
                return

            self.policy_bundle = data
            self.active_policy_version = data.get("version")
            self.last_policy_sync_status = "success"
            self.last_policy_sync_error = None
            self.last_policy_sync_at = datetime.utcnow().isoformat() + "Z"
            logger.info(
                "Policy bundle updated",
                extra={"version": self.active_policy_version, "count": data.get("policy_count")}
            )
            self._apply_policy_bundle()
        except Exception as e:
            log_method = logger.error if initial else logger.debug
            log_method(f"Failed to sync policies: {e}")
            self.last_policy_sync_status = "exception"
            self.last_policy_sync_error = str(e)
            self.last_policy_sync_at = datetime.utcnow().isoformat() + "Z"
            if initial:
                self._disable_all_enforcement("initial policy sync failed")

    def _disable_all_enforcement(self, reason: str):
        """Turn every channel off. Called when we have no trustworthy policy
        set — an agent that cannot reach the server must go quiet, not fall
        back to guesses about what should be blocked."""
        logger.warning(f"Disabling all enforcement: {reason}")
        self.allow_events = False
        self.has_file_policies = False
        self.has_file_transfer_policies = False
        self.has_usb_device_policies = False
        self.has_usb_transfer_policies = False
        self.has_clipboard_policies = False
        self.has_network_policies = False
        self.network_policies = []
        self.file_policies = []
        self.file_transfer_policies = []
        self.usb_transfer_policies = []
        self.usb_device_policies = []
        self.clipboard_policies = []
        self._reconcile_monitors()

    def _apply_policy_bundle(self):
        if not self.policy_bundle:
            return

        policies = self.policy_bundle.get("policies", {})

        def _enabled(key: str) -> List[Dict[str, Any]]:
            return [p for p in (policies.get(key) or []) if p.get("enabled", True)]

        file_policies = _enabled("file_system_monitoring")
        usb_device_policies = _enabled("usb_device_monitoring")
        usb_transfer_policies_raw = _enabled("usb_file_transfer_monitoring")
        file_transfer_policies = _enabled("file_transfer_monitoring")

        # Persist file policies for action handling
        self.file_policies = file_policies
        self.file_transfer_policies = self._normalize_file_transfer_policies(file_transfer_policies)
        self.usb_device_policies = usb_device_policies
        self.usb_transfer_policies = self._normalize_usb_transfer_policies(usb_transfer_policies_raw)

        # A usb_file_transfer policy with no monitoredPaths is content-gated:
        # it applies to whatever is copied to the drive, and the server decides
        # per file. It is NOT "treat every file as sensitive" — that reading is
        # what made a freshly inserted stick light up entirely. Such a policy
        # only ever escalates to block when /policy/evaluate says block.
        self.has_classification_only_policies = any(
            not policy.get("config", {}).get("monitoredPaths")
            for policy in self.usb_transfer_policies
        )
        if self.has_classification_only_policies:
            logger.info("Content-gated USB transfer policy active (server classifies each copied file)")

        # NOTE: usb_device_monitoring / usb_file_transfer_monitoring policies are NOT
        # generic filesystem paths to watch - they describe protected source
        # directories and USB device rules that are handled separately by the
        # USB monitor below. Mixing them into policy_file_paths (as before) caused
        # USB policies to be silently downgraded to plain "log" file-system events
        # and meant USB drives were never actually detected or blocked.
        new_paths: List[str] = []
        new_exts: List[str] = []
        for policy in file_policies:
            config = policy.get("config", {})
            new_paths.extend(config.get("monitoredPaths", []))
            new_exts.extend(config.get("fileExtensions", []) or [])
        # Policies are authored for a mixed fleet; a Windows path in a shared
        # policy is not a Linux path and scheduling a watch for it just logged
        # "Path does not exist" forever.
        self.policy_file_paths = [
            p for p in dict.fromkeys(new_paths) if self._is_plausible_linux_path(p)
        ]
        dropped = [p for p in dict.fromkeys(new_paths) if not self._is_plausible_linux_path(p)]
        if dropped:
            logger.info(f"Ignoring non-Linux monitored paths from policy: {dropped}")
        self.policy_file_extensions = [str(e).lower() for e in dict.fromkeys(new_exts) if e]

        # Policy presence flags
        self.clipboard_policies = _enabled("clipboard_monitoring")
        self.has_clipboard_policies = bool(self.clipboard_policies)

        # Network DLP. Only real network policy types count — the previous
        # build fell back to file_transfer_monitoring when the bundle carried
        # no network policy, so USB/file-copy rules silently became "network"
        # rules and the agent policed a channel nobody had configured.
        self.network_policies = (
            _enabled("network_exfiltration_prevention")
            + _enabled("network_exfiltration")
            + _enabled("network_monitoring")
            + _enabled("network_transfer_monitoring")
        )
        self.has_network_policies = bool(self.network_policies)
        self._rebuild_network_rules()

        self.has_file_policies = bool(file_policies)
        self.has_file_transfer_policies = bool(file_transfer_policies)
        self.has_usb_device_policies = bool(self.usb_device_policies)
        self.has_usb_transfer_policies = bool(self.usb_transfer_policies)
        self.allow_events = (
            self.has_file_policies
            or self.has_file_transfer_policies
            or self.has_usb_device_policies
            or self.has_usb_transfer_policies
            or self.has_clipboard_policies
            or self.has_network_policies
        )

        # Normalize protected/destination paths for transfer policies
        self.transfer_protected_paths = self._collect_transfer_paths(self.file_transfer_policies, key="protectedPaths")
        self.transfer_destination_paths = self._collect_transfer_paths(self.file_transfer_policies, key="monitoredDestinations")

        # Protected source paths for USB file-transfer detection (files that, if
        # found on a removable drive, trigger the configured USB transfer action)
        self.usb_protected_paths = list(dict.fromkeys(
            p for policy in self.usb_transfer_policies
            for p in policy.get("config", {}).get("monitoredPaths", [])
        ))

        # Determine whether any enabled USB device policy requires blocking USB
        # storage on connect, and transition blocking state accordingly.
        should_block_usb = any(
            (policy.get("config", {}).get("action", "alert").lower() == "block")
            and bool((policy.get("config", {}).get("events", {}) or {}).get("connect", True))
            for policy in self.usb_device_policies
        )
        self._reconcile_usb_blocking(should_block_usb)

        # Reconcile monitoring based on current policies
        self._reconcile_monitors()

    @staticmethod
    def _is_plausible_linux_path(path: str) -> bool:
        """Reject Windows paths that ride along in shared policies."""
        if not path:
            return False
        p = str(path).strip()
        if re.match(r"^[A-Za-z]:[\\/]", p) or p.startswith("\\\\"):
            return False
        return p.startswith("/") or p.startswith("~") or p.startswith("$")

    def _rebuild_network_rules(self):
        """Distil the active network policies into the matching surface the
        interceptor uses: which transfer methods, which destination ports,
        which data types, and which uninspectable states to block on."""
        methods: Set[str] = set()
        ports: Set[int] = set()
        data_types: Set[str] = set()
        block_on: Set[str] = set()
        direction = "outbound"

        for policy in self.network_policies:
            cfg = policy.get("config", {}) or {}
            for m in cfg.get("monitoredMethods", []) or []:
                methods.add(str(m).strip().lower())
            for port in cfg.get("monitoredPorts", []) or []:
                try:
                    ports.add(int(port))
                except (TypeError, ValueError):
                    continue
            for dt in cfg.get("dataTypes", []) or []:
                data_types.add(str(dt).strip().upper())
            for b in cfg.get("blockOn", []) or []:
                block_on.add(str(b).strip().lower())
            if cfg.get("direction"):
                direction = str(cfg["direction"]).strip().lower()

        self.network_methods = methods
        self.network_ports = ports
        self.network_data_types = data_types
        self.network_block_on = block_on
        self.network_direction = direction

        if self.has_network_policies:
            logger.info(
                "Network DLP armed: %d polic(ies), methods=%s, ports=%s",
                len(self.network_policies),
                sorted(methods) or "any",
                sorted(ports) or "any",
            )

    def _network_action_for(self, method: str, port: Optional[int]) -> Tuple[Optional[Dict[str, Any]], str]:
        """Return (policy, action) for the highest-precedence network policy
        that covers this transfer method and destination port.

        A policy that names monitoredMethods applies to those methods on ANY
        port. A policy that names only ports applies to those ports.

        The port list deliberately does NOT veto a method match. It used to,
        and that was a straight bypass: the shipped policies monitor
        8000/8080/8443 but not 8069, so `python3 -m http.server 8069` served
        Aadhaar and PAN files with the agent watching and saying nothing. A
        port number is chosen by whoever is moving the data, so it cannot be
        what decides whether we look. The server's own blocking conditions
        agree — they match on event_type and classification_level only.

        Returns (None, "ignore") when no policy covers the transfer at all; the
        agent then stays silent, which is the difference between DLP and noise.
        """
        rank = {"block": 3, "alert": 2, "log": 1}
        candidates: List[Tuple[Tuple[int, int], Dict[str, Any], str]] = []

        for policy in self.network_policies:
            cfg = policy.get("config", {}) or {}
            pol_methods = {str(m).strip().lower() for m in (cfg.get("monitoredMethods") or [])}
            pol_ports = set()
            for p in cfg.get("monitoredPorts") or []:
                try:
                    pol_ports.add(int(p))
                except (TypeError, ValueError):
                    continue

            if pol_methods:
                if method not in pol_methods:
                    continue
            elif pol_ports and port is not None and port not in pol_ports:
                # Port-only policy and we know the port: honour its scope.
                continue

            action = str(cfg.get("action") or "alert").lower()
            if action not in rank:
                action = "alert"
            candidates.append(((rank[action], int(policy.get("priority") or 0)), policy, action))

        if not candidates:
            return None, "ignore"

        _, policy, action = max(candidates, key=lambda c: c[0])
        return policy, action

    def _restart_file_monitoring(self):
        logger.info("Restarting file monitors with updated policies")
        for observer in self.observers:
            observer.stop()
            observer.join()
        self.observers = []
        self.start_file_monitoring()

    def _resolve_monitored_paths(self) -> List[str]:
        if self.policy_file_paths:
            return self.policy_file_paths
        monitoring_cfg = self.config.get("monitoring", {})
        return [p for p in (monitoring_cfg.get("monitored_paths") or []) if self._is_plausible_linux_path(p)]

    def _expand_path(self, path: str) -> str:
        expanded = os.path.expandvars(path or "")
        expanded = os.path.expanduser(expanded)
        return expanded

    def _normalize_file_transfer_policies(self, policies: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        normalized = []
        for policy in policies:
            cfg = dict(policy.get("config", {}))
            cfg["protectedPaths"] = [self._expand_path(p) for p in cfg.get("protectedPaths", []) if p]
            cfg["monitoredDestinations"] = [self._expand_path(p) for p in cfg.get("monitoredDestinations", []) if p]
            normalized.append({**policy, "config": cfg})
        return normalized

    def _normalize_usb_transfer_policies(self, policies: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        normalized = []
        for policy in policies:
            cfg = dict(policy.get("config", {}))
            cfg["monitoredPaths"] = [self._expand_path(p) for p in cfg.get("monitoredPaths", []) if p]
            normalized.append({**policy, "config": cfg})
        return normalized

    def _collect_transfer_paths(self, policies: List[Dict[str, Any]], key: str) -> List[str]:
        paths: List[str] = []
        for policy in policies:
            cfg = policy.get("config", {}) or {}
            paths.extend(cfg.get(key, []) or [])
        return list(dict.fromkeys(paths))

    def start_file_monitoring(self):
        """Start monitoring file system"""
        monitored_paths = self._resolve_monitored_paths()

        for path in monitored_paths:
            expanded_path = os.path.normpath(os.path.abspath(self._expand_path(path)))
            # Skip if already monitoring this exact path
            if expanded_path in self.monitored_paths_set:
                logger.debug(f"Already monitoring path: {expanded_path}, skipping")
                continue
                
            if os.path.exists(expanded_path):
                event_handler = FileMonitorHandler(self)
                observer = Observer()
                observer.schedule(event_handler, expanded_path, recursive=True)
                observer.start()
                self.observers.append(observer)
                self.monitored_paths_set.add(expanded_path)
                logger.info(f"Monitoring path: {expanded_path}")
            else:
                logger.warning(f"Path does not exist: {expanded_path}")

    def stop_file_monitoring(self):
        """Stop all file observers."""
        for observer in self.observers:
            observer.stop()
            observer.join()
        self.observers = []
        self.monitored_paths_set.clear()
        logger.info("File monitoring stopped")

    def start_transfer_monitoring(self):
        """Start monitoring destination paths for non-USB file transfers."""
        if not self.has_file_transfer_policies:
            return
        if not self.transfer_destination_paths:
            logger.warning("No monitored destinations configured for transfer policies")
            return

        for path in self.transfer_destination_paths:
            expanded_path = os.path.normpath(os.path.abspath(self._expand_path(path)))
            # Skip if already monitoring this exact path
            if expanded_path in self.monitored_transfer_destinations_set:
                logger.debug(f"Already monitoring transfer destination: {expanded_path}, skipping")
                continue
                
            if os.path.exists(expanded_path):
                handler = TransferDestinationHandler(self)
                observer = Observer()
                observer.schedule(handler, expanded_path, recursive=True)
                observer.start()
                self.transfer_observers.append(observer)
                self.monitored_transfer_destinations_set.add(expanded_path)
                logger.info(f"Monitoring transfer destination: {expanded_path}")
            else:
                logger.warning(f"Destination path does not exist: {expanded_path}")

    def stop_transfer_monitoring(self):
        """Stop all transfer destination observers."""
        for observer in self.transfer_observers:
            observer.stop()
            observer.join()
        self.transfer_observers = []
        self.monitored_transfer_destinations_set.clear()
        logger.info("Transfer destination monitoring stopped")

    def _reconcile_monitors(self):
        """Start or stop monitors based on active policies."""
        if getattr(self, "dry_run", False):
            # --dump-policies resolves the bundle without touching the endpoint.
            return

        if self.has_file_policies:
            # Check if we need to restart monitoring (paths may have changed)
            monitored_paths = self._resolve_monitored_paths()
            expanded_new = {os.path.normpath(os.path.abspath(self._expand_path(p))) for p in monitored_paths}
            
            # If paths don't match, restart monitoring
            if self.monitored_paths_set != expanded_new:
                if self.monitored_paths_set:
                    logger.info(f"Monitored paths changed (old: {self.monitored_paths_set}, new: {expanded_new}), restarting file monitoring")
                    self.stop_file_monitoring()
                self.start_file_monitoring()
            elif not self.observers:
                self.start_file_monitoring()
        else:
            if self.observers:
                self.stop_file_monitoring()

        if self.has_file_transfer_policies:
            # Check if transfer destinations changed
            expanded_new = {os.path.normpath(os.path.abspath(self._expand_path(p))) for p in self.transfer_destination_paths}
            
            if self.monitored_transfer_destinations_set != expanded_new:
                if self.monitored_transfer_destinations_set:
                    logger.info(f"Transfer destinations changed (old: {self.monitored_transfer_destinations_set}, new: {expanded_new}), restarting transfer monitoring")
                    self.stop_transfer_monitoring()
                self.start_transfer_monitoring()
            elif not self.transfer_observers:
                self.start_transfer_monitoring()
        else:
            if self.transfer_observers:
                self.stop_transfer_monitoring()

        # USB file-transfer watchers follow whichever USB drives are currently
        # known to be connected (tracked by usb_monitor_loop).
        if self.has_usb_transfer_policies:
            for dev, info in list(self.known_usb_drives.items()):
                mountpoint = info.get("mountpoint")
                if mountpoint and os.path.normpath(mountpoint) not in self.usb_transfer_observers:
                    # A policy that arrives while a drive is already mounted
                    # must not treat that drive's existing contents as fresh
                    # copies — take the inventory before watching.
                    self._mark_existing_usb_files_as_processed(mountpoint)
                    self._start_usb_transfer_watch(mountpoint)
        else:
            self._stop_all_usb_transfer_watches()

        # Reconcile clipboard monitoring
        if self.has_clipboard_policies:
            self.start_clipboard_monitoring()
        else:
            self.stop_clipboard_monitoring()

    def _is_in_quarantine(self, file_path: str) -> bool:
        """Check if the file resides in the quarantine folder to avoid loops."""
        if not self.quarantine_enabled or not self.quarantine_folder:
            return False
        try:
            return os.path.commonpath([os.path.abspath(file_path), os.path.abspath(self.quarantine_folder)]) == os.path.abspath(self.quarantine_folder)
        except Exception:
            return False

    def _get_quarantine_destination(self, source_path: str) -> str:
        """Compute destination path for a quarantined file."""
        basename = Path(source_path).name
        timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%S")
        unique_name = f"{timestamp}_{uuid.uuid4().hex[:8]}_{basename}"
        return str(Path(self.quarantine_folder) / unique_name)

    def quarantine_file(self, source_path: str, override_folder: Optional[str] = None) -> Optional[str]:
        """Move a file into the quarantine folder. Honors a policy-specified folder when provided."""
        target_folder = override_folder or self.quarantine_folder
        if not target_folder:
            logger.warning(f"No quarantine folder configured; cannot quarantine {source_path}")
            return None
        if not os.path.exists(source_path):
            logger.debug(f"File to quarantine does not exist: {source_path}")
            return None

        try:
            os.makedirs(target_folder, exist_ok=True)
            dest_path = str(Path(target_folder) / Path(self._get_quarantine_destination(source_path)).name)
            shutil.move(source_path, dest_path)
            logger.warning(f"File quarantined: {source_path} -> {dest_path}")
            return dest_path
        except Exception as exc:
            logger.error(f"Failed to quarantine file {source_path}: {exc}", exc_info=True)
            return None

    def block_file_transfer(self, file_path: str, must_be_under: Optional[str] = None) -> bool:
        """Delete the copy at the destination as a blocking action.

        ``must_be_under`` confines the deletion to the transfer destination
        (the USB mountpoint, the monitored destination directory). Without it
        a mis-resolved path could delete a source file the user still needs.
        """
        try:
            target = os.path.normpath(os.path.abspath(file_path))
            if must_be_under:
                root = os.path.normpath(os.path.abspath(must_be_under))
                if target != root and not target.startswith(root.rstrip(os.sep) + os.sep):
                    logger.error(
                        f"Refusing to delete {target}: outside the transfer destination {root}"
                    )
                    return False
            os.remove(target)
            logger.warning(f"Blocked and deleted file: {target}")
            return True
        except FileNotFoundError:
            logger.info(f"File already removed before block: {file_path}")
            return True
        except Exception as exc:
            logger.error(f"Failed to delete file during block: {exc}")
            return False

    @staticmethod
    def _wait_until_stable(file_path: str, checks: int = 3, interval: float = 0.4) -> bool:
        """Wait for a file's size to stop changing before inspecting it.

        A copy in progress fires inotify repeatedly; hashing a partial file
        produces a hash that never matches its source, so a genuinely
        protected file looked like an unknown one.
        """
        last_size = -1
        stable = 0
        for _ in range(checks * 8):
            try:
                size = os.path.getsize(file_path)
            except FileNotFoundError:
                return False
            except Exception:
                return False
            if size == last_size:
                stable += 1
                if stable >= checks:
                    return True
            else:
                stable = 0
                last_size = size
            time.sleep(interval)
        return os.path.exists(file_path)

    def _usb_policy_extensions(self) -> Set[str]:
        """File extensions any active USB transfer policy restricts itself to."""
        exts: Set[str] = set()
        for policy in self.usb_transfer_policies:
            cfg = policy.get("config", {}) or {}
            declared = cfg.get("fileExtensions") or []
            if not declared:
                # One unrestricted policy means "any extension".
                return set()
            for e in declared:
                e = str(e).strip().lower()
                exts.add(e if e.startswith(".") else f".{e}")
        return exts

    def _find_source_file_in_dirs(self, search_dirs: List[str], file_hash: str, file_size: int, file_name: str) -> Optional[str]:
        """Find matching file by hash/size/name within provided directories or specific file paths."""
        if not file_hash or not search_dirs:
            return None
        for root_dir in search_dirs:
            try:
                # If root_dir is a specific file, check it directly
                if os.path.isfile(root_dir):
                    if os.path.basename(root_dir) == file_name:
                        try:
                            candidate_size = os.path.getsize(root_dir)
                            if candidate_size == file_size:
                                candidate_hash = self._calculate_file_hash(root_dir)
                                if candidate_hash and candidate_hash == file_hash:
                                    return root_dir
                        except Exception:
                            pass
                    continue

                # Otherwise, walk the directory
                for root, dirs, files in os.walk(root_dir):
                    if file_name in files:
                        candidate_path = os.path.join(root, file_name)
                        try:
                            candidate_size = os.path.getsize(candidate_path)
                            if candidate_size != file_size:
                                continue
                        except Exception:
                            continue
                        candidate_hash = self._calculate_file_hash(candidate_path)
                        if candidate_hash and candidate_hash == file_hash:
                            return candidate_path
            except Exception:
                continue
        return None

    def _match_file_policy(self, file_path: str) -> Optional[Dict[str, Any]]:
        """Find the first file system policy whose monitoredPaths include the file."""
        for policy in self.file_policies:
            config = policy.get("config", {})
            monitored_paths = config.get("monitoredPaths", [])
            for path in monitored_paths:
                expanded = self._expand_path(path)
                if file_path.startswith(expanded):
                    return policy
        return None

    def _match_file_transfer_policy(self, source_path: str, dest_path: str) -> Optional[Dict[str, Any]]:
        """Find matching non-USB transfer policy for a given source/destination pair."""
        if not self.file_transfer_policies:
            return None
        for policy in self.file_transfer_policies:
            cfg = policy.get("config", {}) or {}
            protected_paths = cfg.get("protectedPaths", [])
            dest_paths = cfg.get("monitoredDestinations", [])
            if any(source_path.startswith(self._expand_path(p)) for p in protected_paths) and \
               any(dest_path.startswith(self._expand_path(d)) for d in dest_paths):
                return policy
        return None

    # ==================== USB Device Monitoring ====================
    # Linux has no equivalent of Windows' WM_DEVICECHANGE, so we poll
    # /sys/block + /proc/mounts for removable USB storage. This covers
    # both "usb_device_monitoring" (whole-device connect/disconnect,
    # optionally blocking the device) and "usb_file_transfer_monitoring"
    # (watching mounted USB drives for protected files and blocking /
    # quarantining / alerting on them), mirroring the Windows agent.

    def usb_monitor_loop(self):
        """Poll for USB removable-drive connect/disconnect events."""
        while self.running:
            try:
                self._poll_usb_devices()
            except Exception as exc:
                logger.debug(f"USB monitor loop error: {exc}")
            time.sleep(self.usb_monitor_interval)

    def _list_usb_removable_partitions(self) -> Dict[str, Dict[str, str]]:
        """Enumerate mounted partitions that live on removable USB storage."""
        result: Dict[str, Dict[str, str]] = {}
        block_root = "/sys/block"
        if not os.path.isdir(block_root):
            return result

        mount_map: Dict[str, str] = {}
        try:
            with open("/proc/mounts", "r") as f:
                for line in f:
                    parts = line.split()
                    if len(parts) < 2:
                        continue
                    dev, mountpoint = parts[0], parts[1]
                    mount_map[dev] = mountpoint.replace("\\040", " ")
        except Exception as exc:
            logger.debug(f"Could not read /proc/mounts: {exc}")

        try:
            disks = os.listdir(block_root)
        except Exception as exc:
            logger.debug(f"Could not list {block_root}: {exc}")
            return result

        for disk in disks:
            disk_path = os.path.join(block_root, disk)
            try:
                with open(os.path.join(disk_path, "removable"), "r") as f:
                    removable = f.read().strip() == "1"
            except Exception:
                removable = False
            if not removable:
                continue

            # Only treat it as a USB drive if its device path actually
            # routes through the USB subsystem (excludes some internal
            # removable-flagged media such as certain MMC/NVMe readers).
            try:
                real_path = os.path.realpath(disk_path)
            except Exception:
                real_path = disk_path
            if "usb" not in real_path and "loop" not in real_path:
                continue

            label = disk
            try:
                with open(os.path.join(disk_path, "device", "model"), "r") as f:
                    model = f.read().strip()
                    if model:
                        label = model
            except Exception:
                pass

            candidates = [disk]
            try:
                for entry in os.listdir(disk_path):
                    if entry.startswith(disk) and os.path.isdir(os.path.join(disk_path, entry)):
                        candidates.append(entry)
            except Exception:
                pass

            for part in candidates:
                dev_node = f"/dev/{part}"
                mountpoint = mount_map.get(dev_node)
                # Detect USB device connection even if not mounted yet
                result[dev_node] = {
                    "mountpoint": mountpoint or "",
                    "disk": disk,
                    "label": label,
                }

        return result

    def _poll_usb_devices(self):
        """Diff currently-mounted USB drives against known state and dispatch
        arrival/removal handling."""
        current = self._list_usb_removable_partitions()
        current_devs = set(current.keys())
        known_devs = set(self.known_usb_drives.keys())

        # 1. Handle removals
        for dev in known_devs - current_devs:
            info = self.known_usb_drives.pop(dev, {})
            self._handle_usb_removal(dev, info)

        # 2. Handle arrivals and mount/unmount transitions
        for dev in current_devs:
            current_info = current[dev]
            known_info = self.known_usb_drives.get(dev)

            if not known_info:
                # Fresh arrival
                self.known_usb_drives[dev] = current_info
                self._handle_usb_arrival(dev, current_info)
            else:
                # Device is already connected, check for mount transitions
                old_mount = known_info.get("mountpoint", "")
                new_mount = current_info.get("mountpoint", "")
                if not old_mount and new_mount:
                    logger.info(f"USB drive {dev} transitioned from unmounted to mounted: {new_mount}")
                    self.known_usb_drives[dev] = current_info
                    self._handle_usb_arrival(dev, current_info)
                elif old_mount and not new_mount:
                    logger.info(f"USB drive {dev} was unmounted: {old_mount}")
                    self._handle_usb_removal(dev, known_info)
                    self.known_usb_drives[dev] = current_info

    def _match_usb_device_policy(self, event_name: str):
        """Return (policy, action) for the best enabled usb_device_monitoring
        policy that watches the given event ('connect' or 'disconnect').
        Precedence: block > alert > log."""
        matched_policies = []
        for policy in self.usb_device_policies:
            cfg = policy.get("config", {}) or {}
            events = cfg.get("events", {}) or {}
            watches = bool(events.get(event_name, True)) if events else True
            if watches:
                matched_policies.append(policy)

        if not matched_policies:
            return None, "log"

        action_rank = {"block": 3, "alert": 2, "log": 1}

        def get_policy_rank(p):
            cfg = p.get("config", {}) or {}
            act = (cfg.get("action") or "alert").lower()
            rank = action_rank.get(act, 1)
            priority = p.get("priority", 0) or 0
            return (rank, priority)

        best_policy = max(matched_policies, key=get_policy_rank)
        best_action = (best_policy.get("config", {}).get("action") or "alert").lower()
        return best_policy, best_action

    def _deauthorize_usb_device_node(self, dev_node: str, authorize: bool = False) -> bool:
        """Best-effort deauthorize USB device via sysfs to disable it."""
        try:
            dev_name = os.path.basename(dev_node)  # e.g., "sdb1" or "sdb"
            import re
            m = re.match(r'^([a-zA-Z]+)\d*$', dev_name)
            if m:
                disk_name = m.group(1)
            else:
                disk_name = dev_name
                
            block_dir = f"/sys/class/block/{disk_name}"
            if not os.path.exists(block_dir):
                block_dir = f"/sys/class/block/{dev_name}"
                if not os.path.exists(block_dir):
                    return False
            
            real_path = os.path.realpath(block_dir)
            parts = real_path.split("/")
            usb_dev_dir = None
            for p in parts:
                if "-" in p and not ":" in p:
                    candidate = f"/sys/bus/usb/devices/{p}"
                    if os.path.exists(candidate) and os.path.exists(f"{candidate}/authorized"):
                        usb_dev_dir = candidate
            
            if usb_dev_dir:
                val = "1" if authorize else "0"
                with open(f"{usb_dev_dir}/authorized", "w") as f:
                    f.write(val)
                logger.warning(f"Best-effort deauthorized USB device via sysfs: {usb_dev_dir} -> {val}")
                return True
        except Exception as exc:
            logger.debug(f"Failed to deauthorize device for {dev_node}: {exc}")
        return False

    def _mark_existing_usb_files_as_processed(self, mountpoint: str):
        """Mark all existing files on newly connected USB drive as evaluated to prevent false positives."""
        try:
            marked_count = 0
            for root, _dirs, files in os.walk(mountpoint):
                for name in files:
                    full_path = os.path.join(root, name)
                    normalized_path = os.path.normpath(os.path.abspath(full_path))
                    self.evaluated_usb_files.add(normalized_path)
                    marked_count += 1
            if marked_count > 0:
                logger.info(f"Marked {marked_count} pre-existing files on USB drive {mountpoint} as evaluated/ignored")
        except Exception as exc:
            logger.debug(f"Error marking existing USB files: {exc}")

    # Maps our event_type to the destination_type the server's policy
    # evaluator matches on. Everything used to be sent as "removable_drive",
    # so a network transfer and a clipboard copy were both evaluated as if
    # they were USB copies.
    _DESTINATION_TYPES = {
        "usb_file_transfer": "removable_drive",
        "file_transfer": "local_path",
        "network_exfil": "network",
        "clipboard": "clipboard",
    }

    def evaluate_policy_realtime(
        self,
        file_name: str,
        file_path: str,
        dest_path: str,
        event_type: str = "usb_file_transfer",
        clipboard_content: Optional[str] = None,
        network_context: Optional[Dict[str, Any]] = None,
        destination_type: Optional[str] = None,
        inspection_skipped: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Query server-side classification evaluation API for real-time decision.

        The file is sent as ``file_content_b64`` (raw bytes) rather than a
        utf-8-with-errors-ignored decode. The server extracts real text from
        pdf/docx/xlsx/pptx that way; decoding compressed bytes into a string
        produced garbage that either classified as Public or tripped every
        pattern at random.
        """
        result = {
            "action": "allow",
            "reason": "Default allow",
            "classification": {
                "level": "Public",
                "confidence": 0.0,
                "total_matches": 0,
                "matched_rules": []
            },
            "extraction_status": "readable",
            "evaluation_succeeded": False
        }

        payload: Dict[str, Any] = {
            "file_name": file_name,
            "event_type": event_type,
            "destination_type": destination_type or self._DESTINATION_TYPES.get(event_type, "network"),
            "source_path": file_path or "",
            "destination_path": dest_path or "",
        }

        try:
            if inspection_skipped:
                # We know something is being transferred but cannot see it —
                # an anonymous pipe, a stream we have no handle on. Saying so
                # lets the server's "block uninspectable content" policy rule,
                # instead of an unread stream defaulting to Public and going out.
                payload["inspection_skipped"] = inspection_skipped
                payload["file_size"] = 0
            elif clipboard_content is not None:
                payload["file_content"] = clipboard_content
                payload["file_size"] = len(clipboard_content.encode("utf-8", errors="ignore"))
            else:
                if not file_path or not os.path.exists(file_path):
                    result["reason"] = "File not found"
                    return result

                file_size = os.path.getsize(file_path)
                payload["file_size"] = file_size
                max_bytes = int(self.config.get("classification", {}).get("max_file_size_mb", 10)) * 1024 * 1024

                if file_size > max_bytes:
                    # Do NOT silently allow. The server has a policy for
                    # content it could not inspect ("Block Oversized
                    # Uninspected Files"); tell it the truth and let it rule.
                    logger.info(f"{file_name} exceeds the inspection cap ({file_size} bytes); reporting as uninspectable")
                    payload["inspection_skipped"] = "too_large"
                else:
                    try:
                        with open(file_path, "rb") as f:
                            payload["file_content_b64"] = base64.b64encode(f.read(max_bytes)).decode("ascii")
                    except Exception as e:
                        logger.warning(f"Could not read {file_path} for classification: {e}")
                        payload["inspection_skipped"] = "unreadable"

            if network_context:
                payload.update({k: v for k, v in network_context.items() if v not in (None, "")})

            logger.debug(f"Querying real-time policy evaluation for {file_name}")
            response = self.session.post(
                f"{self.server_url}/agents/{self.agent_id}/policy/evaluate",
                json=payload,
                timeout=15
            )

            if response.status_code == 200:
                data = response.json()
                result["action"] = data.get("action", "allow")
                result["reason"] = data.get("reason", "API success")
                result["classification"] = data.get("classification", result["classification"])
                result["alert_severity"] = data.get("alert_severity")
                result["policies_triggered"] = data.get("policies_triggered", [])
                result["extraction_status"] = data.get("extraction_status", "readable")
                result["evaluation_succeeded"] = True
                logger.info(
                    "Server decision for %s: %s (classification=%s)",
                    file_name, result["action"].upper(),
                    result["classification"].get("level", "unknown"),
                )
            else:
                # Fail-open on transport problems, but mark the evaluation as
                # failed so callers fall back to the policy's own action rather
                # than treating "allow" as a real verdict.
                logger.warning(f"Real-time evaluation returned HTTP {response.status_code}: {response.text[:200]}")
                result["reason"] = f"API HTTP {response.status_code}"
        except Exception as e:
            logger.error(f"Error in evaluate_policy_realtime: {e}")
            result["reason"] = f"Exception: {str(e)}"
        return result

    def _match_usb_transfer_policy_by_classification(self) -> Optional[Dict[str, Any]]:
        """Find the best enabled usb_file_transfer_monitoring policy that is classification-based (empty monitoredPaths).
        Precedence: block > quarantine > alert > log."""
        matched_policies = []
        for policy in self.usb_transfer_policies:
            cfg = policy.get("config", {}) or {}
            if not cfg.get("monitoredPaths"):
                matched_policies.append(policy)

        if not matched_policies:
            return None

        action_rank = {"block": 4, "quarantine": 3, "alert": 2, "log": 1}

        def get_policy_rank(p):
            cfg = p.get("config", {}) or {}
            # A policy that states no action is a monitoring policy. Defaulting
            # it to "block" (as before) meant several description-only server
            # policies silently outranked the real ones and deleted files.
            act = (cfg.get("action") or "alert").lower()
            rank = action_rank.get(act, 1)
            priority = p.get("priority", 0) or 0
            return (rank, priority)

        return max(matched_policies, key=get_policy_rank)

    def _usb_event_is_duplicate(self, dev: str, kind: str, window: float = 15.0) -> bool:
        """Suppress connect/disconnect flapping.

        One physical stick presents a disk plus one partition per volume, and
        udisks mounts them a moment after the block device appears — so a
        single insertion produced several arrivals. Keyed on the physical
        device so all of its partitions collapse into one event.
        """
        base = re.sub(r"\d+$", "", os.path.basename(dev))
        key = (base, kind)
        now = time.time()
        last = self._usb_event_times.get(key, 0)
        self._usb_event_times[key] = now
        return (now - last) < window

    def _handle_usb_arrival(self, dev: str, info: Dict[str, str]):
        logger.info(f"USB drive connected: {dev} -> {info.get('mountpoint')} ({info.get('label')})")
        if not self.allow_events or not self.has_usb_device_policies:
            return

        policy, action = self._match_usb_device_policy("connect")
        if policy is None:
            return

        blocked = False
        if action == "block":
            blocked = self._block_usb_storage()
            # Also best-effort deauthorize device via sysfs
            self._deauthorize_usb_device_node(dev)
            # Best-effort: also unmount this specific drive immediately
            self._unmount_usb_drive(info.get("mountpoint"), dev)

        if not self._usb_event_is_duplicate(dev, "connect"):
            self._send_usb_event("usb_blocked" if blocked else "usb_connected", dev, info, policy, blocked)

        # Mark pre-existing files on USB drive so they are ignored/not alerts
        mountpoint = info.get("mountpoint")
        if mountpoint and not blocked:
            self._mark_existing_usb_files_as_processed(mountpoint)

        # Watch this drive for files copied onto it. Started only after the
        # pre-existing inventory is recorded, so the drive's own contents are
        # never mistaken for a transfer.
        if self.has_usb_transfer_policies and mountpoint and not blocked:
            self._start_usb_transfer_watch(mountpoint)

    def _handle_usb_removal(self, dev: str, info: Dict[str, str]):
        logger.info(f"USB drive disconnected: {dev} ({info.get('mountpoint')})")
        mountpoint = info.get("mountpoint")
        if mountpoint:
            self._stop_usb_transfer_watch(mountpoint)
            # Clean up evaluated_usb_files under this mountpoint
            normalized_mount = os.path.normpath(os.path.abspath(mountpoint))
            self.evaluated_usb_files = {
                path for path in self.evaluated_usb_files
                if not path.startswith(normalized_mount)
            }
        if self.allow_events and self.has_usb_device_policies:
            policy, _action = self._match_usb_device_policy("disconnect")
            if policy is not None and not self._usb_event_is_duplicate(dev, "disconnect"):
                self._send_usb_event("usb_disconnected", dev, info, policy, blocked=False)

    def _get_usb_device_details(self, dev_node: str) -> Dict[str, str]:
        """Extract vendor_id, product_id, serial_number, manufacturer,
        product_name, volume_label, volume_serial, file_system, capacity_bytes
        using udevadm and sysfs."""
        details = {
            "vendor_id": "unknown",
            "product_id": "unknown",
            "serial_number": "unknown",
            "manufacturer": "unknown",
            "product_name": "unknown",
            "volume_label": "",
            "volume_serial": "",
            "file_system": "",
            "capacity_bytes": "0",
        }
        try:
            # Query udevadm properties
            import subprocess
            res = subprocess.run(
                ["udevadm", "info", "--query=property", f"--name={dev_node}"],
                capture_output=True, text=True, timeout=3
            )
            if res.returncode == 0:
                for line in res.stdout.splitlines():
                    if "=" not in line:
                        continue
                    key, val = line.split("=", 1)
                    key = key.strip()
                    val = val.strip()
                    if key == "ID_VENDOR_ID":
                        # Prefix with VID_ as required by server/dashboard
                        details["vendor_id"] = f"VID_{val.upper()}"
                    elif key == "ID_MODEL_ID":
                        # Prefix with PID_ as required by server/dashboard
                        details["product_id"] = f"PID_{val.upper()}"
                    elif key == "ID_SERIAL_SHORT":
                        details["serial_number"] = val
                    elif key == "ID_VENDOR":
                        details["manufacturer"] = val
                    elif key == "ID_MODEL":
                        details["product_name"] = val
                    elif key == "ID_FS_LABEL":
                        details["volume_label"] = val
                    elif key == "ID_FS_UUID":
                        details["volume_serial"] = val
                    elif key == "ID_FS_TYPE":
                        details["file_system"] = val.upper()

            # Fallback to sysfs for capacity and basic details if needed
            dev_name = os.path.basename(dev_node) # e.g. "sdb" or "sdb1"
            import re
            m = re.match(r'^([a-zA-Z]+)\d*$', dev_name)
            disk_name = m.group(1) if m else dev_name

            # Read capacity from sysfs block layer
            size_path = f"/sys/class/block/{disk_name}/size"
            if os.path.exists(size_path):
                with open(size_path, "r") as f:
                    sectors = int(f.read().strip())
                    details["capacity_bytes"] = str(sectors * 512)

        except Exception as e:
            logger.debug(f"Failed to query device details for {dev_node}: {e}")

        return details

    def _send_usb_event(self, event_subtype: str, device: str, info: Dict[str, str],
                         policy: Optional[Dict[str, Any]], blocked: bool):
        current_user = self._event_user()
        label = info.get("label", device)
        mountpoint = info.get("mountpoint", "")

        # Extract rich device details (VID, PID, serial, manufacturer, model, etc.)
        details = self._get_usb_device_details(device)

        # Determine severity based on policy action / policy severity
        policy_severity = policy.get("severity") if policy else None
        policy_action = (policy.get("config", {}).get("action") or "").lower() if policy else ""

        if policy_severity:
            severity = policy_severity
        elif blocked:
            severity = "critical"
        elif policy_action == "alert":
            severity = "high"
        elif policy_action == "block":
            severity = "critical"
        else:
            severity = "medium" if event_subtype == "usb_connected" else "low"

        usb_event_type = "connect" if event_subtype in ("usb_connected", "usb_blocked") else "disconnect"

        # Determine friendly device name for display (use volume label or product model if available)
        friendly_name = details.get("volume_label") or details.get("product_name") or label

        event_data = {
            "event_id": str(uuid.uuid4()),
            "event_type": "usb",
            "event_subtype": event_subtype,
            "usb_event_type": usb_event_type,
            "agent_id": self.agent_id,
            "source_type": "agent",
            "user_email": f"{current_user}@{socket.gethostname()}",
            "username": current_user,
            "description": f"USB device {event_subtype.replace('usb_', '')}: {friendly_name}",
            "severity": severity,
            "action": "blocked" if blocked else ("alerted" if policy_action == "alert" else "logged"),
            "device_id": device,
            "device_name": friendly_name,
            "mount_point": mountpoint,
            "blocked": blocked,
            "timestamp": datetime.utcnow().isoformat(),

            # Populate detailed USB properties for dashboard
            "vendor_id": details.get("vendor_id"),
            "product_id": details.get("product_id"),
            "serial_number": details.get("serial_number"),
            "manufacturer": details.get("manufacturer"),
            "product_name": details.get("product_name") or label,
            "volume_label": details.get("volume_label") or label,
            "volume_serial": details.get("volume_serial"),
            "file_system": details.get("file_system"),
            "capacity_bytes": details.get("capacity_bytes"),
        }
        if policy and policy.get("id"):
            event_data["policy_id"] = policy.get("id")
            event_data["policy_name"] = policy.get("name")
            event_data["matched_policies"] = [policy.get("id")]
        if self.active_policy_version:
            event_data["policy_version"] = self.active_policy_version

        self.send_event(event_data)

    def _reconcile_usb_blocking(self, should_block: bool):
        """Transition USB storage blocking state to match current policy."""
        if should_block and not self.usb_blocking_active:
            self._block_usb_storage()
        elif not should_block and self.usb_blocking_active:
            logger.warning("USB blocking policy removed or changed to non-blocking; restoring USB access")
            self._unblock_usb_storage()

            # Enable all deauthorized USB ports
            for dev in list(self.known_usb_drives.keys()):
                self._deauthorize_usb_device_node(dev, authorize=True)

    def _block_usb_storage(self) -> bool:
        """Best-effort block of USB mass-storage: unload usb_storage and
        blacklist it so newly-inserted drives can't mount. Requires root."""
        if self.usb_blocking_active:
            return True

        success = False
        try:
            subprocess.run(["modprobe", "-r", "usb_storage"], check=False,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            success = True
        except Exception as exc:
            logger.debug(f"Could not unload usb_storage module: {exc}")

        try:
            os.makedirs(os.path.dirname(self._usb_blacklist_file), exist_ok=True)
            with open(self._usb_blacklist_file, "w") as f:
                f.write("# Managed by CyberSentinel DLP agent - do not edit\n")
                f.write("blacklist usb_storage\n")
                f.write("install usb_storage /bin/false\n")
            success = True
        except PermissionError:
            logger.error("Permission denied writing USB blacklist file; run agent as root to enforce USB blocking")
        except Exception as exc:
            logger.warning(f"Could not write USB blacklist file: {exc}")

        if success:
            self.usb_blocking_active = True
            logger.warning("USB mass storage blocked by policy")
        return success

    def _unblock_usb_storage(self) -> bool:
        """Restore USB mass-storage access."""
        try:
            if os.path.exists(self._usb_blacklist_file):
                os.remove(self._usb_blacklist_file)
        except Exception as exc:
            logger.warning(f"Could not remove USB blacklist file: {exc}")

        try:
            subprocess.run(["modprobe", "usb_storage"], check=False,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as exc:
            logger.debug(f"Could not reload usb_storage module: {exc}")

        self.usb_blocking_active = False
        logger.info("USB mass storage access restored")
        return True

    def _unmount_usb_drive(self, mountpoint: Optional[str], dev: str):
        """Best-effort unmount of a specific drive right after it was blocked."""
        if not mountpoint:
            return
        try:
            subprocess.run(["umount", mountpoint], check=False,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            logger.warning(f"Unmounted blocked USB drive: {mountpoint}")
        except Exception as exc:
            logger.debug(f"Could not unmount {mountpoint} ({dev}): {exc}")

    # ---- USB file transfer enforcement (protected files copied to a USB drive) ----

    def _start_usb_transfer_watch(self, mountpoint: str):
        normalized = os.path.normpath(mountpoint)
        if not os.path.isdir(normalized) or normalized in self.usb_transfer_observers:
            return
        handler = UsbTransferHandler(self, normalized)
        observer = Observer()
        try:
            observer.schedule(handler, normalized, recursive=True)
            observer.start()
            self.usb_transfer_observers[normalized] = observer
            logger.info(f"Monitoring USB drive for protected file transfers: {normalized}")
        except Exception as exc:
            logger.warning(f"Could not watch USB mount {normalized}: {exc}")

    def _stop_usb_transfer_watch(self, mountpoint: str):
        normalized = os.path.normpath(mountpoint)
        observer = self.usb_transfer_observers.pop(normalized, None)
        if observer:
            try:
                observer.stop()
                observer.join()
            except Exception:
                pass
            logger.info(f"Stopped monitoring USB drive: {normalized}")

    def _stop_all_usb_transfer_watches(self):
        for mountpoint in list(self.usb_transfer_observers.keys()):
            self._stop_usb_transfer_watch(mountpoint)

    def _scan_usb_mount_for_protected_files(self, mountpoint: str):
        """Scan is deprecated/handled by pre-existing file marking on arrival."""
        pass

    def _match_usb_transfer_policy(self, source_path: str) -> Optional[Dict[str, Any]]:
        """Find the best enabled usb_file_transfer_monitoring policy whose
        protected paths include the given (matched) source file.
        Precedence: block > quarantine > alert > log."""
        matched_policies = []
        for policy in self.usb_transfer_policies:
            cfg = policy.get("config", {}) or {}
            protected_paths = cfg.get("monitoredPaths", [])
            if any(source_path.startswith(p) for p in protected_paths):
                matched_policies.append(policy)

        if not matched_policies:
            return None

        action_rank = {"block": 4, "quarantine": 3, "alert": 2, "log": 1}

        def get_policy_rank(p):
            cfg = p.get("config", {}) or {}
            # A policy that states no action is a monitoring policy. Defaulting
            # it to "block" (as before) meant several description-only server
            # policies silently outranked the real ones and deleted files.
            act = (cfg.get("action") or "alert").lower()
            rank = action_rank.get(act, 1)
            priority = p.get("priority", 0) or 0
            return (rank, priority)

        return max(matched_policies, key=get_policy_rank)

    def handle_usb_transfer_event(self, dest_path: str, mountpoint: str):
        """Handle a file appearing on a monitored USB drive: check it against
        protected source paths and take the configured USB transfer action
        (block/quarantine/alert) using real-time policy evaluation."""
        try:
            if not self.allow_events or not self.has_usb_transfer_policies:
                return
            if not os.path.exists(dest_path) or os.path.isdir(dest_path):
                return

            normalized_dest_path = os.path.normpath(os.path.abspath(dest_path))

            # Check if this file has already been evaluated/ignored
            if normalized_dest_path in self.evaluated_usb_files:
                logger.debug(f"Skipping duplicate evaluation for pre-existing file: {normalized_dest_path}")
                return

            file_name = Path(dest_path).name
            if file_name.startswith(".") or file_name.endswith((".swp", ".tmp", ".part", ".crdownload", "~")):
                # Editor/copy scratch files. The real file lands separately.
                self.evaluated_usb_files.add(normalized_dest_path)
                return

            # A usb_file_transfer policy that names fileExtensions only applies
            # to those. Filtering here keeps the drive's own metadata
            # (System Volume Information, .Trash-1000, autorun files) out of
            # the evaluation path entirely.
            allowed_exts = self._usb_policy_extensions()
            if allowed_exts and Path(file_name).suffix.lower() not in allowed_exts:
                logger.debug(f"{file_name} is outside the USB policy's fileExtensions; ignoring")
                self.evaluated_usb_files.add(normalized_dest_path)
                return

            # Wait for the copy to settle before hashing — a growing file
            # hashes differently on every inotify event.
            if not self._wait_until_stable(dest_path):
                return

            file_size = os.path.getsize(dest_path)
            file_hash = self._calculate_file_hash(dest_path)
            if not file_hash:
                return

            # Find if this file came from a protected source directory
            source_file = self._find_source_file_in_dirs(self.usb_protected_paths, file_hash, file_size, file_name)
            
            policy = None
            if source_file:
                policy = self._match_usb_transfer_policy(source_file)
            
            # If no source file matches but we have classification-only policies, evaluate it
            if not policy and self.has_classification_only_policies:
                policy = self._match_usb_transfer_policy_by_classification()
                # In this case, treat dest_path as the source file for classification
                source_file = dest_path

            if not policy:
                # File does not match protected source directories and classification policies are inactive
                self.evaluated_usb_files.add(normalized_dest_path)
                return

            # Real-time policy evaluation via classification API. The file on
            # the stick is what we send — it is the copy that would leave the
            # building, and it exists whether or not we can find its source.
            eval_result = self.evaluate_policy_realtime(
                file_name, dest_path, dest_path, event_type="usb_file_transfer"
            )

            cfg = policy.get("config", {}) or {}
            policy_action = (cfg.get("action") or "alert").lower()
            quarantine_path: Optional[str] = None
            event_action = "logged"
            blocked = False

            classification_meta = eval_result.get("classification", {}) or {}
            labels_str = self._labels_from_matched_rules(classification_meta.get("matched_rules", []))
            level = classification_meta.get("level", "Public")
            severity = eval_result.get("alert_severity") or classification_meta.get("level") or "medium"
            confidence = classification_meta.get("confidence", 0.0)

            if eval_result.get("evaluation_succeeded", False):
                server_action = str(eval_result.get("action", "allow")).lower()
                if server_action == "block" and policy_action in ("block", "quarantine"):
                    if policy_action == "quarantine":
                        target_folder = cfg.get("quarantinePath") or self.quarantine_folder
                        quarantine_path = self.quarantine_file(dest_path, target_folder)
                        blocked = bool(quarantine_path)
                        event_action = "quarantined" if blocked else "logged"
                    else:
                        # Blocking a USB copy means removing the copy on the
                        # stick. If the user MOVED the file, put the original
                        # back first so blocking never destroys their only copy.
                        safe_to_delete = True
                        if source_file and source_file != dest_path and not os.path.exists(source_file):
                            try:
                                logger.warning(f"File was moved to USB; restoring source copy: {source_file}")
                                os.makedirs(os.path.dirname(source_file), exist_ok=True)
                                shutil.copy2(dest_path, source_file)
                            except Exception as restore_err:
                                logger.error(
                                    f"Failed to restore moved file ({restore_err}); "
                                    f"alerting instead of deleting the only remaining copy"
                                )
                                safe_to_delete = False

                        if safe_to_delete:
                            blocked = self.block_file_transfer(dest_path, must_be_under=mountpoint)
                            event_action = "blocked" if blocked else "logged"
                        else:
                            event_action = "alerted"
                            self.evaluated_usb_files.add(normalized_dest_path)
                elif server_action == "block":
                    # Policy is alert/log only — report it, do not destroy it.
                    event_action = "alerted"
                    self.evaluated_usb_files.add(normalized_dest_path)
                else:
                    event_action = "allowed"
                    self.evaluated_usb_files.add(normalized_dest_path)
            else:
                # No verdict from the server. Deleting or quarantining a user's
                # file on a guess is not acceptable — the previous build did
                # exactly that whenever the API timed out. Alert instead, and
                # say so in the event.
                logger.warning(
                    "Server evaluation unavailable for %s; alerting instead of enforcing %s",
                    file_name, policy_action,
                )
                local_classification = self._classify_content(
                    self._read_file_content(dest_path, max_bytes=200000)
                )
                labels_str = self._labels_in_scope(
                    local_classification.get("labels", []),
                    {str(d).upper() for d in (cfg.get("dataTypes") or [])},
                )
                severity = local_classification.get("severity", "medium")
                confidence = local_classification.get("score", 0.0)
                level = "Confidential" if labels_str else "Public"
                event_action = "alerted" if labels_str else "logged"
                self.evaluated_usb_files.add(normalized_dest_path)
                if not labels_str:
                    # Nothing detected and no server opinion: nothing to report.
                    return

            # An allowed, unclassified file is not an incident. Reporting one
            # event per file copied is how a routine backup to a stick turned
            # into hundreds of "sensitive" rows.
            if event_action == "allowed" and not labels_str and level in ("", "Public"):
                logger.debug(f"USB copy allowed with no classification: {file_name}")
                return

            current_user = self._event_user()

            severity_mapped = str(severity).lower()
            if severity_mapped not in ["low", "medium", "high", "critical"]:
                severity_mapped = "medium"

            event_data = {
                "event_id": str(uuid.uuid4()),
                "event_type": "usb",
                "event_subtype": "usb_transfer_blocked" if blocked else ("usb_transfer_allowed" if event_action == "allowed" else "usb_transfer_attempt"),
                "agent_id": self.agent_id,
                "source_type": "agent",
                "user_email": f"{current_user}@{socket.gethostname()}",
                "username": current_user,
                "description": f"USB file transfer {event_action}: {file_name} -> {dest_path} (Reason: {eval_result.get('reason', 'Policy check')})",
                "severity": "critical" if blocked else severity_mapped,
                "action": event_action,
                "file_path": source_file or dest_path,
                "file_name": file_name,
                "file_size": file_size,
                "file_hash": file_hash,
                "classification": {
                    "labels": labels_str,
                    "severity": severity_mapped,
                    "score": confidence,
                    "method": "realtime_api" if eval_result.get("evaluation_succeeded") else "regex"
                },
                "classification_level": level,
                "classification_labels": labels_str,
                "source_path": source_file or dest_path,
                "destination": dest_path,
                "destination_type": "usb_drive",
                "mount_point": mountpoint,
                "transfer_type": "usb_file_transfer",
                "blocked": blocked,
                "timestamp": datetime.utcnow().isoformat(),
                "policy_id": policy.get("id"),
                "policy_name": policy.get("name"),
                "policy_action": policy_action,
                "matched_policies": [policy.get("id")] if policy.get("id") else [],
            }

            if quarantine_path:
                event_data["quarantined"] = blocked
                event_data["quarantine_path"] = quarantine_path
                event_data["quarantine_timestamp"] = datetime.utcnow().isoformat() + "Z"
                event_data["quarantine_reason"] = "usb_file_transfer_policy"

            if self.active_policy_version:
                event_data["policy_version"] = self.active_policy_version

            self.send_event(event_data)

        except Exception as e:
            logger.error(f"Error handling USB transfer event: {e}", exc_info=True)

    def handle_file_event(self, event_type: str, file_path: str):
        """Handle file system event"""
        try:
            if not self.allow_events or not self.has_file_policies:
                return
            if self._is_in_quarantine(file_path):
                logger.debug(f"Skipping event inside quarantine folder: {file_path}")
                return
            # Deduplication: Check if we recently sent an event for this file/type
            # Use normalized path for deduplication to handle path variations
            normalized_path = os.path.normpath(os.path.abspath(file_path))
            now = time.time()
            dedup_key = (normalized_path, event_type)
            
            # Thread-safe deduplication check
            with self.dedup_lock:
                # Check for exact duplicate (same path + same event type)
                if dedup_key in self.recent_events:
                    last_sent = self.recent_events[dedup_key]
                    if now - last_sent < self.dedup_window_seconds:
                        logger.debug(f"Skipping duplicate event: {event_type} - {file_path} (last sent {now - last_sent:.2f}s ago)")
                        return
                
                # Special case: Suppress file_modified events that occur immediately after file_created
                # (watchdog fires both when creating a file with echo/write operations)
                if event_type == "file_modified":
                    created_key = (normalized_path, "file_created")
                    if created_key in self.recent_events:
                        time_since_created = now - self.recent_events[created_key]
                        if time_since_created < 1.0:  # Suppress modified events within 1 second of creation
                            logger.info(f"Suppressing file_modified event immediately after file_created: {file_path} ({time_since_created:.3f}s)")
                            return
                    else:
                        logger.debug(f"file_modified event for {file_path} - no recent file_created found")
                
                # For file_created events, record IMMEDIATELY to prevent race conditions with file_modified
                # This ensures file_modified checks will see the file_created entry
                if event_type == "file_created":
                    self.recent_events[dedup_key] = now
                    logger.debug(f"Recorded file_created event for deduplication: {file_path} at {now}")
                
                # Clean up old entries (keep only recent 100 entries)
                if len(self.recent_events) > 100:
                    cutoff = now - self.dedup_window_seconds
                    self.recent_events = {k: v for k, v in self.recent_events.items() if v > cutoff}

            if not os.path.exists(file_path):
                logger.debug(f"File missing at event time; skipping: {file_path}")
                return
            
            # Get file info
            file_size = os.path.getsize(file_path)
            max_size = self.config.get("classification", {}).get("max_file_size_mb", 10) * 1024 * 1024

            if file_size > max_size:
                logger.debug(f"File too large, skipping: {file_path}")
                return

            # Calculate file hash
            file_hash = self._calculate_file_hash(file_path)

            # Read content for classification
            content = self._read_file_content(file_path, max_bytes=100000)
            content_snippet = content[:5000] if content else None

            # Classify content
            classification = self._classify_content(content)

            # Determine matching policy and action
            matched_policy = self._match_file_policy(file_path)
            policy_config = matched_policy.get("config", {}) if matched_policy else {}
            policy_action = policy_config.get("action", "log").lower()
            event_action = "logged"
            quarantine_path: Optional[str] = None
            quarantine_timestamp: Optional[str] = None

            # File system monitoring is detection-only: ignore block/quarantine
            if policy_action not in {"alert", "log"}:
                policy_action = "log"

            # Do not apply destructive actions on delete events (avoids removing source during moves)
            if event_type == "file_deleted":
                event_action = "logged"
            elif policy_action == "alert":
                event_action = "alert"

            current_user = self._event_user()

            # Send event to server
            event_data = {
                "event_id": str(uuid.uuid4()),
                "event_type": "file",
                "event_subtype": event_type,
                "agent_id": self.agent_id,
                "source_type": "agent",
                "user_email": f"{current_user}@{socket.gethostname()}",
                "username": current_user,
                "description": f"{event_type}: {Path(file_path).name}",
                "severity": classification.get("severity", "low"),
                "action": event_action,
                "file_path": file_path,
                "file_name": Path(file_path).name,
                "file_size": file_size,
                "file_hash": file_hash,
                "classification": classification,
                "source_path": file_path,
                "content": content_snippet,
                "timestamp": datetime.utcnow().isoformat()
            }

            if matched_policy and matched_policy.get("id"):
                event_data["policy_id"] = matched_policy.get("id")
                event_data["matched_policies"] = [matched_policy.get("id")]
            if quarantine_path:
                event_data["quarantined"] = True
                event_data["quarantine_path"] = quarantine_path
                event_data["quarantine_timestamp"] = quarantine_timestamp

            if self.active_policy_version:
                event_data["policy_version"] = self.active_policy_version

            # Record non-created events now (file_created was already recorded above to prevent race conditions)
            if event_type != "file_created":
                with self.dedup_lock:
                    self.recent_events[dedup_key] = now
                    # Clean up old entries
                    if len(self.recent_events) > 100:
                        cutoff = now - self.dedup_window_seconds
                        self.recent_events = {k: v for k, v in self.recent_events.items() if v > cutoff}
            
            # Keep the read guard's marks in step with the file's new content:
            # a rewritten file is a new inode and loses its old mark.
            if self.read_guard_active and event_type in ("file_created", "file_modified", "file_moved"):
                threading.Thread(target=self.on_guarded_file_changed,
                                 args=(file_path,), daemon=True).start()

            # Now send the event
            self.send_event(event_data)

        except Exception as e:
            logger.error(f"Error handling file event: {e}")

    def handle_transfer_destination_event(self, dest_path: str):
        """Handle file events on monitored destination paths (non-USB transfers)."""
        try:
            if not self.allow_events or not self.has_file_transfer_policies:
                return
            if not os.path.exists(dest_path):
                return

            file_name = Path(dest_path).name
            if self.is_excluded_path(dest_path) or file_name.startswith("."):
                return
            if not self._wait_until_stable(dest_path):
                return

            file_size = os.path.getsize(dest_path)
            file_hash = self._calculate_file_hash(dest_path)
            if not file_hash:
                return

            source_file = self._find_source_file_in_dirs(self.transfer_protected_paths, file_hash, file_size, file_name)
            if not source_file:
                return

            policy = self._match_file_transfer_policy(source_file, dest_path)
            if not policy:
                return

            # Real-time policy evaluation via classification API
            eval_result = self.evaluate_policy_realtime(file_name, dest_path, dest_path, event_type="file_transfer")

            cfg = policy.get("config", {}) or {}
            policy_action = (cfg.get("action") or "alert").lower()
            quarantine_path: Optional[str] = None
            event_action = "logged"
            blocked = False

            if eval_result.get("evaluation_succeeded", False):
                server_action = str(eval_result.get("action", "allow")).lower()
                if server_action == "block" and policy_action in ("block", "quarantine"):
                    if policy_action == "quarantine":
                        target_folder = cfg.get("quarantinePath") or self.quarantine_folder
                        quarantine_path = self.quarantine_file(dest_path, target_folder)
                        blocked = bool(quarantine_path)
                        event_action = "quarantined" if blocked else "logged"
                    else:
                        # Confine the delete to the monitored destination so a
                        # bad match can never remove the protected original.
                        destination_root = next(
                            (d for d in self.transfer_destination_paths
                             if os.path.abspath(dest_path).startswith(os.path.abspath(self._expand_path(d)))),
                            None,
                        )
                        blocked = self.block_file_transfer(
                            dest_path, must_be_under=self._expand_path(destination_root) if destination_root else None
                        )
                        event_action = "blocked" if blocked else "logged"
                elif server_action == "block":
                    event_action = "alerted"
                else:
                    event_action = "allowed"
            else:
                # Same rule as USB: no server verdict means no destructive
                # action. Alert on what the local classifier can prove, and
                # stay silent when it proves nothing.
                logger.warning(
                    "Server evaluation unavailable for %s; alerting instead of enforcing %s",
                    file_name, policy_action,
                )
                local = self._classify_content(self._read_file_content(dest_path, max_bytes=200000))
                if not local.get("labels"):
                    return
                event_action = "alerted"

            if event_action == "allowed":
                # A permitted copy of a file the server classified as Public is
                # routine activity, not an incident.
                return

            current_user = self._event_user()

            event_data = {
                "event_id": str(uuid.uuid4()),
                "event_type": "file",
                "event_subtype": "transfer_blocked" if blocked else ("transfer_allowed" if event_action == "allowed" else "transfer_attempt"),
                "agent_id": self.agent_id,
                "source_type": "agent",
                "user_email": f"{current_user}@{socket.gethostname()}",
                "username": current_user,
                "description": f"File transfer {'blocked' if blocked else 'detected'}: {Path(source_file).name} -> {dest_path}",
                "severity": "critical" if blocked else "high",
                "action": event_action,
                "file_path": source_file,
                "file_name": Path(source_file).name,
                "file_size": file_size,
                "file_hash": file_hash,
                "classification": {
                    "labels": self._labels_from_matched_rules(
                        (eval_result.get("classification") or {}).get("matched_rules", [])
                    ),
                    "severity": "critical" if blocked else "high",
                    "score": (eval_result.get("classification") or {}).get("confidence", 0.0),
                    "method": "realtime_api" if eval_result.get("evaluation_succeeded") else "regex",
                },
                "classification_level": (eval_result.get("classification") or {}).get("level", "Public"),
                "source_path": source_file,
                "destination": dest_path,
                "destination_type": "endpoint_destination",
                "transfer_type": "file_transfer",
                "blocked": blocked,
                "timestamp": datetime.utcnow().isoformat(),
                "policy_id": policy.get("id") if policy else None,
                "policy_name": policy.get("name") if policy else None,
                "policy_action": policy_action,
                "matched_policies": [policy.get("id")] if policy and policy.get("id") else [],
            }

            if quarantine_path:
                event_data["quarantined"] = blocked
                event_data["quarantine_path"] = quarantine_path
                event_data["quarantine_timestamp"] = datetime.utcnow().isoformat() + "Z"
                event_data["quarantine_reason"] = "file_transfer_policy"

            if self.active_policy_version:
                event_data["policy_version"] = self.active_policy_version

            self.send_event(event_data)

        except Exception as e:
            logger.error(f"Error handling transfer destination event: {e}")

    # ---- Local classification (fallback only) -------------------------
    #
    # The server's ClassificationEngine is the authority; this runs only when
    # /policy/evaluate could not be reached, and it is deliberately strict.
    # The previous version tripped on almost any file: it ran these patterns
    # over printable strings scraped out of *binary* content, and the patterns
    # themselves were loose enough that ordinary text matched — which is why a
    # freshly inserted USB stick reported every file as sensitive.

    # Either an unbroken 13-19 digit run, or the standard grouped layouts with
    # ONE consistent separator. Allowing a separator between every digit (as a
    # first pass did) matched hyphenated coordinate and reference data such as
    # /usr/share/zoneinfo/zone.tab.
    _RE_CREDIT_CARD = re.compile(
        r'(?<![\d\-])(?:'
        r'\d{13,19}'                               # 4111111111111111
        r'|\d{4}([ -])\d{4}\1\d{4}\1\d{1,7}'       # 4111 1111 1111 1111
        r'|\d{4}([ -])\d{6}\2\d{5}'                # amex 3782 822463 10005
        r')(?![\d\-])'
    )
    _RE_PAN = re.compile(r'(?<![A-Z0-9])[A-Z]{5}[0-9]{4}[A-Z](?![A-Z0-9])')
    _RE_AADHAAR = re.compile(r'(?<![0-9])[2-9][0-9]{3}[ -]?[0-9]{4}[ -]?[0-9]{4}(?![0-9])')
    _RE_IFSC = re.compile(r'(?<![A-Z0-9])[A-Z]{4}0[A-Z0-9]{6}(?![A-Z0-9])')
    _RE_PHONE_IN = re.compile(r'(?<![0-9])(?:\+91[ -]?)?[6-9][0-9]{9}(?![0-9])')
    _RE_PASSPORT = re.compile(r'(?<![A-Z0-9])[A-PR-WY][0-9]{7}(?![A-Z0-9])')
    _RE_SSN = re.compile(r'(?<![0-9])(?!000|666|9)[0-9]{3}-(?!00)[0-9]{2}-(?!0000)[0-9]{4}(?![0-9])')
    _RE_EMAIL = re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b')
    _RE_AWS_KEY = re.compile(r'\b(?:AKIA|ASIA)[0-9A-Z]{16}\b')
    _RE_API_KEY = re.compile(
        r'\b(?:sk_live_[0-9a-zA-Z]{24,}'
        r'|gh[pousr]_[0-9A-Za-z]{36,}'
        r'|xox[baprs]-[0-9A-Za-z-]{10,})\b'
        r'|\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*[\'"]?[A-Za-z0-9_\-/+]{16,}'
    )
    _RE_PRIVATE_KEY = re.compile(r'-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----')
    _RE_DB_CONN = re.compile(r'\b(?:jdbc:\w+|mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mssql|redis)://[^\s\'"<>]{3,}', re.IGNORECASE)
    _RE_UPI = re.compile(r'\b[a-zA-Z0-9._-]{3,}@(?:paytm|ybl|okaxis|okicici|oksbi|okhdfcbank|ibl|axl|upi|apl)\b', re.IGNORECASE)

    # Severity of each label, used to derive the overall severity honestly
    # instead of the old "anything matched -> critical".
    _LABEL_SEVERITY = {
        "CREDIT_CARD": "critical",
        "SSN": "critical",
        "AADHAAR": "critical",
        "PRIVATE_KEY": "critical",
        "PAN_CARD": "high",
        "PASSPORT": "high",
        "AWS_KEY": "high",
        "API_KEY": "high",
        "DB_CONNECTION_STRING": "high",
        # Definitive banking identifiers — kept in step with the server rules
        # ("Indian IFSC Code" / "UPI ID" at weight 0.8, strong signals).
        "IFSC": "high",
        "UPI_ID": "high",
        "PHONE": "medium",
        "EMAIL": "low",
        "CUSTOM_REGEX": "critical",
    }
    _SEVERITY_RANK = {"low": 1, "medium": 2, "high": 3, "critical": 4}

    @staticmethod
    def _luhn_ok(digits: str) -> bool:
        """Card numbers must pass Luhn. Without this every 16-digit run —
        order numbers, timestamps, binary noise — read as a credit card."""
        if not 13 <= len(digits) <= 19 or not digits.isdigit():
            return False
        total, alt = 0, False
        for ch in reversed(digits):
            d = ord(ch) - 48
            if alt:
                d *= 2
                if d > 9:
                    d -= 9
            total += d
            alt = not alt
        return total % 10 == 0

    # Verhoeff tables — Aadhaar's checksum. A plain "12 digits starting 2-9"
    # test matches roughly one in ten random 12-digit runs.
    _VERHOEFF_D = (
        (0, 1, 2, 3, 4, 5, 6, 7, 8, 9), (1, 2, 3, 4, 0, 6, 7, 8, 9, 5),
        (2, 3, 4, 0, 1, 7, 8, 9, 5, 6), (3, 4, 0, 1, 2, 8, 9, 5, 6, 7),
        (4, 0, 1, 2, 3, 9, 5, 6, 7, 8), (5, 9, 8, 7, 6, 0, 4, 3, 2, 1),
        (6, 5, 9, 8, 7, 1, 0, 4, 3, 2), (7, 6, 5, 9, 8, 2, 1, 0, 4, 3),
        (8, 7, 6, 5, 9, 3, 2, 1, 0, 4), (9, 8, 7, 6, 5, 4, 3, 2, 1, 0),
    )
    _VERHOEFF_P = (
        (0, 1, 2, 3, 4, 5, 6, 7, 8, 9), (1, 5, 7, 6, 2, 8, 3, 0, 9, 4),
        (5, 8, 0, 3, 7, 9, 6, 1, 4, 2), (8, 9, 1, 6, 0, 4, 3, 5, 2, 7),
        (9, 4, 5, 3, 1, 2, 6, 8, 7, 0), (4, 2, 8, 6, 5, 7, 3, 9, 0, 1),
        (2, 7, 9, 3, 8, 0, 6, 4, 1, 5), (7, 0, 4, 6, 9, 1, 3, 2, 5, 8),
    )

    @classmethod
    def _verhoeff_ok(cls, digits: str) -> bool:
        if len(digits) != 12 or not digits.isdigit():
            return False
        c = 0
        for i, ch in enumerate(reversed(digits)):
            c = cls._VERHOEFF_D[c][cls._VERHOEFF_P[i % 8][ord(ch) - 48]]
        return c == 0

    @staticmethod
    def _looks_like_text(content: str) -> bool:
        """Reject content that is really binary. Classifying the printable
        fragments of a .so / .jpg / .zip is how unrelated files acquired
        PAN_CARD and IFSC labels."""
        if not content:
            return False
        sample = content[:4096]
        printable = sum(1 for ch in sample if ch.isprintable() or ch in "\r\n\t")
        return (printable / len(sample)) >= 0.85

    def _classify_content(self, content: str, custom_patterns: Optional[List[str]] = None) -> Dict[str, Any]:
        """Classify text for sensitive data. Fallback for when the server
        cannot be reached — returns labels only for validated matches."""
        empty = {"labels": [], "severity": "low", "score": 0.0, "method": "regex", "match_counts": {}}
        if not content or not self._looks_like_text(content):
            return empty

        counts: Dict[str, int] = {}

        def add(label: str, n: int = 1):
            if n:
                counts[label] = counts.get(label, 0) + n

        # Checksum-validated identifiers first.
        cc_hits = 0
        for m in self._RE_CREDIT_CARD.finditer(content):
            if self._luhn_ok(re.sub(r"[ -]", "", m.group(0))):
                cc_hits += 1
        add("CREDIT_CARD", cc_hits)

        # A 12-digit run counts as an Aadhaar when it either passes the Verhoeff
        # checksum (a real number, wherever it appears) or is explicitly
        # labelled as one. Requiring the checksum alone disagreed with the
        # server, which matches the bare pattern: a file reading
        # "AADHAR NO:- 629950180909" is plainly an Aadhaar record even though
        # that test number fails the checksum. Requiring neither would flag
        # every order number and timestamp.
        aadhaar_hits = 0
        for m in self._RE_AADHAAR.finditer(content):
            digits = re.sub(r"[ -]", "", m.group(0))
            if self._verhoeff_ok(digits):
                aadhaar_hits += 1
                continue
            window = content[max(0, m.start() - 64):m.end() + 32].lower()
            if any(k in window for k in ("aadhaar", "aadhar", "uidai", "uid no", "uid:")):
                aadhaar_hits += 1
        add("AADHAAR", aadhaar_hits)

        # Structural identifiers. Case-sensitive on purpose: a lowercase
        # 5-letters-4-digits-1-letter run is an ordinary word/hash fragment,
        # not a PAN.
        add("PAN_CARD", len(self._RE_PAN.findall(content)))

        # IFSC is structurally weak — "4 uppercase letters, a 0, 6 alphanumerics"
        # occurs by chance inside base64 (a PEM certificate bundle matches it
        # dozens of times). Require a banking word nearby before believing it.
        ifsc_hits = 0
        for match in self._RE_IFSC.finditer(content):
            window = content[max(0, match.start() - 64):match.end() + 64].lower()
            if any(k in window for k in ("ifsc", "bank", "branch", "account", "neft", "rtgs")):
                ifsc_hits += 1
        add("IFSC", ifsc_hits)
        add("PASSPORT", len(self._RE_PASSPORT.findall(content)))
        add("SSN", len(self._RE_SSN.findall(content)))
        add("PHONE", len(self._RE_PHONE_IN.findall(content)))
        add("EMAIL", len(self._RE_EMAIL.findall(content)))
        add("UPI_ID", len(self._RE_UPI.findall(content)))
        add("AWS_KEY", len(self._RE_AWS_KEY.findall(content)))
        add("API_KEY", len(self._RE_API_KEY.findall(content)))
        add("PRIVATE_KEY", len(self._RE_PRIVATE_KEY.findall(content)))
        add("DB_CONNECTION_STRING", len(self._RE_DB_CONN.findall(content)))

        # Custom regexes declared by the policies themselves.
        active_custom_patterns = list(custom_patterns or [])
        if not active_custom_patterns:
            for pol in list(self.network_policies) + list(self.file_transfer_policies) + list(self.file_policies):
                cfg = pol.get("config", {}) or {}
                pats = (cfg.get("patterns", {}) or {}).get("custom") or []
                pats = pats or cfg.get("customRegexPatterns") or cfg.get("customPatterns") or cfg.get("custom_regex") or []
                if isinstance(pats, list):
                    active_custom_patterns.extend(pats)
                elif isinstance(pats, str) and pats.strip():
                    active_custom_patterns.append(pats.strip())

        for pat in active_custom_patterns:
            if not pat:
                continue
            try:
                if re.search(pat, content):
                    add("CUSTOM_REGEX")
                    break
            except re.error:
                logger.debug(f"Skipping invalid custom pattern from policy: {pat!r}")

        labels = [label for label, n in counts.items() if n > 0]
        if not labels:
            return empty

        severity = max(
            (self._LABEL_SEVERITY.get(l, "medium") for l in labels),
            key=lambda s: self._SEVERITY_RANK.get(s, 2),
        )
        # An address book full of e-mails is not a critical incident; a single
        # private key is. Score follows the strongest label, not the count.
        score = {"low": 0.3, "medium": 0.5, "high": 0.75, "critical": 0.9}[severity]

        return {
            "labels": labels,
            "severity": severity,
            "score": score,
            "method": "regex",
            "match_counts": counts,
        }

    def _labels_in_scope(self, labels: List[str], allowed: Set[str]) -> List[str]:
        """Keep only the labels a policy's dataTypes actually asked about.
        An empty dataTypes list means "any"."""
        if not allowed:
            return list(labels)
        alias = {"AADHAAR_CARD": "AADHAAR", "PHONE_NUMBER": "PHONE",
                 "IFSC_CODE": "IFSC", "DATABASE_CONNECTION": "DB_CONNECTION_STRING",
                 "INDIAN_BANK_ACCOUNT": "INDIAN_BANK_ACCOUNT"}
        norm_allowed = {alias.get(a, a) for a in allowed}
        return [l for l in labels if alias.get(l, l) in norm_allowed]

    def _calculate_file_hash(self, file_path: str) -> str:
        """Calculate SHA256 hash of file"""
        sha256_hash = hashlib.sha256()
        try:
            with open(file_path, "rb") as f:
                for byte_block in iter(lambda: f.read(4096), b""):
                    sha256_hash.update(byte_block)
            return sha256_hash.hexdigest()
        except:
            return ""

    def _read_file_content(self, file_path: str, max_bytes: int = 200000) -> str:
        """Read text content from various file formats (.txt, .json, .xml, .csv, .sql, .docx, .xlsx, .pptx, .pdf, .zip, .db, etc.)."""
        if not os.path.exists(file_path):
            return ""

        ext = Path(file_path).suffix.lower()

        # 1. Office Open XML (.docx, .xlsx, .pptx) or .zip archives
        if ext in (".docx", ".xlsx", ".pptx", ".zip"):
            try:
                import zipfile
                extracted_texts = []
                with zipfile.ZipFile(file_path, 'r') as zf:
                    for item in zf.namelist():
                        if item.endswith(('.xml', '.txt', '.csv', '.json', '.rels')):
                            try:
                                raw_bytes = zf.read(item)[:50000]
                                text = raw_bytes.decode('utf-8', errors='ignore')
                                import re
                                text = re.sub(r'<[^>]+>', ' ', text)
                                extracted_texts.append(text)
                            except Exception:
                                pass
                if extracted_texts:
                    return " ".join(extracted_texts)[:max_bytes]
            except Exception as e:
                logger.debug(f"Zip/Office text extraction fallback for {file_path}: {e}")

        # 2. SQLite Database (.db, .sqlite)
        if ext in (".db", ".sqlite", ".sqlite3"):
            try:
                import sqlite3
                conn = sqlite3.connect(file_path)
                cursor = conn.cursor()
                cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
                tables = cursor.fetchall()
                db_texts = []
                for (table_name,) in tables[:10]:
                    try:
                        cursor.execute(f"SELECT * FROM \"{table_name}\" LIMIT 50;")
                        rows = cursor.fetchall()
                        for row in rows:
                            db_texts.append(" ".join(str(val) for val in row if val is not None))
                    except Exception:
                        pass
                conn.close()
                if db_texts:
                    return " ".join(db_texts)[:max_bytes]
            except Exception as e:
                logger.debug(f"SQLite extraction fallback for {file_path}: {e}")

        # 3. Plain text
        try:
            with open(file_path, 'rb') as f:
                raw = f.read(max_bytes)
            if b"\x00" in raw[:8192]:
                # NUL bytes early on means binary. Stop here.
                return ""
            content = raw.decode('utf-8', errors='replace')
            if content and self._looks_like_text(content):
                return content
        except Exception as e:
            logger.debug(f"Text read failed for {file_path}: {e}")

        # NO binary "strings" fallback.
        #
        # The previous build scraped printable runs out of any binary
        # (.pdf, .so, .jpg, .zip …) and ran the sensitive-data patterns over
        # them. Compressed and compiled bytes contain plenty of 12-digit runs
        # and 5-letter+4-digit tokens, so essentially every binary file came
        # back "sensitive" — the reason a USB stick lit up wholesale on insert.
        # Binary formats are inspected server-side instead: the caller sends
        # the raw bytes as file_content_b64 and the server's extractor pulls
        # real text out of pdf/docx/xlsx/pptx, or reports the file as
        # uninspectable so a policy decides.
        return ""

    def send_event(self, event_data: Dict[str, Any]):
        """Send event to server"""
        try:
            event_type = str(event_data.get("event_type", "")).lower()
            # No policies means no events. The old exemption here — "send it
            # anyway if it's network/usb/clipboard, or if we blocked it" — let
            # an agent whose policy sync was failing keep streaming
            # self-invented blocks to the console. If the server has no policy
            # for a channel, the agent has nothing to report about it.
            if not self.allow_events:
                logger.debug(f"Dropping {event_type} event: no active policies")
                return

            if self.active_policy_version and "policy_version" not in event_data:
                event_data["policy_version"] = self.active_policy_version

            response = self.session.post(
                f"{self.server_url}/events",
                json=event_data,
                timeout=10
            )

            if response.status_code in [200, 201]:
                logger.info(
                    "Event sent (%s/%s): %s",
                    event_type, event_data.get('event_subtype'), event_data.get('file_name', ''),
                )
            else:
                logger.warning(f"Failed to send event to server ({response.status_code}): {response.text[:300]}")

        except Exception as e:
            logger.error(f"Error sending event: {e}")

    def heartbeat_loop(self):
        """Send periodic heartbeat to server"""
        interval = self.config.get("heartbeat_interval", 3)

        while self.running:
            try:
                self.send_heartbeat()
            except Exception as e:
                logger.error(f"Heartbeat error: {e}")

            time.sleep(interval)

    def send_heartbeat(self):
        """Send heartbeat to server with timestamp"""
        try:
            # Send timestamp in ISO format for server validation
            logged_in = self._logged_in_users()
            data = {
                "timestamp": datetime.utcnow().isoformat() + "Z",
                # Keep heartbeat IP aligned with registration IP
                "ip_address": self._get_real_ip_address(),
                # Keep endpoint inventory live between restarts — users log in/out
                # and the kernel can change (updates), so refresh every heartbeat.
                "os_name": self._os_name(),
                "os_version": self._os_version_detail(),
                "logged_in_users": logged_in,
                "username": logged_in[0] if logged_in else self._current_user(),
            }

            response = self.session.put(
                f"{self.server_url}/agents/{self.agent_id}/heartbeat",
                json=self._augment_heartbeat_data(data),
                timeout=30  # Increased timeout to handle slow server responses
            )

            if response.status_code == 200:
                logger.info("Heartbeat sent successfully")
            else:
                logger.warning(f"Heartbeat response: {response.status_code}")

        except Exception as e:
            logger.error(f"Heartbeat failed: {e}", exc_info=True)

    def _augment_heartbeat_data(self, data: Dict[str, Any]) -> Dict[str, Any]:
        if self.active_policy_version:
            data["policy_version"] = self.active_policy_version
        if self.last_policy_sync_status:
            data["policy_sync_status"] = self.last_policy_sync_status
        if self.last_policy_sync_at:
            data["policy_last_synced_at"] = self.last_policy_sync_at
        if self.last_policy_sync_error:
            data["policy_sync_error"] = self.last_policy_sync_error
        return data

    def _get_real_ip_address(self) -> str:
        """Get the primary IPv4 address of the Linux machine.

        Prefer a real interface address (not 127.0.0.1 or a container/WSL bridge) by
        opening a UDP socket toward a well-known external IP. No packets are actually
        sent, but the OS chooses the outbound interface and we read its IP.
        """
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                # Use a public resolver IP to determine the primary interface.
                # The remote host does not need to be reachable for getsockname() to work.
                s.connect(("8.8.8.8", 80))
                return s.getsockname()[0]
        except Exception:
            # Fallback to hostname resolution, and finally loopback as last resort.
            try:
                return socket.gethostbyname(socket.gethostname())
            except Exception:
                return "127.0.0.1"

    def start_clipboard_monitoring(self):
        """Start the clipboard monitoring background daemon thread."""
        if self.clipboard_running:
            return
        self.clipboard_running = True
        # Read current clipboard content to seed the monitor
        self.last_clipboard_content = self._get_clipboard_text() or ""
        self.clipboard_monitor_thread = threading.Thread(
            target=self._clipboard_monitor_loop,
            name="CS_ClipboardMonitor",
            daemon=True
        )
        self.clipboard_monitor_thread.start()
        logger.info("Clipboard monitoring daemon started")

    def stop_clipboard_monitoring(self):
        """Stop the clipboard monitoring background daemon thread."""
        if not self.clipboard_running:
            return
        self.clipboard_running = False
        if self.clipboard_monitor_thread:
            self.clipboard_monitor_thread.join(timeout=1.0)
            self.clipboard_monitor_thread = None
        logger.info("Clipboard monitoring daemon stopped")

    def _get_clipboard_text(self) -> Optional[str]:
        """Read text from the clipboard. Handles both Wayland and X11."""
        try:
            import subprocess
            # Try Wayland (wl-paste)
            res = subprocess.run(["wl-paste", "-n"], capture_output=True, text=True, timeout=2)
            if res.returncode == 0:
                return res.stdout
        except Exception:
            pass

        try:
            import subprocess
            # Try X11 (xclip)
            res = subprocess.run(["xclip", "-selection", "clipboard", "-o"], capture_output=True, text=True, timeout=2)
            if res.returncode == 0:
                return res.stdout
        except Exception:
            pass

        try:
            import subprocess
            # Try X11 (xsel)
            res = subprocess.run(["xsel", "-b", "-o"], capture_output=True, text=True, timeout=2)
            if res.returncode == 0:
                return res.stdout
        except Exception:
            pass

        return None

    def _set_clipboard_text(self, text: str):
        """Write text to the clipboard. Handles both Wayland and X11."""
        try:
            import subprocess
            # Try Wayland (wl-copy)
            subprocess.run(["wl-copy", text], input=text, text=True, timeout=2)
            return
        except Exception:
            pass

        try:
            import subprocess
            # Try X11 (xclip)
            subprocess.run(["xclip", "-selection", "clipboard", "-i"], input=text, text=True, timeout=2)
            return
        except Exception:
            pass

        try:
            import subprocess
            # Try X11 (xsel)
            subprocess.run(["xsel", "-b", "-i"], input=text, text=True, timeout=2)
            return
        except Exception:
            pass

    # Policy "patterns.predefined" names -> the labels _classify_content emits.
    _CLIPBOARD_PATTERN_LABELS = {
        "aadhaar": "AADHAAR", "aadhaar_card": "AADHAAR",
        "pan": "PAN_CARD", "pan_card": "PAN_CARD",
        "ifsc": "IFSC", "ifsc_code": "IFSC",
        "email": "EMAIL",
        "phone": "PHONE", "indian_phone": "PHONE", "phone_number": "PHONE",
        "credit_card": "CREDIT_CARD",
        "ssn": "SSN",
        "passport": "PASSPORT",
        "api_key": "API_KEY", "api_key_in_code": "API_KEY",
        "aws_key": "AWS_KEY",
        "private_key": "PRIVATE_KEY",
        "database_connection_string": "DB_CONNECTION_STRING",
        "upi_id": "UPI_ID",
    }

    def _clipboard_monitor_loop(self):
        """Periodically check the clipboard for new content and evaluate policies."""
        last_event_times = {}  # Keep track of last event timestamps per content to avoid repeat fires
        while self.clipboard_running and self.running:
            try:
                time.sleep(0.5)  # poll every 500ms
                content = self._get_clipboard_text()
                if content is None:
                    continue

                # Strip whitespace and check if content actually changed
                content_stripped = content.strip()
                if not content_stripped or content_stripped == self.last_clipboard_content:
                    continue

                # Always update last_clipboard_content to the original text copied to prevent loops
                self.last_clipboard_content = content_stripped

                # Match against clipboard policies using the same validated
                # detectors as every other channel. The loop used to carry its
                # own weaker copies — "any 12 digits" for Aadhaar, "any 10
                # digits" for a phone number — so copying an order number or a
                # timestamp raised a DLP alert.
                local = self._classify_content(content_stripped)
                found = set(local.get("labels", []))
                if not found:
                    continue

                matched_policy = None
                for policy in self.clipboard_policies:
                    cfg = policy.get("config", {}) or {}
                    predefined = (cfg.get("patterns", {}) or {}).get("predefined") or []
                    wanted = {self._CLIPBOARD_PATTERN_LABELS.get(str(p).lower(), str(p).upper())
                              for p in predefined}
                    # A policy naming no patterns matches on any detection.
                    if not wanted or (found & wanted):
                        matched_policy = policy
                        break

                if not matched_policy:
                    continue

                # Cooldown check: prevent duplicate events for the same content within 5 seconds
                now = time.time()
                if content_stripped in last_event_times and now - last_event_times[content_stripped] < 5:
                    continue
                last_event_times[content_stripped] = now

                # Trigger real-time evaluation with the server
                eval_result = self.evaluate_policy_realtime(
                    file_name="clipboard_data.txt",
                    file_path="",  # no physical file
                    dest_path="clipboard",
                    event_type="clipboard",
                    clipboard_content=content_stripped
                )
                
                cfg = matched_policy.get("config", {}) or {}
                policy_action = (cfg.get("action") or "alert").lower()

                # Blocking means destroying what the user copied, so it happens
                # only when the policy says "block" AND the server agrees the
                # content is sensitive. The previous build wiped the clipboard
                # for alert-only policies too, and did it again whenever the
                # evaluation API was merely unreachable.
                blocked = False
                if eval_result.get("evaluation_succeeded", False):
                    server_action = str(eval_result.get("action", "allow")).lower()
                    blocked = (server_action == "block" and policy_action == "block")
                elif policy_action == "block":
                    logger.warning(
                        "Clipboard evaluation unavailable; alerting instead of clearing the clipboard"
                    )

                # If action is block, clear/overwrite the clipboard immediately
                if blocked:
                    logger.warning("Sensitive data detected in clipboard! Blocking and clearing clipboard...")
                    self._set_clipboard_text("[CyberSentinel DLP] Sensitive data copy blocked.")
                    # Update seed so the warning text itself doesn't trigger monitoring
                    self.last_clipboard_content = "[CyberSentinel DLP] Sensitive data copy blocked."
                
                # Dispatch the event
                self._send_clipboard_event(content_stripped, matched_policy, blocked, policy_action)

            except Exception as e:
                logger.error(f"Error in clipboard monitor loop: {e}")

    def _send_clipboard_event(self, content: str, policy: Dict[str, Any], blocked: bool, policy_action: str):
        """Send clipboard alert/event to the server."""
        try:
            current_user = self._event_user()

            policy_severity = policy.get("severity", "medium").lower()
            
            # Elevate severity to high/critical so it bypasses dashboard filter and shows up on the Alerts page
            severity = "critical" if blocked else ("high" if policy_severity == "medium" else policy_severity)

            event_data = {
                "event_id": str(uuid.uuid4()),
                "event_type": "clipboard",
                "event_subtype": "clipboard_blocked" if blocked else "clipboard_alerted",
                "agent_id": self.agent_id,
                "source_type": "agent",
                "user_email": f"{current_user}@{socket.gethostname()}",
                "username": current_user,
                "description": f"Sensitive data copy {'blocked' if blocked else 'alerted'} in clipboard.",
                "severity": severity,
                "action": "blocked" if blocked else "alerted",
                "content": content[:1000],  # truncate if extremely large
                "blocked": blocked,
                "timestamp": datetime.utcnow().isoformat(),
                "policy_id": policy.get("id"),
                "policy_name": policy.get("name"),
                "policy_action": policy_action,
                "matched_policies": [policy.get("id")] if policy.get("id") else [],
            }

            if self.active_policy_version:
                event_data["policy_version"] = self.active_policy_version

            self.send_event(event_data)

        except Exception as e:
            logger.error(f"Error sending clipboard event: {e}")

    # ==================================================================
    # Network DLP
    # ==================================================================
    #
    # Same shape as the Windows agent's network_exfil_monitor:
    #
    #   process creation event -> suspend the process -> parse its command
    #   line -> read the file(s) it references -> ask the server ->
    #   terminate on block, resume on allow.
    #
    # What it deliberately does NOT do (all of which the previous build did):
    #   * poll /proc every 20ms
    #   * raise an event for a process merely existing, with no file involved
    #   * treat "some regex matched" as a block decision, ignoring the policy
    #   * treat a 0600 file as proof of sensitivity (it had just chmod'd them
    #     itself, so every file it touched became permanently "sensitive")
    #   * change ownership or permissions of anything, ever
    #   * kill sshd/smbd sessions
    #
    # Two channels are covered:
    #   1. OUTBOUND  — a local tool pushing a file out (curl -T, scp, ftp,
    #                  rsync, aws s3 cp, nc < file, …). Detected at exec.
    #   2. SERVED    — a local file server handing a file to a remote client
    #                  (python3 -m http.server + curl from another host).
    #                  Detected from the read of a watched file, but only
    #                  while that server process holds the file open AND has a
    #                  live remote connection on a policy-monitored port.

    # exe name -> canonical transfer_method, matching the vocabulary the
    # server's policies use in monitoredMethods.
    _TRANSFER_METHODS = {
        "curl": "curl",
        "wget": "wget",
        "scp": "scp",
        "sftp": "sftp",
        # The ssh CLIENT is a file-transfer tool whenever something is piped
        # into it (`ssh host 'cat > out' < secret.txt`, `tar cz dir | ssh …`).
        # An interactive login has a tty on stdin, no file, and stays silent.
        # Not to be confused with the sshd DAEMON, which is never signalled.
        "ssh": "scp",
        # OpenSSH 9+ implements `scp` over the SFTP subsystem, so a remote
        # `scp user@here:file .` runs sftp-server on this host rather than
        # `scp -f`. It names no file on its command line — it holds the file
        # open while streaming it, and its parent sshd owns the socket — so it
        # is handled by the egress guard rather than at exec.
        "sftp-server": "sftp",
        "ftp": "ftp",
        "lftp": "ftp",
        "ftpput": "ftp",
        "tftp": "tftp",
        "nc": "netcat",
        "ncat": "netcat",
        "netcat": "netcat",
        "socat": "netcat",
        "rsync": "rsync",
        "smbclient": "smb_copy",
        "cadaver": "webdav",
        "aws": "cloud_cli",
        "gcloud": "cloud_cli",
        "gsutil": "cloud_cli",
        "az": "cloud_cli",
        "s3cmd": "cloud_cli",
        "rclone": "cloud_cli",
        "mc": "cloud_cli",
        "powershell": "powershell_upload",
        "pwsh": "powershell_upload",
    }

    # Per-session workers: watched, but decided by the egress guard (see
    # _classify_process) because their payload never appears in argv.
    _SESSION_WORKERS = {"sftp-server"}

    # Interpreters are only candidates when their command line says so —
    # otherwise every python process on the box is a "transfer tool".
    _INTERPRETERS = {"python", "python3", "php", "ruby", "perl", "node", "nodejs"}

    _SERVER_CMD_MARKERS = ("http.server", "simplehttpserver", "-m http", "httpd",
                           "flask", "uvicorn", "gunicorn", "django", "runserver",
                           "php -s", "webrick", "http-server")
    _UPLOADER_CMD_MARKERS = ("requests.post", "urllib", "paramiko", "pysftp", "smtplib",
                             "boto3", "ftplib", "upload", "exfil", "curl", "socket")

    @staticmethod
    def _normalize_exe_name(name: str) -> str:
        """Strip version suffixes so /proc/PID/exe -> "python3.12" is
        recognised as python3, and drop a trailing colon from "sshd:"-style
        argv[0] values."""
        name = (name or "").strip().lower().rstrip(":")
        m = re.match(r"^(python|php|ruby|perl|node|pwsh)[\d.]*$", name)
        if m:
            base = m.group(1)
            if base == "python":
                return "python3" if name.startswith("python3") else "python"
            return base
        return name

    def _candidate_names(self, exe_path: str, cmd_args: List[str]) -> List[str]:
        """The names worth testing for one process. /proc/PID/exe gives the
        real binary (curl, python3.12) while argv[0] gives what the user
        typed; either can be the recognisable one."""
        names = []
        for raw in (Path(exe_path).name if exe_path else "", cmd_args[0] if cmd_args else ""):
            for candidate in (raw, self._normalize_exe_name(raw)):
                if candidate and candidate not in names:
                    names.append(candidate)
        return names

    def _classify_process(self, exe_name: str, cmdline: str,
                          extra_names: Optional[List[str]] = None) -> Optional[Tuple[str, str]]:
        """Map a process to (transfer_method, channel).

        channel is "outbound" for a push tool, "server" for a local file
        server. Returns None when the process is not a transfer tool at all.
        """
        names = [self._normalize_exe_name(exe_name)]
        for n in (extra_names or []):
            n = self._normalize_exe_name(n)
            if n and n not in names:
                names.append(n)

        if any(n in self._never_terminate for n in names):
            return None

        extra = {str(p).lower() for p in self.network_cfg.get("extra_watched_processes", []) or []}
        for name in names:
            if name in self._SESSION_WORKERS:
                # Long-lived per-session worker: the file it moves is never on
                # its command line, and its stdin pipe carries protocol frames
                # rather than the payload. Judging it at exec would either miss
                # the file or condemn every session as "uninspectable".
                return self._TRANSFER_METHODS[name], "session"
            if name in self._TRANSFER_METHODS:
                return self._TRANSFER_METHODS[name], "outbound"
            if name in extra:
                return name, "outbound"

        low = cmdline.lower()
        for name in names:
            if name in self._INTERPRETERS:
                if any(marker in low for marker in self._SERVER_CMD_MARKERS):
                    return ("python_http_server" if name.startswith("python") else "http_server"), "server"
                if any(marker in low for marker in self._UPLOADER_CMD_MARKERS):
                    return "http_post", "outbound"
                break
        return None

    def _method_in_policy_scope(self, method: str) -> bool:
        """True when at least one active policy names this method (or names
        no methods at all, i.e. is unscoped)."""
        if not self.has_network_policies:
            return False
        if not self.network_methods:
            return True
        return method in self.network_methods

    # ---- /proc helpers -------------------------------------------------

    @staticmethod
    def _read_cmdline(pid: int) -> List[str]:
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                raw = f.read()
            return [a.decode("utf-8", errors="ignore") for a in raw.split(b"\x00") if a]
        except Exception:
            return []

    @staticmethod
    def _read_exe(pid: int) -> str:
        try:
            return os.readlink(f"/proc/{pid}/exe")
        except Exception:
            return ""

    @staticmethod
    def _process_uid(pid: int) -> Optional[int]:
        try:
            with open(f"/proc/{pid}/status", "r") as f:
                for line in f:
                    if line.startswith("Uid:"):
                        return int(line.split()[1])
        except Exception:
            pass
        return None

    def _process_username(self, pid: int) -> str:
        uid = self._process_uid(pid)
        if uid is None:
            return self._current_user()
        try:
            import pwd
            return pwd.getpwuid(uid).pw_name
        except Exception:
            return str(uid)

    @staticmethod
    def _current_user() -> str:
        try:
            import pwd
            return pwd.getpwuid(os.getuid()).pw_name
        except Exception:
            return os.environ.get("USER", "unknown")

    def _os_name(self) -> str:
        """Precise OS product name for the Agents "OS" column, e.g.
        "Ubuntu 22.04.3 LTS". Read from /etc/os-release (the freedesktop
        standard every mainstream distro ships); falls back to uname."""
        try:
            data: Dict[str, str] = {}
            with open("/etc/os-release", "r", encoding="utf-8", errors="ignore") as fh:
                for line in fh:
                    key, sep, val = line.partition("=")
                    if sep:
                        data[key.strip()] = val.strip().strip('"').strip("'")
            pretty = data.get("PRETTY_NAME") or data.get("NAME")
            if pretty:
                return pretty
        except Exception:
            pass
        sysname = platform.system() or "Linux"
        rel = platform.release()
        return f"{sysname} {rel}".strip() if rel else sysname

    def _os_version_detail(self) -> str:
        """Granular OS version for the Agents "Version" column — the kernel
        release, e.g. "6.8.0-124-generic"."""
        return platform.release() or platform.version() or ""

    def _logged_in_users(self) -> List[str]:
        """Everyone with a live login session (graphical seat, tty, or ssh),
        deduped in first-seen order. Sourced from utmp via ``who`` (coreutils,
        present on every real endpoint); falls back to ``loginctl`` on systemd,
        then to the agent's own user. Under systemd the agent runs as root, so
        ``who``/``loginctl`` — not our own uid — is what surfaces the humans."""
        users: List[str] = []

        def _add(name: str) -> None:
            name = (name or "").strip()
            if name and name not in users:
                users.append(name)

        try:
            out = subprocess.check_output(
                ["who"], text=True, timeout=5, stderr=subprocess.DEVNULL
            )
            for line in out.splitlines():
                parts = line.split()
                if parts:
                    _add(parts[0])
        except Exception:
            pass

        if not users:
            try:
                out = subprocess.check_output(
                    ["loginctl", "list-sessions", "--no-legend"],
                    text=True, timeout=5, stderr=subprocess.DEVNULL,
                )
                for line in out.splitlines():
                    parts = line.split()
                    # Columns: SESSION UID USER SEAT TTY
                    if len(parts) >= 3:
                        _add(parts[2])
            except Exception:
                pass

        if not users:
            cu = self._current_user()
            if cu and cu != "unknown":
                _add(cu)

        return users

    def _event_user(self) -> str:
        """Best-effort 'who triggered this' for events that carry no PID —
        inotify/watchdog file-watch events give no originating process, so the
        exact owner is unknowable. Attribute to the primary interactive user
        (the person at the console) rather than the agent's own service account
        (root under systemd), which is never the real actor. Events that DO
        have a PID keep using ``_process_username(pid)`` — the exact owner."""
        users = self._logged_in_users()
        if users:
            return users[0]
        return self._current_user()

    @staticmethod
    def _socket_inodes_for_pid(pid: int) -> Set[int]:
        """Socket inodes owned by a PID, used to attribute a TCP connection to
        the exact process instead of guessing from a global connection list."""
        inodes: Set[int] = set()
        try:
            fd_dir = f"/proc/{pid}/fd"
            for fd in os.listdir(fd_dir):
                try:
                    target = os.readlink(os.path.join(fd_dir, fd))
                except Exception:
                    continue
                if target.startswith("socket:["):
                    try:
                        inodes.add(int(target[8:-1]))
                    except ValueError:
                        continue
        except Exception:
            pass
        return inodes

    @staticmethod
    def _hex_to_ip(hex_addr: str) -> str:
        """/proc/net/tcp stores addresses little-endian hex."""
        try:
            if len(hex_addr) == 8:
                b = [int(hex_addr[i:i + 2], 16) for i in (6, 4, 2, 0)]
                return ".".join(str(x) for x in b)
            if len(hex_addr) == 32:
                # IPv6, including ::ffff:a.b.c.d mapped form
                words = [hex_addr[i:i + 8] for i in range(0, 32, 8)]
                octets = []
                for w in words:
                    octets.extend(int(w[i:i + 2], 16) for i in (6, 4, 2, 0))
                if octets[:10] == [0] * 10 and octets[10:12] == [0xff, 0xff]:
                    return ".".join(str(x) for x in octets[12:16])
                return ":".join(
                    f"{octets[i]:02x}{octets[i+1]:02x}" for i in range(0, 16, 2)
                )
        except Exception:
            pass
        return ""

    def _tcp_connections(self) -> List[Dict[str, Any]]:
        """Established TCP connections with their owning socket inode."""
        conns: List[Dict[str, Any]] = []
        for proc_file in ("/proc/net/tcp", "/proc/net/tcp6"):
            try:
                with open(proc_file, "r") as f:
                    lines = f.readlines()[1:]
            except Exception:
                continue
            for line in lines:
                parts = line.split()
                if len(parts) < 10:
                    continue
                try:
                    local_hex, local_port_hex = parts[1].split(":")
                    rem_hex, rem_port_hex = parts[2].split(":")
                    state = parts[3]
                    inode = int(parts[9])
                except (ValueError, IndexError):
                    continue
                if state != "01":  # ESTABLISHED only
                    continue
                remote_ip = self._hex_to_ip(rem_hex)
                if not remote_ip or remote_ip.startswith("127.") or remote_ip == "::1" or remote_ip == "0.0.0.0":
                    continue
                conns.append({
                    "local_port": int(local_port_hex, 16),
                    "remote_ip": remote_ip,
                    "remote_port": int(rem_port_hex, 16),
                    "inode": inode,
                })
        return conns

    def _connections_for_pid(self, pid: int) -> List[Dict[str, Any]]:
        inodes = self._socket_inodes_for_pid(pid)
        if not inodes:
            return []
        return [c for c in self._tcp_connections() if c["inode"] in inodes]

    def _open_regular_files(self, pid: int) -> List[str]:
        """Regular files a PID currently holds open, excluding system paths.

        stdin comes first: `curl ... < secret.txt` and `nc host port <
        secret.txt` put the source file there and nowhere on the command line,
        so a parser that only reads argv sees an innocent-looking invocation.
        """
        out: List[str] = []
        fd_dir = f"/proc/{pid}/fd"
        try:
            entries = os.listdir(fd_dir)
        except Exception:
            return out
        # fd 0, 1, 2 first, then the rest in numeric order.
        def fd_order(fd: str) -> Tuple[int, int]:
            try:
                n = int(fd)
            except ValueError:
                return (2, 0)
            return (0 if n <= 2 else 1, n)

        for fd in sorted(entries, key=fd_order):
            try:
                target = os.readlink(os.path.join(fd_dir, fd))
            except Exception:
                continue
            if not target.startswith("/") or " (deleted)" in target:
                continue
            if target.startswith(("/dev/", "/proc/", "/sys/", "/usr/", "/lib/",
                                  "/lib64/", "/etc/", "/run/", "/var/lib/")):
                continue
            try:
                if os.path.isfile(target) and target not in out:
                    out.append(target)
            except Exception:
                continue
        return out

    def _pipe_inodes(self, pid: int, fds: Tuple[str, ...] = ("0",)) -> Set[int]:
        """Pipe inodes attached to the given fds of a process."""
        inodes: Set[int] = set()
        for fd in fds:
            try:
                target = os.readlink(f"/proc/{pid}/fd/{fd}")
            except Exception:
                continue
            if target.startswith("pipe:["):
                try:
                    inodes.add(int(target[6:-1]))
                except ValueError:
                    continue
        return inodes

    def _upstream_pipe_files(self, pid: int, depth: int = 2) -> List[str]:
        """Files held open by whatever is writing into this process's stdin.

        Covers `cat secret.txt | curl -T - https://host/`, where the uploading
        process never names the file at all — the file belongs to `cat`, one
        end of a pipe away. Walks a couple of links so
        `cat f | gzip | curl` is still attributed.
        """
        found: List[str] = []
        frontier = [pid]
        seen_pids = {pid}
        for _ in range(max(1, depth)):
            wanted = set()
            for p in frontier:
                wanted |= self._pipe_inodes(p, ("0",))
            if not wanted:
                break

            next_frontier = []
            for entry in os.listdir("/proc"):
                if not entry.isdigit():
                    continue
                writer = int(entry)
                if writer in seen_pids or writer == os.getpid():
                    continue
                # A writer has the same pipe on its stdout/stderr.
                if not (self._pipe_inodes(writer, ("1", "2")) & wanted):
                    continue
                seen_pids.add(writer)
                next_frontier.append(writer)
                for f in self._open_regular_files(writer):
                    if f not in found:
                        found.append(f)
            frontier = next_frontier
            if not frontier:
                break
        return found

    # ---- process control ----------------------------------------------

    @staticmethod
    def _parent_pid(pid: int) -> int:
        try:
            with open(f"/proc/{pid}/status", "r") as f:
                for line in f:
                    if line.startswith("PPid:"):
                        return int(line.split()[1])
        except Exception:
            pass
        return 0

    def _is_own_descendant(self, pid: int) -> bool:
        """Walk the parent chain to see if this process is one we spawned."""
        me = os.getpid()
        seen = 0
        while pid > 1 and seen < 32:
            if pid == me:
                return True
            pid = self._parent_pid(pid)
            seen += 1
        return False

    def _may_signal(self, pid: int, exe_name: str) -> bool:
        """Guard rails around SIGSTOP/SIGKILL. Nothing outside the identified
        transfer tool is ever signalled."""
        if pid <= 1 or pid == os.getpid():
            return False
        if exe_name.lower() in self._never_terminate:
            return False
        # Only our own descendants are off limits. Comparing process *groups*
        # (as this did before) exempted every sibling process whenever the
        # agent was started from a shell — including the transfer we are
        # supposed to stop.
        if self._is_own_descendant(pid):
            return False
        return True

    def _suspend(self, pid: int, exe_name: str) -> bool:
        if not self.network_cfg.get("suspend_during_evaluation", True):
            return False
        if not self._may_signal(pid, exe_name):
            return False
        try:
            os.kill(pid, signal.SIGSTOP)
            with self._net_lock:
                self._suspended_pids.add(pid)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            logger.debug(f"No permission to suspend pid {pid}; run the agent as root to intercept")
            return False
        except Exception as exc:
            logger.debug(f"Suspend failed for pid {pid}: {exc}")
            return False

    def _resume(self, pid: int):
        try:
            os.kill(pid, signal.SIGCONT)
        except Exception:
            pass
        with self._net_lock:
            self._suspended_pids.discard(pid)

    def _resume_all_suspended(self):
        with self._net_lock:
            pids = list(getattr(self, "_suspended_pids", set()))
        for pid in pids:
            self._resume(pid)

    def _terminate(self, pid: int, exe_name: str) -> bool:
        if not self._may_signal(pid, exe_name):
            logger.warning(f"Refusing to terminate protected process {exe_name} (pid {pid})")
            return False
        try:
            os.kill(pid, signal.SIGKILL)
            with self._net_lock:
                self._suspended_pids.discard(pid)
            logger.warning(f"Terminated {exe_name} (pid {pid}) — network transfer blocked")
            return True
        except ProcessLookupError:
            return True     # already gone; the transfer did not complete
        except PermissionError:
            logger.error(f"No permission to terminate pid {pid}; run the agent as root to enforce blocks")
            return False
        except Exception as exc:
            logger.error(f"Failed to terminate pid {pid}: {exc}")
            return False

    # ---- command-line parsing -----------------------------------------

    @staticmethod
    def _process_cwd(pid: int) -> Optional[str]:
        try:
            return os.readlink(f"/proc/{pid}/cwd")
        except Exception:
            return None

    def _parse_transfer_cmd(self, method: str, cmd_args: List[str],
                            pid: Optional[int] = None) -> Dict[str, Any]:
        """Pull the referenced local file(s) and the remote destination out of
        a transfer tool's argv."""
        info: Dict[str, Any] = {
            "source_files": [],
            "destination": "",
            "destination_host": "",
            "destination_port": None,
            "protocol": method,
            "full_command": " ".join(cmd_args),
        }

        # A relative path on the command line is relative to the TRANSFER's
        # working directory, not ours. Resolving it against the agent's cwd
        # meant `scp -f ./CPTEST/CPA.txt` (what sshd runs when a remote host
        # pulls a file) resolved to a path that does not exist, the file was
        # never inspected, and the pull went through untouched.
        cwd = self._process_cwd(pid) if pid else None

        def add_file(candidate: str):
            if not candidate:
                return
            path = self._expand_path(candidate.strip("'\""))
            if not os.path.isabs(path):
                path = os.path.normpath(os.path.join(cwd or os.getcwd(), path))
            try:
                if os.path.isfile(path) and path not in info["source_files"]:
                    info["source_files"].append(path)
            except Exception:
                pass

        def note_url(url: str):
            m = re.match(r'^([a-zA-Z][a-zA-Z0-9+.-]*)://(?:[^@/]*@)?([^/:\s]+)(?::(\d+))?', url)
            if not m:
                return
            scheme, host, port = m.group(1).lower(), m.group(2), m.group(3)
            info["destination"] = url
            info["destination_host"] = host
            info["protocol"] = scheme
            if port:
                info["destination_port"] = int(port)
            else:
                info["destination_port"] = {"http": 80, "https": 443, "ftp": 21,
                                            "sftp": 22, "tftp": 69}.get(scheme)

        args = cmd_args[1:]
        upload_flags = {"-T", "--upload-file", "-F", "--form", "-d", "--data",
                        "--data-binary", "--data-raw", "--data-ascii",
                        # wget
                        "--post-file", "--body-file", "--input-file",
                        # misc
                        "--file", "--infile", "-in"}

        i = 0
        while i < len(args):
            arg = args[i]
            low = arg.lower()

            if "://" in arg:
                note_url(arg)
            elif arg.startswith("@"):
                add_file(arg[1:])

            if arg in upload_flags and i + 1 < len(args):
                value = args[i + 1]
                if value.startswith("@"):
                    add_file(value[1:].split(";")[0])
                elif "=@" in value:
                    # curl multipart form: -F "field=@/path/to/file;type=..."
                    add_file(value.split("=@", 1)[1].split(";")[0])
                else:
                    add_file(value)
                i += 2
                continue
            # --flag=value form (wget's --post-file=/path, curl's --upload-file=…)
            if "=" in arg and arg.startswith("--"):
                flag, _, value = arg.partition("=")
                if flag in upload_flags:
                    add_file(value.lstrip("@").split(";")[0])
            elif arg.startswith("-T") and len(arg) > 2:
                add_file(arg[2:])
            elif arg.startswith("-F") and "@" in arg:
                add_file(arg.split("@", 1)[1].split(";")[0])
            elif arg.startswith("-d@") or arg.startswith("--data=@"):
                add_file(arg.split("@", 1)[1])

            if arg in ("-p", "--port") and i + 1 < len(args):
                try:
                    info["destination_port"] = int(args[i + 1])
                except ValueError:
                    pass
                i += 2
                continue
            i += 1

        # Options that consume the NEXT argument. Without this, `nc -w 6 host
        # 8080` treats the 6-second timeout as the destination port, and the
        # transfer is then judged against a port no policy monitors — so a real
        # exfiltration is waved through.
        value_flags = {
            "-w", "-p", "-s", "-q", "-X", "-x", "-i", "-O", "-P", "-b", "-c",
            "-m", "-o", "-e", "-l", "-t", "-u", "-A", "-B", "-C", "-D", "-E",
            "--port", "--source", "--wait", "--timeout", "--proxy", "--interface",
            "--max-time", "--connect-timeout", "--output", "--header", "-H",
        }
        positional = []
        skip = False
        for a in args:
            if skip:
                skip = False
                continue
            if a in value_flags:
                skip = True
                continue
            if a.startswith("-"):
                continue
            positional.append(a)

        if method in ("scp", "sftp", "rsync"):
            # `scp -f PATH` is what sshd runs on THIS host when a remote client
            # pulls a file off it (`scp user@here:PATH .` from the other end).
            # It is the outbound half of a transfer even though the command was
            # issued remotely, and it is exactly the case that was walking out
            # of the server unnoticed. `-t` is the reverse (incoming write).
            if "-f" in cmd_args or "-t" in cmd_args:
                info["destination"] = "remote SSH client"
                info["destination_port"] = info["destination_port"] or 22
                for i, arg in enumerate(cmd_args):
                    if arg in ("-f", "-t") and i + 1 < len(cmd_args):
                        for token in cmd_args[i + 1:]:
                            if not token.startswith("-"):
                                add_file(token)
                        break
            for a in positional:
                if ":" in a and not os.path.exists(a):
                    host = a.split(":", 1)[0]
                    info["destination"] = a
                    info["destination_host"] = host.split("@")[-1]
                    info["destination_port"] = info["destination_port"] or 22
                else:
                    add_file(a)
        elif method == "netcat":
            # `nc host port` — the payload almost always arrives on stdin,
            # which argv cannot show; the caller falls back to fd inspection.
            hosts = [a for a in positional if not a.isdigit()]
            ports = [a for a in positional if a.isdigit()]
            if hosts:
                info["destination_host"] = hosts[0]
                info["destination"] = hosts[0]
            if ports:
                # The port is the last bare number, after `nc host port`.
                info["destination_port"] = int(ports[-1])
            for a in positional:
                add_file(a)
        elif method in ("ftp", "tftp", "smb_copy", "cloud_cli", "webdav"):
            for a in positional:
                if "://" in a:
                    note_url(a)
                elif os.path.isfile(self._expand_path(a)):
                    add_file(a)
                elif not info["destination_host"] and not a.startswith("s3"):
                    info["destination_host"] = info["destination_host"] or a
            for a in positional:
                if a.startswith(("s3://", "gs://", "az://")):
                    note_url(a)
        else:
            for a in positional:
                add_file(a)

        if not info["destination"] and info["destination_host"]:
            info["destination"] = info["destination_host"]
        return info

    # ---- outbound interception -----------------------------------------

    def _record_exec(self, pid: int, cmd_args: List[str]):
        """Remember every exec briefly, grouped by process group.

        A shell pipeline puts all its members in one process group. When the
        uploading end turns out to be fed by a pipe, this is what identifies
        the source: `cat secret.txt | curl -T -` finishes writing and exits in
        well under a millisecond for a small file, so by the time the upload is
        inspected there is no writer process left to interrogate — but its
        argv, recorded here, still names the file.
        """
        try:
            pgid = os.getpgid(pid)
        except Exception:
            return
        now = time.time()
        with self._net_lock:
            bucket = self._recent_execs.setdefault(pgid, [])
            bucket.append((now, pid, list(cmd_args)))
            # Prune: only the last few seconds of a pipeline can be relevant.
            cutoff = now - 15
            if len(self._recent_execs) > 512 or len(bucket) > 32:
                for key in list(self._recent_execs):
                    kept = [e for e in self._recent_execs[key] if e[0] > cutoff]
                    if kept:
                        self._recent_execs[key] = kept[-32:]
                    else:
                        del self._recent_execs[key]

    def _pipeline_sibling_files(self, pid: int) -> List[str]:
        """Files named by other members of this process's pipeline."""
        try:
            pgid = os.getpgid(pid)
        except Exception:
            return []
        with self._net_lock:
            entries = list(self._recent_execs.get(pgid, []))

        found: List[str] = []
        for _ts, other_pid, argv in entries:
            if other_pid == pid:
                continue
            for token in argv[1:]:
                if token.startswith("-"):
                    continue
                path = self._expand_path(token.strip("'\""))
                if not os.path.isabs(path):
                    continue
                try:
                    if os.path.isfile(path) and path not in found:
                        found.append(path)
                except Exception:
                    continue
        return found

    # Tools whose stdin IS the payload whenever it isn't a terminal.
    _STDIN_STREAMING_TOOLS = {"nc", "ncat", "netcat", "socat", "ssh", "ftp", "lftp", "tftp"}

    def _stdin_is_payload(self, cmd_args: List[str], names: List[str]) -> bool:
        """Whether this invocation actually uploads whatever is on stdin.

        A process can inherit a pipe on stdin without reading it — the common
        `cat urls.txt | while read u; do curl "$u"; done` gives every curl a
        pipe it never touches. Treating that as an upload would block a
        perfectly ordinary loop, so curl/wget must say so explicitly ("-",
        "@-", "=-"); nc/ssh and friends stream stdin by nature.
        """
        if any(self._normalize_exe_name(n) in self._STDIN_STREAMING_TOOLS for n in names):
            return True
        for arg in cmd_args[1:]:
            if arg == "-" or "@-" in arg or arg.endswith("=-"):
                return True
        return False

    def _redirected_source_files(self, pid: int) -> List[str]:
        """Local files reaching a transfer tool other than via its arguments.

        Three shapes matter, and the previous build saw none of them:
          curl --data-binary @- https://host < secret.txt   (regular file on fd 0)
          cat secret.txt | curl -T - https://host           (pipe, writer alive)
          cat secret.txt | gzip | curl -T - https://host    (pipe, writer gone)
        """
        candidates: List[str] = []

        def add(path: str):
            if path and not self.is_excluded_path(path) and path not in candidates:
                candidates.append(path)

        for path in self._open_regular_files(pid):
            add(path)
        if not candidates:
            for path in self._upstream_pipe_files(pid):
                add(path)
        # Only fall back to the pipeline record when stdin really is a pipe —
        # otherwise an unrelated command in the same shell could be blamed.
        if not candidates and self._pipe_inodes(pid, ("0",)):
            for path in self._pipeline_sibling_files(pid):
                add(path)

        if candidates:
            logger.debug(f"pid {pid}: no file in argv, found via fd/pipe/pipeline: {candidates}")
        return candidates

    def _inspect_candidate_process(self, pid: int):
        """Decide on one newly-created process. Mirrors HandleCandidateProcess
        in the Windows agent."""
        if not self.running or not self.has_network_policies:
            return

        cmd_args = self._read_cmdline(pid)
        if not cmd_args:
            return

        # Recorded for EVERY exec, not just transfer tools: a pipeline's other
        # members are what identify the payload when the upload reads from a pipe.
        self._record_exec(pid, cmd_args)

        exe_path = self._read_exe(pid)
        exe_name = Path(exe_path or cmd_args[0]).name
        cmdline = " ".join(cmd_args)

        classified = self._classify_process(exe_name, cmdline, self._candidate_names(exe_path, cmd_args))
        if not classified:
            return
        method, channel = classified
        if channel == "server":
            self._inspect_file_server_process(pid, exe_name, exe_path, cmd_args, method)
            return
        if channel == "session":
            logger.debug(f"{exe_name} pid {pid} is a session worker; egress guard will judge it")
            return
        if not self._method_in_policy_scope(method):
            logger.debug(f"{exe_name} ({method}) is outside the active network policy scope; ignoring")
            return

        suspended = self._suspend(pid, exe_name)
        try:
            info = self._parse_transfer_cmd(method, cmd_args, pid=pid)
            port = info.get("destination_port")
            policy, action = self._network_action_for(method, port)
            if action == "ignore":
                logger.debug(f"No network policy covers {method} to port {port}; ignoring pid {pid}")
                return

            source_files = list(info.get("source_files") or [])

            # The command line is only the first place a file can come from.
            # Redirected stdin and pipes carry the payload without naming it,
            # so a tool that looks argument-free may still be uploading. Both
            # are checked while the process is suspended, before it can read.
            stdin_is_payload = self._stdin_is_payload(cmd_args, self._candidate_names(exe_path, cmd_args))
            if not source_files and stdin_is_payload:
                source_files = self._redirected_source_files(pid)

            if not source_files:
                if stdin_is_payload and self._pipe_inodes(pid, ("0",)):
                    # Something IS being uploaded — stdin is a pipe — but the
                    # writer is already gone, so we cannot see what. Reporting
                    # it as uninspectable hands the decision to the server's
                    # "block content that could not be inspected" policy rather
                    # than letting an unread stream out as if it were Public.
                    logger.info(
                        "%s (pid %d) is uploading from an unidentifiable pipe; "
                        "reporting as uninspectable", exe_name, pid,
                    )
                    outcome = self._decide_and_enforce_network(
                        pid=pid, exe_name=exe_name, exe_path=exe_path, method=method,
                        protocol=info.get("protocol") or method, source_file="",
                        destination=info.get("destination") or "",
                        destination_host=info.get("destination_host") or "",
                        destination_port=port,
                        full_command=info.get("full_command", cmdline),
                        policy=policy, policy_action=action, subtype="cli_upload",
                        inspection_skipped="unreadable",
                    )
                    if outcome == "blocked":
                        suspended = False
                    return
                # Genuinely nothing local to inspect — a plain `curl
                # https://site` is a download, not exfiltration. Staying silent
                # here is what removes the bulk of the old event volume.
                logger.debug(f"{exe_name} pid {pid} references no local file; ignoring")
                return

            for source_file in source_files:
                if self.is_excluded_path(source_file):
                    continue
                key = (pid, source_file)
                with self._net_lock:
                    if key in self._net_handled:
                        continue
                    self._net_handled.add(key)
                    if len(self._net_handled) > 4096:
                        self._net_handled.clear()
                        self._net_handled.add(key)

                decided = self._decide_and_enforce_network(
                    pid=pid,
                    exe_name=exe_name,
                    exe_path=exe_path,
                    method=method,
                    protocol=info.get("protocol") or method,
                    source_file=source_file,
                    destination=info.get("destination") or "",
                    destination_host=info.get("destination_host") or "",
                    destination_port=port,
                    full_command=info.get("full_command", cmdline),
                    policy=policy,
                    policy_action=action,
                    subtype="cli_upload",
                )
                if decided == "blocked":
                    suspended = False      # process is gone
                    break
        finally:
            if suspended:
                self._resume(pid)

    # ---- served-file interception ---------------------------------------

    def _server_document_root(self, pid: int, cmd_args: List[str]) -> Optional[str]:
        """Where a local file server is serving from: an explicit --directory
        argument, else the process's working directory."""
        for i, arg in enumerate(cmd_args):
            if arg in ("-d", "--directory") and i + 1 < len(cmd_args):
                return self._expand_path(cmd_args[i + 1])
            if arg.startswith("--directory="):
                return self._expand_path(arg.split("=", 1)[1])
        try:
            return os.readlink(f"/proc/{pid}/cwd")
        except Exception:
            return None

    def _inspect_file_server_process(self, pid: int, exe_name: str, exe_path: str,
                                     cmd_args: List[str], method: str):
        """Note a local file server that can reach protected data.

        Running a file server is not itself a violation, and stopping it is the
        wrong remedy: it takes the harmless files down with the sensitive ones,
        so nobody can serve a menu from a directory that also holds a payroll
        export. Enforcement belongs on the individual file — the read guard
        refuses the sensitive ones and lets the rest through, with the server
        still running.

        This function therefore only kills the server when there is no read
        guard to do the job properly, and only if the operator has explicitly
        asked for that blunt fallback via network.block_file_servers.
        """
        if not self._method_in_policy_scope(method):
            logger.debug(f"{exe_name} ({method}) is outside the active network policy scope; ignoring")
            return

        policy, action = self._network_action_for(method, self._server_listen_port(pid, cmd_args))
        if action == "ignore":
            return

        root = self._server_document_root(pid, cmd_args)
        if not root or not os.path.isdir(root):
            return
        root = os.path.normpath(os.path.abspath(root))
        if self.is_excluded_path(root):
            return

        # Only content the operator actually asked us to protect counts. With
        # no file/transfer policy paths configured there is nothing to compare
        # against, and treating the whole filesystem as protected is how the
        # previous build ended up alerting on everything.
        protected = [
            os.path.normpath(os.path.abspath(self._expand_path(p)))
            for p in (self.policy_file_paths + self.transfer_protected_paths)
        ]
        protected = [p for p in protected if p]
        if not protected:
            logger.debug("No protected paths configured; not inspecting file-server exposure")
            return

        in_scope = [
            p for p in protected
            if p == root or p.startswith(root + os.sep) or root.startswith(p + os.sep)
        ]
        if not in_scope:
            logger.debug(f"{exe_name} serves {root}, which holds no protected path; ignoring")
            return

        listen_port = self._server_listen_port(pid, cmd_args)

        if self.read_guard_active:
            # The good path. The server runs; its sensitive files are already
            # marked, so a request for one is refused at the open while every
            # other file is served normally. Make sure any file that appeared
            # since the last sweep is marked, then leave the process alone.
            logger.info(
                "Local file server %s (pid %d) serves %s, which holds protected data — "
                "leaving it running; sensitive files are refused per request",
                exe_name, pid, root,
            )
            threading.Thread(target=self.refresh_sensitive_marks, daemon=True,
                             name="CS_MarkOnServe").start()
            return

        if not self.network_cfg.get("block_file_servers", False):
            # No read guard (not root, or the kernel lacks permission events)
            # and no explicit opt-in: report, do not kill. Killing would deny
            # the whole directory, which is a worse outcome than an alert.
            exposed = self._scan_exposed_files(root, in_scope)
            logger.warning(
                "Local file server %s (pid %d) exposes %d protected file(s) under %s, "
                "and the per-file read guard is unavailable — alerting only. "
                "Run the agent as root for per-file blocking, or set "
                "network.block_file_servers=true to stop such servers outright.",
                exe_name, pid, len(exposed), root,
            )
            for candidate in exposed[:1]:
                key = (pid, candidate)
                with self._net_lock:
                    if key in self._net_handled:
                        continue
                    self._net_handled.add(key)
                self._decide_and_enforce_network(
                    pid=pid, exe_name=exe_name, exe_path=exe_path, method=method,
                    protocol="http", source_file=candidate,
                    destination=f"0.0.0.0:{listen_port}" if listen_port else "local file server",
                    destination_host="", destination_port=listen_port,
                    full_command=" ".join(cmd_args),
                    policy=policy, policy_action="alert",
                    subtype="file_server_exposure",
                )
            return

        # Explicit opt-in: stop the server. Blunt by design.
        suspended = self._suspend(pid, exe_name)
        try:
            exposed = self._scan_exposed_files(root, in_scope)
            logger.info(
                "Local file server %s (pid %d) exposes %d protected file(s) under %s",
                exe_name, pid, len(exposed), root,
            )
            for candidate in exposed:
                key = (pid, candidate)
                with self._net_lock:
                    if key in self._net_handled:
                        continue
                    self._net_handled.add(key)

                outcome = self._decide_and_enforce_network(
                    pid=pid,
                    exe_name=exe_name,
                    exe_path=exe_path,
                    method=method,
                    protocol="http",
                    source_file=candidate,
                    destination=f"0.0.0.0:{listen_port}" if listen_port else "local file server",
                    destination_host="",
                    destination_port=listen_port,
                    full_command=" ".join(cmd_args),
                    policy=policy,
                    policy_action=action,
                    subtype="file_server_exposure",
                )
                if outcome == "blocked":
                    suspended = False   # process terminated
                    break
        finally:
            if suspended:
                self._resume(pid)

    def _server_listen_port(self, pid: int, cmd_args: List[str]) -> Optional[int]:
        """The port a local file server was told to listen on."""
        for i, arg in enumerate(cmd_args):
            if arg in ("-p", "--port", "--bind-port") and i + 1 < len(cmd_args):
                try:
                    return int(cmd_args[i + 1])
                except ValueError:
                    continue
        # `python3 -m http.server 8000` — the port is the trailing bare number.
        for arg in reversed(cmd_args):
            if arg.isdigit():
                try:
                    port = int(arg)
                    if 1 <= port <= 65535:
                        return port
                except ValueError:
                    continue
        return 8000 if "http.server" in " ".join(cmd_args) else None

    def _scan_exposed_files(self, root: str, protected: List[str],
                            max_files: int = 200) -> List[str]:
        """Files under `root` that also sit inside a protected path."""
        found: List[str] = []
        for dirpath, dirnames, filenames in os.walk(root):
            # Sorted so the same directory always yields the same first hit —
            # otherwise which file gets named in the event varies per run.
            dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
            for name in sorted(filenames):
                if name.startswith("."):
                    continue
                path = os.path.normpath(os.path.join(dirpath, name))
                if self.is_excluded_path(path):
                    continue
                if not any(path == p or path.startswith(p + os.sep) for p in protected):
                    continue
                exts = self.policy_file_extensions
                if exts and Path(path).suffix.lower() not in exts:
                    continue
                found.append(path)
                if len(found) >= max_files:
                    logger.warning(
                        "File-server exposure scan capped at %d files under %s; "
                        "later files were not inspected", max_files, root,
                    )
                    return found
        return found

    def on_watched_file_read(self, file_path: str):
        """A watched file was opened for reading.

        Only acts when a policy-monitored local file server actually has this
        file open and is talking to a remote client — i.e. the file is being
        served off the box right now. Every other read (editors, backup, the
        agent itself) returns here without a single API call, which is the
        difference between this and the previous build's per-file event storm.
        """
        try:
            if not self.running or not self.has_network_policies:
                return
            if not self.network_cfg.get("inspect_local_file_servers", True):
                return
            if self.is_excluded_path(file_path) or not os.path.isfile(file_path):
                return

            now = time.time()
            last = self._server_read_cooldown.get(file_path, 0)
            if now - last < 5.0:
                return

            server = self._find_serving_process(file_path)
            if not server:
                return

            self._server_read_cooldown[file_path] = now
            if len(self._server_read_cooldown) > 512:
                cutoff = now - 60
                self._server_read_cooldown = {
                    k: v for k, v in self._server_read_cooldown.items() if v > cutoff
                }

            pid = server["pid"]
            method = server["method"]
            conn = server["connection"]
            port = conn["local_port"]

            policy, action = self._network_action_for(method, port)
            if action == "ignore":
                return

            self._decide_and_enforce_network(
                pid=pid,
                exe_name=server["exe_name"],
                exe_path=server["exe_path"],
                method=method,
                protocol="https" if port == 443 else "http",
                source_file=file_path,
                destination=f"{conn['remote_ip']}:{conn['remote_port']}",
                destination_host=conn["remote_ip"],
                destination_port=port,
                full_command=server["cmdline"],
                policy=policy,
                policy_action=action,
                subtype="file_served",
            )
        except Exception as exc:
            logger.debug(f"on_watched_file_read({file_path}) failed: {exc}")

    def _find_serving_process(self, file_path: str) -> Optional[Dict[str, Any]]:
        """Find a local file-server process that holds file_path open and has
        an established remote connection. All three conditions must hold."""
        try:
            target = os.path.realpath(file_path)
        except Exception:
            return None

        conns_by_inode = {c["inode"]: c for c in self._tcp_connections()}
        if not conns_by_inode:
            return None

        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            pid = int(entry)
            if pid == os.getpid():
                continue

            inodes = self._socket_inodes_for_pid(pid)
            live = [conns_by_inode[i] for i in inodes if i in conns_by_inode]
            if not live:
                continue

            cmd_args = self._read_cmdline(pid)
            if not cmd_args:
                continue
            exe_path = self._read_exe(pid)
            exe_name = Path(exe_path or cmd_args[0]).name
            cmdline = " ".join(cmd_args)
            classified = self._classify_process(exe_name, cmdline, self._candidate_names(exe_path, cmd_args))
            if not classified:
                continue
            method, channel = classified
            if channel != "server" or not self._method_in_policy_scope(method):
                continue

            holds_file = False
            for open_file in self._open_regular_files(pid):
                try:
                    if os.path.realpath(open_file) == target:
                        holds_file = True
                        break
                except Exception:
                    continue
            if not holds_file:
                continue

            # Prefer a connection landing on a policy-monitored port.
            connection = next(
                (c for c in live if not self.network_ports or c["local_port"] in self.network_ports),
                live[0],
            )
            return {
                "pid": pid,
                "exe_name": exe_name,
                "exe_path": exe_path,
                "cmdline": cmdline,
                "method": method,
                "connection": connection,
            }
        return None

    # ---- shared decision + enforcement ----------------------------------

    def _decide_and_enforce_network(
        self,
        pid: int,
        exe_name: str,
        exe_path: str,
        method: str,
        protocol: str,
        source_file: str,
        destination: str,
        destination_host: str,
        destination_port: Optional[int],
        full_command: str,
        policy: Optional[Dict[str, Any]],
        policy_action: str,
        subtype: str,
        inspection_skipped: Optional[str] = None,
    ) -> str:
        """Ask the server, then enforce. Returns "blocked" | "alerted" | "allowed"."""
        file_name = Path(source_file).name if source_file else f"{method}_stream"
        file_size = 0
        file_hash = ""
        if source_file:
            try:
                file_size = os.path.getsize(source_file)
                file_hash = self._calculate_file_hash(source_file)
            except Exception:
                pass

        network_context = {
            "protocol": protocol,
            "transfer_method": method,
            "process_name": exe_name,
            "process_path": exe_path,
            "destination_host": destination_host,
            "destination_ip": destination_host if self._is_ip(destination_host) else None,
            "destination_port": destination_port,
            "direction": self.network_direction or "outbound",
        }

        eval_result = self.evaluate_policy_realtime(
            file_name=file_name,
            file_path=source_file,
            dest_path=destination or destination_host,
            event_type="network_exfil",
            network_context=network_context,
            inspection_skipped=inspection_skipped,
        )

        classification_meta = eval_result.get("classification", {}) or {}
        labels = self._labels_from_matched_rules(classification_meta.get("matched_rules", []))
        level = classification_meta.get("level", "Public")
        confidence = classification_meta.get("confidence", 0.0)
        extraction_status = eval_result.get("extraction_status", "readable")
        method_used = "server"

        blocked = False
        if eval_result.get("evaluation_succeeded"):
            server_says_block = str(eval_result.get("action", "allow")).lower() == "block"
            # The policy's own action still governs what we DO about it: a
            # server "block" verdict under an alert-only policy is an alert.
            if server_says_block and policy_action == "block":
                blocked = True
            elif not server_says_block and extraction_status in self.network_block_on and policy_action == "block":
                # "Block Uninspectable / Oversized Content" — the policy asked
                # for this explicitly via blockOn.
                blocked = True
        else:
            # No verdict from the server. Never block on a guess: fall back to
            # the local classifier, and at most alert. Blocking every transfer
            # whenever the console is unreachable is a worse failure than
            # missing one.
            method_used = "regex"
            local = self._classify_content(
                self._read_file_content(source_file, max_bytes=200000) if source_file else ""
            )
            labels = self._labels_in_scope(local.get("labels", []), self.network_data_types)
            confidence = local.get("score", 0.0)
            level = "Confidential" if labels else "Public"
            if labels:
                logger.warning(
                    "Server evaluation unavailable for %s; alerting on local classification only",
                    file_name,
                )

        # Nothing sensitive and nothing to say — stay quiet. This is the single
        # biggest reduction in event volume versus the previous build, which
        # emitted an event for every file it saw regardless of content.
        if (not blocked and not labels and not inspection_skipped
                and eval_result.get("evaluation_succeeded") and level in ("", "Public")):
            logger.debug(f"{file_name} over {method}: classified {level}, no policy interest")
            return "allowed"

        if blocked:
            killed = self._terminate(pid, exe_name)
            if not killed:
                logger.error(
                    "Policy requires blocking %s over %s but the process could not be terminated",
                    file_name, method,
                )
                blocked = False

        if blocked:
            event_action = "blocked"
            severity = "critical"
        elif policy_action in ("alert", "block"):
            event_action = "alerted"
            severity = eval_result.get("alert_severity") or ("high" if labels else "medium")
        else:
            event_action = "logged"
            severity = "low"

        severity = str(severity).lower()
        if severity not in ("low", "medium", "high", "critical"):
            severity = "medium"

        username = self._process_username(pid)
        event_data = {
            "event_id": str(uuid.uuid4()),
            "event_type": "network_exfil",
            "event_subtype": subtype,
            "agent_id": self.agent_id,
            "source_type": "agent",
            "user_email": f"{username}@{socket.gethostname()}",
            "username": username,
            "description": (
                f"{method} transfer of {file_name} to {destination or destination_host or 'remote host'} "
                f"{'blocked' if blocked else event_action}"
            ),
            "severity": severity,
            "action": event_action,
            "channel": "CLI" if subtype == "cli_upload" else "SERVER",
            "process_name": exe_name,
            "process_path": exe_path,
            "process_id": pid,
            "command_line": full_command[:2000],
            "protocol": protocol,
            "transfer_method": method,
            "destination": destination or destination_host,
            "destination_host": destination_host,
            "destination_type": "network_endpoint",
            "direction": self.network_direction or "outbound",
            "source_path": source_file,
            "file_path": source_file,
            "file_name": file_name,
            "file_size": file_size,
            "file_hash": file_hash,
            "classification": {
                "labels": labels,
                "severity": severity,
                "score": confidence,
                "method": method_used,
            },
            "classification_level": level,
            "classification_category": level,
            "classification_labels": labels,
            "classification_rules_matched": labels,
            "classification_score": confidence,
            "blocked": blocked,
            "timestamp": datetime.utcnow().isoformat(),
        }
        if destination_port is not None:
            event_data["destination_port"] = str(destination_port)
        if self._is_ip(destination_host):
            event_data["destination_ip"] = destination_host
        # Attribute the event to what the SERVER actually matched when it told
        # us; its evaluator sees conditions the bundle does not expose. Fall
        # back to the locally-selected policy only when it did not say.
        triggered = eval_result.get("policies_triggered") or []
        if triggered:
            event_data["policy_id"] = triggered[0].get("policy_id")
            event_data["policy_name"] = triggered[0].get("policy_name")
            event_data["policy_action"] = policy_action
            event_data["matched_policies"] = [
                t.get("policy_id") for t in triggered if t.get("policy_id")
            ]
        elif policy:
            event_data["policy_id"] = policy.get("id")
            event_data["policy_name"] = policy.get("name")
            event_data["policy_action"] = policy_action
            if policy.get("id"):
                event_data["matched_policies"] = [policy["id"]]
        if self.active_policy_version:
            event_data["policy_version"] = self.active_policy_version

        self.send_event(event_data)
        return "blocked" if blocked else event_action

    @staticmethod
    def _is_ip(value: str) -> bool:
        if not value:
            return False
        try:
            socket.inet_aton(value)
            return True
        except OSError:
            return False

    @staticmethod
    def _labels_from_matched_rules(matched_rules: List[Any]) -> List[str]:
        labels: List[str] = []
        for rule in matched_rules or []:
            if isinstance(rule, dict):
                for label in rule.get("classification_labels", []) or []:
                    if label not in labels:
                        labels.append(str(label))
                name = rule.get("rule_name")
                if not rule.get("classification_labels") and name and name not in labels:
                    labels.append(str(name))
            elif rule:
                labels.append(str(rule))
        return labels

    # ---- egress guard ----------------------------------------------------

    # Observed destination port -> the method name the server's policies speak,
    # for processes that are not recognisable transfer tools (a browser, a
    # bespoke uploader, an interpreter running someone's script).
    _PORT_METHODS = {
        20: "ftp", 21: "ftp", 22: "scp", 53: "dns_tunnel", 69: "tftp",
        80: "http_post", 443: "http_post", 445: "smb_copy", 873: "rsync",
        989: "ftp", 990: "ftp", 8000: "http_post", 8080: "http_post", 8443: "http_post",
    }

    def _protected_roots(self) -> List[str]:
        """The paths the server's policies declare as worth protecting."""
        roots = []
        for p in (self.policy_file_paths + self.transfer_protected_paths + self.usb_protected_paths):
            if not p:
                continue
            full = os.path.normpath(os.path.abspath(self._expand_path(p)))
            if full not in roots:
                roots.append(full)
        return roots

    def _is_under(self, path: str, roots: List[str]) -> bool:
        for r in roots:
            if path == r or path.startswith(r.rstrip(os.sep) + os.sep):
                return True
        return False

    def egress_guard_loop(self):
        """Watch processes that are actually talking to a remote host and hold
        a protected file open.

        Interception at exec covers a transfer the moment it is launched, but
        it cannot see a process that was already running — a browser upload, a
        long-lived agent of someone else's, an interpreter that opened the file
        minutes after starting. This closes that hole: the set considered is
        only "has an established remote connection on a policy-monitored port"
        AND "holds a file under a protected path open", which on an idle
        machine is the empty set and costs one /proc/net/tcp read per second.

        Note this is interception mid-flight, not before the first byte: the
        process is suspended the moment it is spotted, so the transfer is cut
        off, but a small file may already have been partly written to the
        socket. Launch-time interception above is the pre-emptive layer.
        """
        interval = float(self.network_cfg.get("egress_scan_interval_seconds", 1.0) or 1.0)
        logger.info("Network DLP: egress guard active (protected files + live remote connections)")

        while self.running and self.network_running:
            time.sleep(interval)
            try:
                if not self.has_network_policies:
                    continue
                roots = self._protected_roots()
                if not roots:
                    continue

                conns = self._tcp_connections()
                if not conns:
                    continue
                by_inode = {c["inode"]: c for c in conns}

                for entry in os.listdir("/proc"):
                    if not entry.isdigit():
                        continue
                    pid = int(entry)
                    if pid == os.getpid() or self._is_own_descendant(pid):
                        continue

                    # Check the file first: it is the cheap, selective test.
                    held = [f for f in self._open_regular_files(pid)
                            if self._is_under(f, roots) and not self.is_excluded_path(f)]
                    if not held:
                        continue

                    # The connection may belong to an ancestor rather than to
                    # this process. sshd owns the socket while its sftp-server
                    # child does the reading, so looking only at the reader's
                    # own fds finds nothing and an SFTP pull walks out.
                    conn = self._connection_for_pid_or_parents(pid, by_inode)
                    if not conn:
                        continue

                    self._handle_egress_candidate(pid, conn, held)
            except Exception as exc:
                logger.debug(f"Egress guard error: {exc}")

    def _connection_for_pid_or_parents(self, pid: int, by_inode: Dict[int, Dict[str, Any]],
                                       depth: int = 4) -> Optional[Dict[str, Any]]:
        """An established remote connection owned by this process or an ancestor.

        A forking server hands the work to a child that inherits no socket:
        sshd keeps the network fd and sftp-server reads the file. Attributing
        the child's read to the parent's connection is what makes an SFTP pull
        visible at all.
        """
        current = pid
        for _ in range(depth):
            if current <= 1:
                break
            for inode in self._socket_inodes_for_pid(current):
                if inode in by_inode:
                    return by_inode[inode]
            current = self._parent_pid(current)
        return None

    def _handle_egress_candidate(self, pid: int, conn: Dict[str, Any], held: List[str]):
        cmd_args = self._read_cmdline(pid)
        if not cmd_args:
            return
        exe_path = self._read_exe(pid)
        exe_name = Path(exe_path or cmd_args[0]).name
        if exe_name.lower() in self._never_terminate:
            return

        classified = self._classify_process(exe_name, " ".join(cmd_args),
                                            self._candidate_names(exe_path, cmd_args))
        if classified and classified[1] in ("server", "session") and self.read_guard_active:
            # A file server or SFTP worker holding a protected file open is the
            # read guard's business, and it handles it without killing anything:
            # the sensitive file is refused, the rest of the session continues.
            # Terminating here would take down the whole server again.
            logger.debug(
                f"{exe_name} (pid {pid}) is a {classified[1]} channel; "
                f"the read guard decides per file"
            )
            return
        if classified:
            method = classified[0]
        else:
            port = conn["remote_port"] if conn["remote_port"] in self._PORT_METHODS else conn["local_port"]
            method = self._PORT_METHODS.get(port, "http_post")

        # Only fire for pairs we have not already ruled on.
        fresh = []
        with self._net_lock:
            for f in held:
                key = (pid, f)
                if key in self._net_handled:
                    continue
                self._net_handled.add(key)
                fresh.append(f)
            if len(self._net_handled) > 4096:
                self._net_handled.clear()
        if not fresh:
            return

        policy, action = self._network_action_for(method, conn["local_port"])
        if action == "ignore":
            policy, action = self._network_action_for(method, conn["remote_port"])
        if action == "ignore":
            return

        logger.info(
            "Egress guard: %s (pid %d) holds %d protected file(s) open while connected to %s:%d",
            exe_name, pid, len(fresh), conn["remote_ip"], conn["remote_port"],
        )
        suspended = self._suspend(pid, exe_name)
        try:
            for source_file in fresh:
                outcome = self._decide_and_enforce_network(
                    pid=pid,
                    exe_name=exe_name,
                    exe_path=exe_path,
                    method=method,
                    protocol="https" if conn["remote_port"] == 443 else "tcp",
                    source_file=source_file,
                    destination=f"{conn['remote_ip']}:{conn['remote_port']}",
                    destination_host=conn["remote_ip"],
                    destination_port=conn["remote_port"],
                    full_command=" ".join(cmd_args),
                    policy=policy,
                    policy_action=action,
                    subtype="egress_in_flight",
                )
                if outcome == "blocked":
                    suspended = False
                    break
        finally:
            if suspended:
                self._resume(pid)

    # ---- process-creation sources ---------------------------------------

    def network_monitor_loop(self):
        """Watch for new processes and hand each candidate to the interceptor.

        Prefers the kernel's netlink proc connector (an exec notification, the
        Linux analogue of the WMI __InstanceCreationEvent the Windows agent
        subscribes to). Falls back to a 1s /proc diff when that is
        unavailable — typically because the agent is not running as root.
        """
        self.network_running = True
        self._suspended_pids: Set[int] = getattr(self, "_suspended_pids", set())

        # Everything already running when the agent starts is pre-existing, not
        # an intercepted transfer. Without this seeding, every long-lived
        # process on the box produced an event the moment the agent came up.
        self._net_boot_pids = self._current_pids()
        logger.info(f"Network DLP: {len(self._net_boot_pids)} pre-existing processes ignored")

        # ...ignored for exec-time interception, but a file server that was
        # ALREADY serving protected data when the agent started is exactly the
        # situation to catch, not skip. Judge those once, up front.
        self._scan_existing_file_servers()

        if self.network_cfg.get("egress_guard", True):
            threading.Thread(target=self.egress_guard_loop, daemon=True,
                             name="CS_EgressGuard").start()

        if self._run_proc_connector():
            return
        logger.info("Netlink proc connector unavailable; falling back to /proc polling")
        self._run_proc_polling()

    def _scan_existing_file_servers(self):
        """Judge local file servers that predate the agent.

        `python3 -m http.server` started before the agent would otherwise be
        invisible: exec interception never saw it, and the egress guard only
        notices it during the instant it holds a file open — which for a small
        file is far too brief to rely on.
        """
        if not self.has_network_policies:
            return
        if not self.network_cfg.get("inspect_local_file_servers", True):
            return
        for entry in list(os.listdir("/proc")):
            if not entry.isdigit():
                continue
            pid = int(entry)
            if pid == os.getpid() or self._is_own_descendant(pid):
                continue
            cmd_args = self._read_cmdline(pid)
            if not cmd_args:
                continue
            exe_path = self._read_exe(pid)
            exe_name = Path(exe_path or cmd_args[0]).name
            classified = self._classify_process(exe_name, " ".join(cmd_args),
                                                self._candidate_names(exe_path, cmd_args))
            if not classified or classified[1] != "server":
                continue
            logger.info(f"Found a local file server already running: {exe_name} (pid {pid})")
            try:
                self._inspect_file_server_process(pid, exe_name, exe_path, cmd_args, classified[0])
            except Exception as exc:
                logger.debug(f"Could not judge existing file server pid {pid}: {exc}")

    @staticmethod
    def _current_pids() -> Set[int]:
        pids = set()
        try:
            for entry in os.listdir("/proc"):
                if entry.isdigit():
                    pids.add(int(entry))
        except Exception:
            pass
        return pids

    def _run_proc_connector(self) -> bool:
        """Subscribe to kernel exec events. Returns False if unavailable."""
        NETLINK_CONNECTOR = 11
        CN_IDX_PROC = 1
        CN_VAL_PROC = 1
        PROC_CN_MCAST_LISTEN = 1
        PROC_EVENT_EXEC = 0x00000002

        nlmsg = struct.Struct("=IHHII")     # len, type, flags, seq, pid
        cnmsg = struct.Struct("=IIIIHH")    # idx, val, seq, ack, len, flags

        NLMSG_DONE = 3

        sock = None
        try:
            sock = socket.socket(socket.AF_NETLINK, socket.SOCK_DGRAM, NETLINK_CONNECTOR)
            sock.bind((os.getpid(), CN_IDX_PROC))

            payload = struct.pack("=I", PROC_CN_MCAST_LISTEN)
            cn = cnmsg.pack(CN_IDX_PROC, CN_VAL_PROC, 0, 0, len(payload), 0) + payload
            msg = nlmsg.pack(nlmsg.size + len(cn), NLMSG_DONE, 0, 0, os.getpid()) + cn
            sock.send(msg)
            sock.settimeout(1.0)
        except Exception as exc:
            # Binding the connector needs CAP_NET_ADMIN; a non-root agent lands
            # here and uses the polling fallback instead.
            logger.info(f"Could not subscribe to the proc connector ({exc})")
            if sock:
                sock.close()
            return False

        logger.info("Network DLP: listening for process exec events (netlink proc connector)")
        header_len = nlmsg.size + cnmsg.size
        while self.running and self.network_running:
            try:
                data = sock.recv(1024)
            except socket.timeout:
                continue
            except Exception as exc:
                logger.warning(f"Proc connector read failed: {exc}")
                break

            if len(data) < header_len + 16:
                continue
            try:
                what = struct.unpack_from("=I", data, header_len)[0]
                if what != PROC_EVENT_EXEC:
                    continue
                # exec_proc_event { pid, tgid } at the start of event_data
                pid = struct.unpack_from("=i", data, header_len + 16)[0]
            except Exception:
                continue

            if pid <= 1 or pid == os.getpid():
                continue

            # Record synchronously, before spawning the inspection thread. A
            # short-lived pipeline member (`cat secret.txt | curl …`) can be
            # gone by the time a thread starts, and once it exits its argv —
            # the only remaining evidence of what is in the pipe — is lost.
            cmd_args = self._read_cmdline(pid)
            if cmd_args:
                self._record_exec(pid, cmd_args)

            threading.Thread(
                target=self._safe_inspect, args=(pid,), daemon=True,
                name=f"CS_NetInspect{pid}",
            ).start()

        try:
            sock.close()
        except Exception:
            pass
        return True

    def _run_proc_polling(self):
        """Fallback: diff /proc for new PIDs."""
        interval = float(self.network_cfg.get("scan_interval_seconds", 1.0) or 1.0)
        known = set(self._net_boot_pids)
        while self.running and self.network_running:
            try:
                current = self._current_pids()
                for pid in current - known:
                    self._safe_inspect(pid)
                known = current
                if len(known) > 65536:
                    known = self._current_pids()
            except Exception as exc:
                logger.debug(f"Network polling error: {exc}")
            time.sleep(interval)

    def _safe_inspect(self, pid: int):
        try:
            self._inspect_candidate_process(pid)
        except Exception as exc:
            logger.debug(f"Network inspection failed for pid {pid}: {exc}")

    # ==================================================================
    # Sensitive-file read guard (fanotify)
    # ==================================================================
    #
    # The question this answers: a file server is running and should keep
    # running — how do you serve the harmless files in a directory and refuse
    # only the sensitive ones?
    #
    # Not by killing the server (that takes the harmless files down too) and
    # not by chmod'ing the data (that locks the owner out of their own files).
    # The answer is to intercept the *open* and refuse that one read:
    # fanotify's FAN_OPEN_PERM hands us the pid and the file and waits for a
    # verdict, so `curl host:8069/menu.txt` succeeds while
    # `curl host:8069/CPA.txt` gets nothing — same server, still running.
    #
    # Only files already classified sensitive are marked, so the permission
    # queue stays tiny and an unmarked file is never slowed down. Every failure
    # path answers ALLOW: a DLP agent must not be able to wedge the machine.

    FAN_CLOEXEC = 0x00000001
    FAN_NONBLOCK = 0x00000002
    FAN_CLASS_CONTENT = 0x00000004
    FAN_OPEN_PERM = 0x00010000
    FAN_ALLOW = 0x01
    FAN_DENY = 0x02
    FAN_MARK_ADD = 0x00000001
    FAN_MARK_REMOVE = 0x00000002
    FAN_MARK_FLUSH = 0x00000080
    AT_FDCWD = -100

    # struct fanotify_event_metadata
    _FAN_EVENT = struct.Struct("=IBBHQii")     # len, vers, reserved, meta_len, mask, fd, pid
    # struct fanotify_response
    _FAN_RESPONSE = struct.Struct("=iI")       # fd, response

    def _fanotify_available(self) -> bool:
        return bool(self._fan_fd is not None and self._fan_fd >= 0)

    def start_read_guard(self) -> bool:
        """Arm the per-file read guard. Returns False when unavailable."""
        if not self.network_cfg.get("file_read_guard", True):
            logger.info("Sensitive-file read guard disabled by config")
            return False
        if os.geteuid() != 0:
            logger.warning("Read guard needs root (CAP_SYS_ADMIN); per-file blocking is off")
            return False
        try:
            self._libc = ctypes.CDLL("libc.so.6", use_errno=True)
            fd = self._libc.fanotify_init(
                self.FAN_CLOEXEC | self.FAN_CLASS_CONTENT | self.FAN_NONBLOCK,
                os.O_RDONLY,
            )
            if fd < 0:
                err = ctypes.get_errno()
                logger.warning(
                    f"fanotify_init failed (errno {err}: {os.strerror(err)}); "
                    "per-file blocking is off"
                )
                return False
            self._fan_fd = fd
        except Exception as exc:
            logger.warning(f"Could not initialise the read guard: {exc}")
            return False

        threading.Thread(target=self._read_guard_loop, daemon=True,
                         name="CS_ReadGuard").start()
        threading.Thread(target=self._mark_refresh_loop, daemon=True,
                         name="CS_MarkRefresh").start()
        logger.info("Sensitive-file read guard armed (network reads of sensitive files will be refused)")
        return True

    def stop_read_guard(self):
        """Close the fanotify fd. The kernel then releases anything waiting on
        a verdict, so a stopping agent can never leave a process blocked."""
        fd, self._fan_fd = self._fan_fd, None
        if fd is not None and fd >= 0:
            try:
                os.close(fd)
            except Exception:
                pass
            logger.info("Sensitive-file read guard released")

    def _fanotify_mark(self, path: str, add: bool = True) -> bool:
        if not self._fanotify_available():
            return False
        flags = self.FAN_MARK_ADD if add else self.FAN_MARK_REMOVE
        try:
            mask = ctypes.c_uint64(self.FAN_OPEN_PERM)
            rc = self._libc.fanotify_mark(
                ctypes.c_int(self._fan_fd), ctypes.c_uint(flags), mask,
                ctypes.c_int(self.AT_FDCWD), path.encode("utf-8"),
            )
            if rc < 0:
                err = ctypes.get_errno()
                if add or err != errno.ENOENT:
                    logger.debug(f"fanotify_mark({path}, add={add}) failed: {os.strerror(err)}")
                return False
            return True
        except Exception as exc:
            logger.debug(f"fanotify_mark({path}) raised: {exc}")
            return False

    # ---- deciding which files are sensitive ---------------------------

    def _file_is_sensitive(self, path: str) -> Optional[bool]:
        """Ask the server whether this file is sensitive, with a cache keyed on
        (size, mtime) so an unchanged file is classified once. Returns None
        when we could not find out."""
        try:
            st = os.stat(path)
        except Exception:
            return None
        key = (st.st_size, int(st.st_mtime))
        cached = self._sensitive_cache.get(path)
        if cached and cached[0] == key:
            return cached[1]

        result = self.evaluate_policy_realtime(
            file_name=Path(path).name,
            file_path=path,
            dest_path="network",
            event_type="network_exfil",
            network_context={"direction": "outbound", "transfer_method": "http_server"},
        )
        if not result.get("evaluation_succeeded"):
            # Fall back to the local classifier rather than guessing "safe".
            local = self._classify_content(self._read_file_content(path, max_bytes=200000))
            sensitive = bool(local.get("labels"))
            if not sensitive:
                return None     # don't cache a verdict we aren't sure about
        else:
            level = (result.get("classification") or {}).get("level", "Public")
            sensitive = (
                str(result.get("action", "allow")).lower() == "block"
                or level in ("Confidential", "Restricted")
            )

        self._sensitive_cache[path] = (key, sensitive)
        return sensitive

    def refresh_sensitive_marks(self):
        """Mark every sensitive file under the protected paths, unmark the rest."""
        if not self._fanotify_available():
            return
        roots = self._protected_roots()
        if not roots:
            return

        cap = int(self.network_cfg.get("file_read_guard_max_files", 500) or 500)
        seen: Set[str] = set()
        scanned = 0
        truncated = False

        for root in roots:
            if not os.path.isdir(root):
                if os.path.isfile(root):
                    candidates = [root]
                else:
                    continue
            else:
                candidates = []
                for dirpath, dirnames, filenames in os.walk(root):
                    dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
                    for name in sorted(filenames):
                        if not name.startswith("."):
                            candidates.append(os.path.join(dirpath, name))

            for path in candidates:
                if scanned >= cap:
                    truncated = True
                    break
                if self.is_excluded_path(path):
                    continue
                scanned += 1
                verdict = self._file_is_sensitive(path)
                if verdict is None:
                    continue
                if verdict:
                    seen.add(path)
                    if path not in self._marked_files and self._fanotify_mark(path, add=True):
                        self._marked_files.add(path)
                        logger.info(f"Sensitive file guarded against network reads: {path}")
                elif path in self._marked_files:
                    self._fanotify_mark(path, add=False)
                    self._marked_files.discard(path)
                    logger.info(f"No longer sensitive, guard removed: {path}")
            if truncated:
                break

        if truncated:
            logger.warning(
                f"Read guard scanned only the first {cap} files under the protected paths; "
                f"raise network.file_read_guard_max_files to cover the rest"
            )

        # Drop marks for files that disappeared.
        for path in list(self._marked_files):
            if path not in seen and not os.path.exists(path):
                self._marked_files.discard(path)
                self._sensitive_cache.pop(path, None)

    def _mark_refresh_loop(self):
        interval = float(self.network_cfg.get("file_read_guard_refresh_seconds", 60) or 60)
        while self.running and self._fanotify_available():
            try:
                self.refresh_sensitive_marks()
            except Exception as exc:
                logger.debug(f"Mark refresh failed: {exc}")
            time.sleep(interval)

    def on_guarded_file_changed(self, path: str):
        """Re-evaluate one file's mark after it was created or modified.

        A rewritten file is a new inode, so its old mark is gone — without this
        an edited sensitive file would quietly stop being guarded.
        """
        if not self._fanotify_available():
            return
        try:
            if not self._is_under(os.path.abspath(path), self._protected_roots()):
                return
            self._marked_files.discard(path)
            self._sensitive_cache.pop(path, None)
            verdict = self._file_is_sensitive(path)
            if verdict and self._fanotify_mark(path, add=True):
                self._marked_files.add(path)
                logger.info(f"Sensitive file guarded against network reads: {path}")
        except Exception as exc:
            logger.debug(f"Could not refresh guard for {path}: {exc}")

    # ---- who is allowed to read a guarded file ------------------------

    def _reader_is_network_channel(self, pid: int) -> Optional[Tuple[str, str]]:
        """Is this reader moving the file off the machine?

        Returns (process name, transfer method) when the process — or an
        ancestor, so an sftp-server under sshd counts — is a transfer tool, a
        local file server or a session worker. Returns None for ordinary local
        access, which is never interfered with: the point is to stop the file
        leaving, not to stop its owner reading it.
        """
        current = pid
        for _ in range(4):
            if current <= 1:
                break
            cmd_args = self._read_cmdline(current)
            if cmd_args:
                exe_path = self._read_exe(current)
                exe_name = Path(exe_path or cmd_args[0]).name
                classified = self._classify_process(
                    exe_name, " ".join(cmd_args),
                    self._candidate_names(exe_path, cmd_args),
                )
                if classified:
                    return exe_name, classified[0]
            current = self._parent_pid(current)
        return None

    def _read_guard_loop(self):
        """Answer permission events. Every path answers, always."""
        import select
        poller = select.poll()
        try:
            poller.register(self._fan_fd, select.POLLIN)
        except Exception as exc:
            logger.error(f"Read guard could not poll its descriptor: {exc}")
            return

        while self.running and self._fanotify_available():
            try:
                if not poller.poll(500):
                    continue
                fd = self._fan_fd
                if fd is None or fd < 0:
                    break
                buf = os.read(fd, 8192)
            except (OSError, TypeError):
                continue
            except Exception as exc:
                logger.debug(f"Read guard read failed: {exc}")
                continue

            offset = 0
            while offset + self._FAN_EVENT.size <= len(buf):
                try:
                    (event_len, _vers, _res, _meta_len, mask,
                     event_fd, pid) = self._FAN_EVENT.unpack_from(buf, offset)
                except Exception:
                    break
                offset += max(event_len, self._FAN_EVENT.size)
                if event_fd < 0:
                    continue
                # Decide, then ALWAYS respond and close.
                allow = True
                try:
                    allow = self._decide_guarded_open(event_fd, pid, mask)
                except Exception as exc:
                    logger.error(f"Read guard decision failed (allowing): {exc}")
                    allow = True
                finally:
                    try:
                        os.write(self._fan_fd, self._FAN_RESPONSE.pack(
                            event_fd, self.FAN_ALLOW if allow else self.FAN_DENY))
                    except Exception as exc:
                        logger.error(f"Read guard could not answer the kernel: {exc}")
                    try:
                        os.close(event_fd)
                    except Exception:
                        pass

    def _decide_guarded_open(self, event_fd: int, pid: int, mask: int) -> bool:
        """True to allow the open, False to refuse it.

        Runs on the responder thread, which the kernel is waiting on. It must
        therefore never open a guarded file, never make a network call, and
        never take a lock another thread could hold while opening one — any of
        those and the opener waits on a verdict that cannot arrive. Only cheap
        /proc reads happen here; everything else is handed to a worker.
        """
        if pid == os.getpid():
            return True          # our own classification reads

        try:
            path = os.readlink(f"/proc/self/fd/{event_fd}")
        except Exception:
            return True

        channel = self._reader_is_network_channel(pid)
        if not channel:
            # Local access — a user reading their own file, an editor, a
            # backup. Allowed, and deliberately not even logged: this is the
            # common case and it is not an incident.
            logger.debug(f"Local read of guarded file allowed: {path} (pid {pid})")
            return True

        exe_name, method = channel
        policy, action = self._network_action_for(method, None)
        if action != "block":
            logger.info(
                "%s read guarded file %s; policy action is %s, allowing",
                exe_name, path, action,
            )
            return True

        logger.warning(
            "REFUSED: %s (pid %d) tried to read sensitive file %s over %s",
            exe_name, pid, path, method,
        )
        self._send_read_denied_event(path, pid, exe_name, method, policy)
        return False

    def _send_read_denied_event(self, path: str, pid: int, exe_name: str,
                                method: str, policy: Optional[Dict[str, Any]]):
        """Report a refused read, deduplicated per (pid, path)."""
        key = (pid, path)
        now = time.time()
        with self._net_lock:
            last = self._denied_reported.get(key, 0)
            if now - last < 10.0:
                return
            self._denied_reported[key] = now
            if len(self._denied_reported) > 2048:
                self._denied_reported = {
                    k: v for k, v in self._denied_reported.items() if now - v < 60
                }

        username = self._process_username(pid)
        remote = ""
        try:
            by_inode = {c["inode"]: c for c in self._tcp_connections()}
            conn = self._connection_for_pid_or_parents(pid, by_inode)
            if conn:
                remote = f"{conn['remote_ip']}:{conn['remote_port']}"
        except Exception:
            pass

        event_data: Dict[str, Any] = {
            "event_id": str(uuid.uuid4()),
            "event_type": "network_exfil",
            "event_subtype": "file_read_denied",
            "agent_id": self.agent_id,
            "source_type": "agent",
            "user_email": f"{username}@{socket.gethostname()}",
            "username": username,
            "description": (
                f"Refused network read of sensitive file {Path(path).name} "
                f"by {exe_name} over {method}"
                + (f" to {remote}" if remote else "")
            ),
            "severity": "critical",
            "action": "blocked",
            "channel": "FILE_READ",
            "process_name": exe_name,
            "process_id": pid,
            "transfer_method": method,
            "protocol": "http" if "http" in method else method,
            "destination": remote or "remote client",
            "destination_type": "network_endpoint",
            "direction": self.network_direction or "outbound",
            "source_path": path,
            "file_path": path,
            "file_name": Path(path).name,
            "blocked": True,
            "timestamp": datetime.utcnow().isoformat(),
        }
        if remote:
            event_data["destination_host"] = remote.split(":")[0]
            event_data["destination_ip"] = remote.split(":")[0]
        try:
            event_data["file_size"] = os.path.getsize(path)
        except Exception:
            pass
        if policy:
            event_data["policy_id"] = policy.get("id")
            event_data["policy_name"] = policy.get("name")
            event_data["policy_action"] = "block"
            if policy.get("id"):
                event_data["matched_policies"] = [policy["id"]]
        if self.active_policy_version:
            event_data["policy_version"] = self.active_policy_version

        def _finish():
            # Hashing OPENS the file, and the file is guarded — doing that on
            # the responder thread would make it wait for a verdict only it can
            # give. Deadlocks the opener and every later event with it. Off the
            # responder thread the open is answered normally (our own pid is
            # always allowed), so it is safe here and nowhere else.
            try:
                event_data["file_hash"] = self._calculate_file_hash(path)
            except Exception:
                pass
            self.send_event(event_data)

        threading.Thread(target=_finish, daemon=True, name="CS_DeniedEvent").start()

    # ==================================================================
    # Permission repair
    # ==================================================================

    def repair_permissions(self, roots: List[str], apply_changes: bool = False) -> int:
        """Undo the damage the old "sensitive file protector" did.

        That loop chown'd matching files to root:root 0600 (or chmod 000 when
        chown failed), which is why files under test became unreadable to
        their owner. This restores any root-owned 0600/0000 file inside a user
        directory back to that directory's owner with 0644. Dry-run unless
        apply_changes is set.
        """
        import pwd
        repaired = 0
        for root_path in roots:
            root_path = os.path.abspath(self._expand_path(root_path))
            if not os.path.isdir(root_path):
                logger.warning(f"Not a directory, skipping: {root_path}")
                continue
            try:
                owner_uid = os.stat(root_path).st_uid
                owner_gid = os.stat(root_path).st_gid
            except Exception as exc:
                logger.warning(f"Cannot stat {root_path}: {exc}")
                continue
            if owner_uid == 0:
                logger.warning(
                    f"{root_path} is itself root-owned; refusing to guess an owner for its files"
                )
                continue
            try:
                owner_name = pwd.getpwuid(owner_uid).pw_name
            except Exception:
                owner_name = str(owner_uid)

            for dirpath, _dirs, files in os.walk(root_path):
                for name in files:
                    path = os.path.join(dirpath, name)
                    try:
                        st = os.lstat(path)
                    except Exception:
                        continue
                    if not (st.st_mode & 0o170000) == 0o100000:   # regular files only
                        continue
                    mode = st.st_mode & 0o777
                    if st.st_uid != 0 or mode not in (0o600, 0o000):
                        continue
                    repaired += 1
                    if not apply_changes:
                        print(f"[dry-run] {path}  root:root {mode:04o} -> {owner_name} 0644")
                        continue
                    try:
                        os.chown(path, owner_uid, owner_gid)
                        os.chmod(path, 0o644)
                        print(f"[fixed]   {path}  -> {owner_name} 0644")
                    except Exception as exc:
                        print(f"[failed]  {path}: {exc}")
        return repaired

    # ==================================================================
    # Diagnostics
    # ==================================================================

    def print_effective_policy(self):
        """Show exactly what this agent will enforce, and why.

        The old build's behaviour was impossible to predict from the console:
        hardcoded policy IDs, a fallback that turned file-copy policies into
        network policies, and enforcement that ignored the configured action.
        This prints the resolved decision surface so it can be checked against
        the console before the agent is turned loose.
        """
        def line(label, value):
            label = str(label)
            pad = " " * max(1, 34 - len(label))
            print(f"  {label}{pad}{value}")

        print("-" * 60)
        print(f"Agent            : {self.agent_id}  ({self.config.get('agent_name')})")
        print(f"Server           : {self.server_url}")
        print(f"Policy bundle    : {self.active_policy_version or 'NONE'} "
              f"(sync {self.last_policy_sync_status})")
        if self.last_policy_sync_error:
            print(f"Sync error       : {self.last_policy_sync_error[:200]}")
        print("-" * 60)

        print("FILE SYSTEM MONITORING")
        if not self.has_file_policies:
            line("status", "inactive — no policy")
        else:
            for p in self.file_policies:
                cfg = p.get("config", {}) or {}
                line(p.get("name", "?"), f"action={cfg.get('action', 'log')}")
            line("watching paths", self._resolve_monitored_paths() or "(none resolved)")
            line("extensions", self.policy_file_extensions or "(any)")

        print("FILE TRANSFER MONITORING")
        if not self.has_file_transfer_policies:
            line("status", "inactive — no policy")
        else:
            for p in self.file_transfer_policies:
                cfg = p.get("config", {}) or {}
                line(p.get("name", "?"), f"action={cfg.get('action', 'alert')}")
            line("protected sources", self.transfer_protected_paths or "(none)")
            line("watched destinations", self.transfer_destination_paths or "(none)")

        print("USB")
        if not (self.has_usb_device_policies or self.has_usb_transfer_policies):
            line("status", "inactive — no policy")
        else:
            for p in self.usb_device_policies:
                cfg = p.get("config", {}) or {}
                line(p.get("name", "?"), f"device action={cfg.get('action', 'alert')} events={cfg.get('events', {})}")
            for p in self.usb_transfer_policies:
                cfg = p.get("config", {}) or {}
                scope = cfg.get("monitoredPaths") or "content-gated (server decides per file)"
                line(p.get("name", "?"), f"transfer action={cfg.get('action', 'alert')} scope={scope}")
            line("file extensions", sorted(self._usb_policy_extensions()) or "(any)")

        print("CLIPBOARD")
        if not self.has_clipboard_policies:
            line("status", "inactive — no policy")
        else:
            for p in self.clipboard_policies:
                cfg = p.get("config", {}) or {}
                line(p.get("name", "?"), f"action={cfg.get('action', 'alert')}")

        print("NETWORK DLP")
        if not self.has_network_policies:
            line("status", "inactive — no policy")
        else:
            for p in self.network_policies:
                cfg = p.get("config", {}) or {}
                line(p.get("name", "?"), f"action={cfg.get('action', 'alert')} priority={p.get('priority')}")
            line("transfer methods", sorted(self.network_methods) or "(any)")
            line("destination ports", (f"{sorted(self.network_ports)} "
                                       f"— informational; a matched method is enforced on ANY port")
                                      if self.network_ports else "(any)")
            line("data types", sorted(self.network_data_types) or "(any)")
            line("block on uninspectable", sorted(self.network_block_on) or "(no)")
            line("direction", self.network_direction)
            print("  resolved decisions:")
            for method in sorted(self.network_methods or {"curl", "scp", "python_http_server"}):
                pol, action = self._network_action_for(method, None)
                print(f"    {method:<22} -> {action:<8} ({pol.get('name') if pol else 'no policy'})")
        print("-" * 60)


def main():
    """Main entry point"""
    import argparse
    parser = argparse.ArgumentParser(description="CyberSentinel DLP - Linux Agent")
    parser.add_argument(
        "--config",
        dest="config_path",
        default=None,
        help="Path to agent_configure.json (default: auto-detected — checks "
             "/etc/cybersentinel/agent_configure.json, then the script's own "
             "directory, then the current directory, then ~/agent_configure.json)",
    )
    parser.add_argument(
        "--repair-permissions",
        dest="repair_paths",
        nargs="+",
        metavar="DIR",
        help="Restore files an older agent build locked to root:root 0600/0000 "
             "back to the directory owner with mode 0644. Lists what it would "
             "change and exits; pass --apply to actually change them.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="With --repair-permissions: perform the changes instead of a dry run.",
    )
    parser.add_argument(
        "--dump-policies",
        action="store_true",
        help="Register, fetch the policy bundle, print what this agent would "
             "enforce, and exit. Nothing is monitored, blocked or reported.",
    )
    args = parser.parse_args()

    print("=" * 60)
    print(f"CyberSentinel DLP - Linux Agent v{AGENT_VERSION}")
    print("=" * 60)
    print()

    if args.repair_paths:
        agent = DLPAgent(config_path=args.config_path)
        if args.apply and os.geteuid() != 0:
            print("--apply needs root to change ownership. Re-run with sudo.")
            return 1
        count = agent.repair_permissions(args.repair_paths, apply_changes=args.apply)
        if not count:
            print("No root-locked files found.")
        elif not args.apply:
            print(f"\n{count} file(s) would be restored. Re-run with --apply to do it.")
        else:
            print(f"\n{count} file(s) restored.")
        return 0

    agent = DLPAgent(config_path=args.config_path)

    if args.dump_policies:
        agent.dry_run = True
        agent.register_agent()
        agent.sync_policies(initial=True)
        agent.print_effective_policy()
        return 0

    if os.geteuid() != 0:
        logger.warning(
            "Not running as root: process suspension/termination and USB device "
            "controls will not work. Network DLP will detect and alert only."
        )

    # Register signal handlers for graceful shutdown
    def signal_handler(signum, frame):
        logger.info(f"Received signal {signum}, shutting down...")
        agent.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    # Register atexit handler as backup
    atexit.register(agent.stop)

    agent.start()
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
