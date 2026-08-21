"""
Web-activity policy matching — and the record of WHICH policy decided.

Split out of ``api/v1/agents.py`` so the ingest path can attribute an event to
its governing policy without importing the whole agents router, and so the pure
decision logic can be exercised directly against the browser extension's
JavaScript mirror of it (``src/policy.js``).

WHY A POLICY THAT ALLOWED STILL GETS RECORDED
---------------------------------------------
A ``web_activity_control`` policy is a category x activity matrix with a
sensitivity threshold. "GenAI / Post is set to block for Confidential content"
means the policy inspects EVERY GenAI post and lets the ones below the
threshold through. Those allowed posts are still that policy's doing — it is
the reason they were looked at, the reason they were let go, and the thing an
operator would change to make them stop.

Returning ``("allow", "")`` for them, as this logic used to, produced events
with ``policy_id: null`` and no explanation: the log said a prompt went to
ChatGPT and was "Logged", while an operator looking at the Policies page could
see a rule that plainly says GenAI is blocked. Nothing in the event connected
the two, so the only way to answer "why was this allowed?" was to open the
policy and re-run the threshold arithmetic by hand.

So ``decide`` now returns a third value: the record of this policy's
involvement, populated whenever the policy defines a cell for the activity —
enforcing or not. ``enforced`` distinguishes "this policy stopped/flagged the
activity" from "this policy considered it and permitted it", so attribution
never gets mistaken for enforcement downstream.
"""

from typing import Any, Dict, List, Optional, Tuple

import structlog

from app.core import web_activity as _WA

logger = structlog.get_logger()

# Policy type carrying the category x activity matrix. See
# app/core/web_activity.py for the vocabulary and the dashboard's
# WebActivityMatrix editor for the shape of ``config``.
WEB_ACTIVITY_TYPE = "web_activity_control"

_LEVEL_RANK = {"public": 0, "internal": 1, "confidential": 2, "restricted": 3}


def level_rank(level: Optional[str]) -> int:
    return _LEVEL_RANK.get(str(level or "").strip().lower(), 0)


def matrix_cell(config: Dict[str, Any], category: str, activity: str):
    """The (action, min_level) a policy defines for one category/activity cell.

    A cell may be written as a bare action string ("block") or as an object
    ({"action": "block", "minLevel": "Restricted"}) when one activity needs a
    different threshold from the rest of the policy. Returns (None, None) when
    the policy says nothing about this cell — which is NOT the same as "allow":
    a policy that doesn't mention GenAI must leave other policies free to.
    """
    matrix = config.get("matrix") or {}
    row = matrix.get(category)
    if not isinstance(row, dict):
        return (None, None)
    cell = row.get(activity)
    if cell is None:
        return (None, None)
    if isinstance(cell, dict):
        action = _WA.normalize_action(cell.get("action"), default=_WA.ACTION_LOG)
        return (action, cell.get("minLevel") or config.get("minLevel"))
    return (_WA.normalize_action(cell, default=_WA.ACTION_LOG), config.get("minLevel"))


def app_override(config: Dict[str, Any], category: str, activity: str, app_id: Optional[str]):
    """Per-app exception, which beats the category row.

    This is what makes "GenAI is blocked, except the Copilot we pay for"
    expressible without splitting the estate across two policies. An entry may
    scope itself by app_id, by category, by activity, or any combination; the
    most specific match wins, so a broad rule can be carved out by a narrow one
    regardless of the order they sit in the list.

    SPECIFICITY IS WEIGHTED, not a count of populated fields. Naming an app
    narrows the rule to ONE destination out of the whole catalog; naming a
    category and an activity still covers dozens of apps. Counting fields made
    "GenAI downloads are alerted" (two fields) beat "Copilot is allowed" (one
    field) — so an operator who had explicitly exempted the AI vendor they pay
    for still got alerts from it, which reads as the product ignoring them.
    Weights: app 4, activity 2, category 1.
    """
    best = None
    best_specificity = -1
    for entry in (config.get("appOverrides") or []):
        if not isinstance(entry, dict):
            continue
        e_app = (entry.get("app_id") or entry.get("appId") or "").strip().lower()
        e_cat = _WA.normalize_category(entry.get("category"))
        e_act = _WA.normalize_activity(entry.get("activity"))

        app_pinned = bool(e_app) and e_app not in ("*", "any")
        if app_pinned and e_app != (app_id or "").lower():
            continue
        if e_cat and e_cat != category:
            continue
        if e_act and e_act != activity:
            continue

        specificity = (4 if app_pinned else 0) + (2 if e_act else 0) + (1 if e_cat else 0)
        if specificity > best_specificity:
            best_specificity = specificity
            best = entry
    if not best:
        return (None, None)
    return (
        _WA.normalize_action(best.get("action"), default=_WA.ACTION_LOG),
        best.get("minLevel") or config.get("minLevel"),
    )


def decide(
    cfg: Dict[str, Any],
    category: str,
    activity: str,
    app_id: Optional[str],
    app_name: Optional[str],
    classification_level: Optional[str],
    extraction_status: str,
    policy_name: str = "web activity control",
) -> Tuple[str, str, Optional[Dict[str, Any]]]:
    """One policy's verdict for one activity: (action, reason, record).

    ``action``/``reason`` are the enforcement decision, unchanged: ``reason`` is
    non-empty only when the policy actually acts, because it is what the end
    user reads on the block banner and "allowed" needs no banner.

    ``record`` is the attribution — non-None whenever this policy defines a cell
    covering the activity, INCLUDING when the outcome was allow. It always
    carries a full sentence, so an allowed event can still say why.

    Pure — no database, no request. The decision has to be testable directly
    against the browser extension's JavaScript mirror of it (src/policy.js);
    those two implementations decide the same question on opposite sides of the
    wire, and the only way to know they agree is to run both over the same
    table, which is impossible while the logic is welded to a DB query.
    """
    action, min_level = app_override(cfg, category, activity, app_id)
    source = "app rule"
    if action is None:
        action, min_level = matrix_cell(cfg, category, activity)
        source = "matrix"

    where = app_name or app_id or category
    act_label = _WA.ACTIVITY_LABELS.get(activity, activity)
    cat_label = _WA.CATEGORY_LABELS.get(category, category)

    def _record(configured: str, effective: str, threshold: Optional[str], note: str) -> Dict[str, Any]:
        sentence = (
            f"{act_label} to {where} ({cat_label}) is set to {configured} "
            f"by {source} in policy '{policy_name}'"
        )
        if threshold:
            sentence += f" for {threshold} content"
        if note:
            sentence += f" — {note}"
        return {
            "configured_action": configured,
            "action": effective,
            "enforced": effective != _WA.ACTION_ALLOW,
            "source": source,
            "min_level": threshold or None,
            "reason": sentence,
        }

    # The policy says nothing about this cell. Silence is not a decision, and
    # attributing an event to a policy that never mentioned it would be a lie.
    if action is None:
        return (_WA.ACTION_ALLOW, "", None)

    # An explicit "allow" cell IS a decision — someone wrote it — so it is
    # attributed even though it enforces nothing.
    if action == _WA.ACTION_ALLOW:
        return (_WA.ACTION_ALLOW, "", _record(_WA.ACTION_ALLOW, _WA.ACTION_ALLOW, None, ""))

    # A stored policy can still carry an action this activity cannot perform —
    # written before the capability table existed, or imported from another
    # deployment. Resolve it to the nearest action that CAN be performed, never
    # to a weaker one: whoever asked for redaction wanted the data not to leave
    # un-redacted, so blocking honours that where logging would not.
    clamped = _WA.clamp_action(activity, action)
    if clamped != action:
        logger.info(
            "Web-activity action clamped to what the endpoint can do",
            activity=activity, asked=action, using=clamped,
        )
        action = clamped

    # Threshold. An action fires only once the content is at least this
    # sensitive; below it the activity is ordinary work. Absent threshold means
    # "any content", which is how a blanket "no GenAI at all" rule is written.
    threshold = str(min_level or "").strip()
    if threshold and activity in _WA.ACTIVITIES_WITHOUT_CONTENT:
        # The browser hands a download straight to disk; the extension never
        # sees the bytes, so there is nothing to classify and no threshold to
        # meet. Applying one silently would mean a cell reading "block
        # Confidential and above" blocked everything instead — which is what it
        # used to do.
        threshold = ""
    if threshold:
        meets = level_rank(classification_level) >= level_rank(threshold)
        # Uninspectable content is NOT clean. A password-protected archive or an
        # OCR-proof scan classifies as Public, so without this the documented way
        # to bypass a threshold rule is to zip the file with a password.
        if not meets and cfg.get("blockUninspectable", True) and extraction_status in (
            "unreadable", "too_large"
        ):
            meets = True
            threshold = f"{threshold} (content could not be inspected)"
        if not meets:
            # Allowed BY this policy, not in spite of it. This is the case that
            # used to vanish: the event knew nothing about the rule that had
            # just examined it and let it pass.
            return (
                _WA.ACTION_ALLOW,
                "",
                _record(
                    action, _WA.ACTION_ALLOW, threshold,
                    f"allowed because this content classified as "
                    f"{classification_level or 'Public'}, below the threshold",
                ),
            )

    # Audit mode never blocks — it reports what enforcement WOULD have done, so a
    # matrix can be rolled out and observed before it starts stopping work.
    mode = str(cfg.get("mode") or "enforce").strip().lower()
    audited = False
    if mode == "audit" and action == _WA.ACTION_BLOCK:
        action = _WA.ACTION_ALERT
        audited = True

    record = _record(
        action, action, threshold or None,
        "audit mode: reported, not enforced" if audited else "",
    )
    # The enforcement sentence the end user sees stays exactly as it was — the
    # attribution note is for the event log, not for a block banner.
    reason = (
        f"{act_label} to {where} ({cat_label}) is set to {action} "
        f"by {source} in policy '{policy_name}'"
    )
    if threshold:
        reason += f" for {threshold} content"
    return (action, reason, record)


def _rank(action: Optional[str]) -> int:
    return _WA.ACTION_RANK.get(action or _WA.ACTION_ALLOW, 0)


async def match(
    db,
    agent_id: str,
    category: Optional[str],
    activity: Optional[str],
    app_id: Optional[str],
    app_name: Optional[str],
    classification_level: Optional[str],
    extraction_status: str,
) -> Tuple[str, str, List[Dict[str, Any]]]:
    """Apply every active ``web_activity_control`` policy to one web activity.

    Evaluated here rather than through DatabasePolicyEvaluator for the same
    reason the USB/print denylists are: the generic policy shape carries ONE
    actions dict per policy, and a category x activity matrix needs a different
    action per cell. Expressing this as conditions would take 24 separate
    policies to say what one matrix row says.

    Returns ``(action, reason, governing)``:

      * ``action`` — strongest of allow/log/alert/mask/block across all policies
      * ``reason`` — the winning policy's enforcement sentence, "" when allowed
      * ``governing`` — every policy that addressed this activity, in the
        canonical ``matched_policies`` shape, strongest first. Non-empty even
        when the verdict is allow, which is what lets the event name the rule
        that permitted it.

    Says nothing — ("allow", "", []) — when no policy addresses this cell, which
    is the deliberate default: an activity nobody wrote a rule for is allowed,
    so deploying the extension does not silently start blocking work.
    """
    try:
        from app.services.policy_service import PolicyService

        cat = _WA.normalize_category(category)
        act = _WA.normalize_activity(activity)
        if not cat or not act:
            return (_WA.ACTION_ALLOW, "", [])
        if not _WA.is_valid_pair(cat, act):
            # e.g. "ai_response on webmail" — a caller confusion, not a policy
            # decision. Matching it would let a nonsense pair inherit whatever
            # the operator set for a real one.
            return (_WA.ACTION_ALLOW, "", [])

        policies = await PolicyService(db).get_all_policies(skip=0, limit=1000, enabled_only=True)

        strongest = _WA.ACTION_ALLOW
        reason = ""
        governing: List[Dict[str, Any]] = []
        for p in policies:
            if getattr(p, "type", None) != WEB_ACTIVITY_TYPE:
                continue
            scope = getattr(p, "agent_ids", None) or []
            if scope and agent_id not in scope:
                continue
            cfg = getattr(p, "config", None) or {}

            action, why, record = decide(
                cfg, cat, act, app_id, app_name,
                classification_level, extraction_status,
                getattr(p, "name", "web activity control"),
            )
            if record:
                governing.append({
                    "policy_id": str(getattr(p, "id", "")) or None,
                    "policy_name": getattr(p, "name", None),
                    "severity": getattr(p, "severity", None),
                    "priority": getattr(p, "priority", 0) or 0,
                    "policy_type": WEB_ACTIVITY_TYPE,
                    **record,
                })
            if _rank(action) > _rank(strongest):
                strongest = action
                reason = why

        # Strongest first, so the event's single ``policy_id`` points at the
        # policy that actually decided rather than whichever came back first.
        governing.sort(key=lambda g: (_rank(g.get("action")), g.get("priority", 0)), reverse=True)
        return (strongest, reason, governing)
    except Exception as e:  # never let matching break evaluation
        logger.warning("Web-activity match failed (non-fatal)", error=str(e))
        return (_WA.ACTION_ALLOW, "", [])


async def attribute(
    agent_id: str,
    category: Optional[str],
    activity: Optional[str],
    app_id: Optional[str],
    app_name: Optional[str],
    classification_level: Optional[str],
    extraction_status: str = "readable",
) -> List[Dict[str, Any]]:
    """The governing policies for a web activity, opening its own session.

    For the event-ingest path, which has no request-scoped DB session and only
    needs the attribution — not the verdict, which the endpoint that intercepted
    the activity already made and enforced.
    """
    try:
        from app.core.database import get_postgres_session

        async with get_postgres_session() as session:
            _action, _reason, governing = await match(
                session, agent_id, category, activity, app_id, app_name,
                classification_level, extraction_status,
            )
            return governing
    except Exception as e:  # attribution must never fail an ingest
        logger.warning("Web-activity attribution failed (non-fatal)", error=str(e))
        return []
