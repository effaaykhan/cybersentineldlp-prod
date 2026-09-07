# `server/agent_dist` — what endpoints download

Serves `GET /api/v1/agent-dist/<file>` for four artifacts:

| file | what it is |
|---|---|
| `manage-windows-agent.ps1` | the installer/updater console the operator runs |
| `cybersentineldlp_agent.exe` | the agent binary |
| `cybersentineldlp_agent.exe.sha256` | its checksum, which the installer enforces |
| `cybersentineldlp_agent.exe.version` | the version that binary is |

Endpoints used to fetch these from `raw.githubusercontent.com`. That stopped
working the day the repository went private — GitHub answers **404**, not 403,
to an anonymous caller, so a private repo is indistinguishable from a deleted
file, and Install, Update *and* the update check all failed at once.

## Populating it

Any one of these is sufficient:

1. **Refresh from the private repo (recommended).** Set `AGENT_DIST_TOKEN` in the
   server's `.env` to a token with read access, and the manager keeps this
   directory current on its own (`AGENT_DIST_REFRESH_SECONDS`, default 300).
   The token never leaves the server.
2. **Baked at image build.** `.github/workflows/build-images.yml` copies the
   artifacts in before building the manager image, so a fresh deployment works
   before anyone configures anything.
3. **By hand.** Copy the four files in. This is the air-gapped path, and it is
   why the directory is read from disk rather than proxied live.

Check what is published with `GET /api/v1/agent-dist/info` — it reports the
version, the checksum and whether upstream refresh is configured. It never
reports the token.
