#!/usr/bin/env bash
#
# policy-sync-cron.sh — scheduled entrypoint for the dev-server policy sync.
# Installed as an hourly root crontab. Logs to
# /var/log/cybersentineldlp-policy-sync.log.
#
# Exports the manager DB's policies to server/data/exported_policies.json and
# commits it. It PUSHES only when the sole unpushed commit is the policy sync —
# so it can never push a human's in-progress code commits from the background.
#
set -uo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
REPO="/home/soc/Data-Loss-Prevention"
cd "$REPO" || { echo "repo not found: $REPO"; exit 1; }

echo "===== policy-sync $(date -Is 2>/dev/null || date) ====="

# 1) Export + commit ONLY the policy file (no push here).
if ! scripts/sync-policies.sh --no-push; then
    echo "policy export/commit failed"
    exit 1
fi

# 2) Push ONLY if the single unpushed commit is the policy sync.
git fetch origin main --quiet 2>/dev/null || true
AHEAD="$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"
if [ "$AHEAD" = "0" ]; then
    echo "nothing to push."
elif [ "$AHEAD" = "1" ] && git log -1 --pretty=%s | grep -q "^chore(policies): sync"; then
    if git push origin main; then
        echo "pushed policy sync — CI will rebuild the manager image."
    else
        echo "push failed (will retry next run)."
    fi
else
    echo "SKIP push: ${AHEAD} unpushed commit(s) present (manual work pending) — retry next run."
fi

echo "===== done $(date -Is 2>/dev/null || date) ====="
