"""
Windows agent distribution — where an endpoint gets the installer and the binary.

Endpoints used to pull both straight from ``raw.githubusercontent.com``. That
worked only while the repository was public. The moment it went private every
install, every update and every "is there a newer build?" check began answering
404 — and because GitHub returns 404 rather than 403 for a private path, the
failure reads as "the file was deleted from the repo" on a repo where the file
is present and correct. That misdirection is the expensive part.

Serving the artifacts from the manager fixes it properly, rather than by
re-publishing the source tree to the world:

  * every managed device already talks to this server, on this port, before it
    holds any credential of its own. It is the one origin that is reachable by
    definition — if it isn't, the agent has nothing to report to either.
  * a GitHub token, when one is configured to refresh the cache, stays on the
    server. Nothing that can read private source is ever handed to an endpoint,
    which is what putting a PAT in the install one-liner would have done.
  * a site with no egress can stage the same four files by hand into
    ``server/agent_dist`` and never talk to GitHub at all.

These routes are UNAUTHENTICATED and EXEMPT from the portal IP allowlist, for
the same reasons the browser-extension feed is: a machine mid-install has no
session to present, and a laptop off the corporate network must still be able to
take an agent update.

Cache consistency is the one thing worth being strict about. The installer
verifies the binary against its ``.sha256`` sidecar and refuses to install on a
mismatch, reporting a "tampered or corrupt binary" — so publishing a new sidecar
next to an old binary would turn a routine refresh into what looks like a supply
chain attack. The refresh below therefore only ever moves the trio
(exe, sha256, version) forward together, and on any failure keeps serving the
last set that was internally consistent.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import pathlib
import time
from typing import Optional

import httpx
import structlog
from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import FileResponse, PlainTextResponse

logger = structlog.get_logger()
router = APIRouter()

# server/app/api/v1/agent_dist.py -> server/agent_dist
DIST_DIR = pathlib.Path(__file__).resolve().parents[3] / "agent_dist"

SCRIPT_NAME = "manage-windows-agent.ps1"
SCRIPT_SUM_NAME = SCRIPT_NAME + ".sha256"
# The Windows Security helper. Split out of the installer because a downloaded
# script that reads the antivirus threat list and writes exclusions for itself
# is indistinguishable from malware doing the same - Defender classified the
# whole installer as Trojan:PowerShell/Killav.VDA!MTB and AMSI refused to run
# any of it. Published separately so an administrator fetches it deliberately.
DEFENDER_SCRIPT_NAME = "manage-windows-defender.ps1"
EXE_NAME = "cybersentineldlp_agent.exe"
SUM_NAME = EXE_NAME + ".sha256"
VER_NAME = EXE_NAME + ".version"

# Local artifact name -> path inside the repository, and the content type it must
# be served as. The script is text/plain deliberately: Invoke-RestMethod parses
# by content type, and anything JSON-ish or XML-ish comes back to `iex` as an
# object rather than the script text, which fails in a way that looks like the
# script itself is broken.
# Dependencies an endpoint may need but cannot fetch itself. These are served
# from this directory ONLY - never pulled from the repository, which has no
# business carrying a third-party installer, and never required. The image build
# stages them (from upstream's own release, checksum pinned), so every endpoint,
# including an air-gapped one, gets them from the manager it already talks to
# with nothing configured. An operator can drop in a different build to override.
#
# Without this the agent installer reached out to Chocolatey for Tesseract,
# which on Windows Server pulls .NET 4.8 first. Both downloads fail on a machine
# with no internet, and OCR - the thing that reads a photographed ID card - is
# silently lost on exactly the fleet most likely to be isolated.
_LOCAL_ONLY = {
    "tesseract-installer.exe": "application/octet-stream",
}

# The code-signing certificate's PUBLIC half, and its thumbprint.
#
# Published so an endpoint can trust this publisher and then verify the agent it
# downloads. Public-key material only: the private key never leaves CI, where it
# lives as a secret and is deleted from the runner after signing.
CERT_NAME  = "csdlp-signing.cer"
THUMB_NAME = "csdlp-signing.thumbprint"

_ARTIFACTS = {
    SCRIPT_NAME: (SCRIPT_NAME, "text/plain"),
    DEFENDER_SCRIPT_NAME: (DEFENDER_SCRIPT_NAME, "text/plain"),
    CERT_NAME:  (f"agents/endpoint/windows/{CERT_NAME}",  "application/x-x509-ca-cert"),
    THUMB_NAME: (f"agents/endpoint/windows/{THUMB_NAME}", "text/plain"),
    EXE_NAME: (f"agents/endpoint/windows/{EXE_NAME}", "application/octet-stream"),
    SUM_NAME: (f"agents/endpoint/windows/{SUM_NAME}", "text/plain"),
    VER_NAME: (f"agents/endpoint/windows/{VER_NAME}", "text/plain"),
}

_UPSTREAM_TIMEOUT = 60.0
_refresh_lock = asyncio.Lock()
_last_refresh: dict[str, float] = {}


def _repo() -> str:
    return os.getenv("AGENT_DIST_REPO", "effaaykhan/cybersentineldlp-prod").strip()


def _ref() -> str:
    return os.getenv("AGENT_DIST_REF", "main").strip() or "main"


def _token() -> str:
    """Read token for the private repo. Server-side only, never served out."""
    return (os.getenv("AGENT_DIST_TOKEN") or os.getenv("GITHUB_TOKEN") or "").strip()


def _refresh_seconds() -> int:
    """0 disables upstream refresh entirely — the drop directory becomes the
    only source, which is what an air-gapped or hand-staged site wants."""
    try:
        return int(os.getenv("AGENT_DIST_REFRESH_SECONDS", "300"))
    except ValueError:
        return 300


def _sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest().upper()


async def _fetch(client: httpx.AsyncClient, repo_path: str) -> Optional[bytes]:
    """One raw.githubusercontent.com GET. None on any failure — a refresh that
    cannot reach GitHub is not an error worth failing a download over, because
    the cached copy is still perfectly serviceable."""
    url = f"https://raw.githubusercontent.com/{_repo()}/{_ref()}/{repo_path}"
    headers = {"Accept": "application/vnd.github.raw"}
    token = _token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        resp = await client.get(url, headers=headers, follow_redirects=True)
    except Exception as exc:  # network, DNS, TLS — all equally "not now"
        logger.warning("agent_dist.fetch_failed", path=repo_path, error=str(exc))
        return None
    if resp.status_code != 200:
        # 404 here almost always means "private repo, no usable token" rather
        # than a missing file, so say so instead of echoing the bare status.
        logger.warning(
            "agent_dist.fetch_rejected",
            path=repo_path,
            status=resp.status_code,
            hint=(
                "repository is private and AGENT_DIST_TOKEN is unset or lacks read access"
                if resp.status_code == 404 and not token
                else None
            ),
        )
        return None
    return resp.content


def _write(name: str, data: bytes) -> None:
    """Atomic publish — a reader never sees a half-written artifact."""
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    tmp = DIST_DIR / (name + ".incoming")
    tmp.write_bytes(data)
    tmp.replace(DIST_DIR / name)


async def _refresh_script(client: httpx.AsyncClient) -> None:
    data = await _fetch(client, _ARTIFACTS[SCRIPT_NAME][0])
    if data:
        _write(SCRIPT_NAME, data)


async def _refresh_binary(client: httpx.AsyncClient) -> None:
    """Move exe + sha256 + version forward together, or not at all."""
    sum_raw = await _fetch(client, _ARTIFACTS[SUM_NAME][0])
    if not sum_raw:
        return
    try:
        expected = sum_raw.decode("utf-8", "replace").strip().split()[0].upper()
    except IndexError:
        logger.warning("agent_dist.empty_checksum")
        return

    exe_path = DIST_DIR / EXE_NAME
    if not (exe_path.is_file() and _sha256_file(exe_path) == expected):
        data = await _fetch(client, _ARTIFACTS[EXE_NAME][0])
        if not data:
            return
        actual = hashlib.sha256(data).hexdigest().upper()
        if actual != expected:
            # Publishing this pair would make every endpoint report a tampered
            # binary. Keeping the previous consistent set is the safe answer.
            logger.error(
                "agent_dist.checksum_mismatch", expected=expected, actual=actual
            )
            return
        _write(EXE_NAME, data)

    _write(SUM_NAME, sum_raw)
    ver = await _fetch(client, _ARTIFACTS[VER_NAME][0])
    if ver:
        _write(VER_NAME, ver)


async def _ensure_fresh(name: str) -> None:
    """Refresh from upstream at most once per TTL per artifact group."""
    ttl = _refresh_seconds()
    if ttl <= 0 or not _token():
        # No token means anonymous raw, which is exactly what stopped working.
        # Skip the call rather than spend a network round trip on a certain 404.
        return
    group = "script" if name == SCRIPT_NAME else "binary"
    if time.monotonic() - _last_refresh.get(group, 0.0) < ttl:
        return
    async with _refresh_lock:
        if time.monotonic() - _last_refresh.get(group, 0.0) < ttl:
            return
        # A refresh is an optimisation, never a precondition. If the directory is
        # read-only, the disk is full, or upstream is unreachable, the artifacts
        # already on disk are still exactly what an endpoint needs — so failing
        # the download because the update check failed would be the wrong trade.
        try:
            async with httpx.AsyncClient(timeout=_UPSTREAM_TIMEOUT) as client:
                if group == "script":
                    await _refresh_script(client)
                else:
                    await _refresh_binary(client)
        except Exception as exc:
            logger.warning("agent_dist.refresh_failed", group=group, error=str(exc))
        # Stamped even on failure, so a broken upstream is retried on the TTL
        # rather than on every single request.
        _last_refresh[group] = time.monotonic()


def _artifact_media_type(name: str) -> Optional[str]:
    if name in _ARTIFACTS:
        return _ARTIFACTS[name][1]
    return _LOCAL_ONLY.get(name)


def _dist_file(name: str) -> pathlib.Path:
    """Resolve inside the dist directory, refusing anything outside it."""
    candidate = (DIST_DIR / name).resolve()
    try:
        candidate.relative_to(DIST_DIR.resolve())
    except ValueError:
        # These routes are unauthenticated, so the traversal check earns its keep.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if not candidate.is_file():
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"'{name}' has not been published on this server. Either set "
            "AGENT_DIST_TOKEN so the manager can pull it from the private "
            f"repository, or copy the file into server/agent_dist/ by hand.",
        )
    return candidate


def _served_script(path: pathlib.Path, request: Request) -> str:
    """The script as the endpoint receives it: this server's address filled in.

    One function, because the download path and the checksum path MUST agree
    byte for byte. Computing the substitution in two places is how a checksum
    comes to describe a file nobody was sent.
    """
    base = str(request.url).split("?")[0].rsplit("/", 1)[0]
    if base.endswith(".sha256"):
        base = base.rsplit("/", 1)[0]
    return path.read_text(encoding="utf-8", errors="replace").replace(
        "@@CSDLP_SERVED_FROM@@", base)


@router.api_route("/info", methods=["GET", "HEAD"])
async def agent_dist_info():
    """What this server is currently publishing, and whether it can refresh.

    Exists so "the endpoint won't update" can be answered from the server in one
    request, instead of by reading an installer log on the endpoint.
    """
    await _ensure_fresh(EXE_NAME)
    out = {
        "published": {},
        "version": None,
        "sha256": None,
        "upstream_repo": _repo(),
        "upstream_ref": _ref(),
        # Never the token itself — only whether one is configured.
        "upstream_refresh": bool(_token()) and _refresh_seconds() > 0,
    }
    for name in list(_ARTIFACTS) + list(_LOCAL_ONLY):
        path = DIST_DIR / name
        out["published"][name] = path.stat().st_size if path.is_file() else None
    ver = DIST_DIR / VER_NAME
    if ver.is_file():
        out["version"] = ver.read_text(encoding="utf-8", errors="replace").strip()
    chk = DIST_DIR / SUM_NAME
    if chk.is_file():
        text = chk.read_text(encoding="utf-8", errors="replace").strip().split()
        out["sha256"] = text[0].upper() if text else None
    return out


@router.api_route("/{filename}", methods=["GET", "HEAD"])
async def download_artifact(filename: str, request: Request):
    """The installer script, the agent binary, and its two sidecars.

    HEAD is answered as well as GET so a reachability probe can ask "is the
    binary published here?" without pulling 4.5MB — without it such a probe gets
    405 and reports the artifact missing on a server publishing it correctly.
    """
    # The installer script's checksum, computed on demand.
    #
    # `irm <url> | iex` has no integrity check: whatever comes back is executed,
    # and a truncated response or a tampering proxy is indistinguishable from
    # the real script. The agent binary has been checksum-verified from the
    # start; the script that fetches it never was, which is the wrong way round.
    #
    # Handled HERE rather than on its own route. A separate "/{name}.sha256"
    # path looks tidier and is a trap: FastAPI matches routes in declaration
    # order, so it also captured cybersentineldlp_agent.exe.sha256 - a real
    # file with a real sidecar - and answered 404 for it. Every endpoint then
    # reported that the server was not publishing the agent at all.
    if filename == SCRIPT_SUM_NAME:
        await _ensure_fresh(SCRIPT_NAME)
        script_path = _dist_file(SCRIPT_NAME)
        if not script_path.is_file():
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
        # Hash what is actually SERVED, not what is on disk.
        #
        # The script now has this server's address substituted into it as it
        # goes out, so the bytes on disk are not the bytes the endpoint
        # receives. Hashing the file would publish a checksum that every
        # verification fails - which looks exactly like tampering and would send
        # an operator hunting for an attacker who is not there.
        body = _served_script(script_path, request)
        digest = hashlib.sha256(body.encode("utf-8")).hexdigest().upper()
        return PlainTextResponse(
            f"{digest}  {SCRIPT_NAME}\n",
            headers={"Cache-Control": "public, max-age=60"},
        )

    media_type = _artifact_media_type(filename)
    if media_type is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    # Tell the installer where it came from.
    #
    # `irm <url> | iex` hands the script its TEXT and not its URL, so a script
    # fetched from this server had no idea which server that was. It guessed
    # from the endpoint's own config, and on a device that had ever talked to a
    # different deployment that guess is stale - one fetched from
    # 192.168.2.204:55100 went looking at 192.168.1.204:55000 and reported that
    # "the DLP server is not publishing the agent binary" about a machine it had
    # never contacted.
    #
    # We know the answer: it is the address this request arrived on. Substituted
    # as the file is served, so it is right even on an endpoint whose stored
    # configuration points somewhere else entirely.
    if filename in (SCRIPT_NAME, DEFENDER_SCRIPT_NAME):
        await _ensure_fresh(filename)
        path = _dist_file(filename)
        if not path.is_file():
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
        return PlainTextResponse(_served_script(path, request),
                                 headers={"Cache-Control": "public, max-age=60"})
    # Local-only artifacts are never refreshed from upstream: they are staged by
    # an operator, and there is nothing in the repository to refresh them from.
    if filename in _ARTIFACTS:
        await _ensure_fresh(filename)
    path = _dist_file(filename)
    return FileResponse(
        path,
        media_type=media_type,
        filename=filename,
        # Deliberately short. An endpoint that just took an update must not be
        # handed the previous binary by an intermediate proxy for the next hour.
        headers={"Cache-Control": "public, max-age=60"},
    )
