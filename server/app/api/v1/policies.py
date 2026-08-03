"""
DLP Policies API Endpoints
Create, update, and manage DLP policies
"""

from typing import List, Dict, Any, Literal, Optional
from datetime import datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import structlog

from app.core.security import get_current_user, require_role, require_permission
from app.core.database import get_db, get_mongodb
from app.core.cache import get_cache, CacheService
from app.core.domains import domain_for_policy_type
from app.services.domain_service import get_user_domains, user_can_access_domain
from app.services.policy_service import PolicyService


def _authz_policy_domain(current_user, policy) -> None:
    """403 if the policy is outside the caller's administrative domain(s).
    Super admin / analysts (unrestricted) always pass."""
    if not user_can_access_domain(current_user, getattr(policy, "domain", None)):
        raise HTTPException(
            status_code=403,
            detail="This policy is outside your administrative domain.",
        )
from app.services.audit_service import audit_log
from app.utils.policy_transformer import (
    transform_frontend_config_to_backend,
    normalize_monitoring_actions,
)
from app.models.user import User
from app.models.agent import Agent

logger = structlog.get_logger()
router = APIRouter()


async def invalidate_policy_bundle_cache() -> None:
    """
    Clear cached agent policy bundles so agents receive fresh versions
    after policy mutations (create/update/enable/disable/delete).
    """
    try:
        cache_service = CacheService(get_cache())
    except RuntimeError:
        # Cache not initialized; skip invalidation without failing request
        logger.debug("Cache not initialized; skipping policy bundle cache invalidation")
        return

    deleted = await cache_service.delete_prefix("agent-policy-bundle:")
    logger.info("Policy bundle cache invalidated", keys_deleted=deleted)


# ... (Existing Pydantic models: PolicyCondition, PolicyAction, Policy - Keep them as is)
class PolicyCondition(BaseModel):
    field: str
    operator: str
    value: Any

class PolicyAction(BaseModel):
    type: str
    parameters: Optional[Dict[str, Any]] = None

class Policy(BaseModel):
    id: Optional[str] = None
    name: str
    description: str
    enabled: bool = True
    priority: int = 100
    type: Optional[str] = None
    severity: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    conditions: Optional[List[PolicyCondition]] = []
    actions: Optional[List[PolicyAction]] = []
    compliance_tags: List[str] = []
    agent_id: Optional[str] = None  # Convenience single agent selector
    agent_ids: Optional[List[str]] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    created_by: Optional[str] = None


class PolicyUpsert(BaseModel):
    name: str
    description: str
    enabled: bool = True
    priority: int = 100
    type: Optional[str] = None
    severity: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    match: Literal["all", "any", "none"] = "all"
    conditions: Optional[List[PolicyCondition]] = []
    actions: Optional[List[PolicyAction]] = []
    compliance_tags: List[str] = []
    agent_id: Optional[str] = None
    agent_ids: Optional[List[str]] = None

    class Config:
        allow_population_by_field_name = True


class PolicyImportItem(BaseModel):
    """One policy inside an import document.

    Deliberately lenient about ``conditions``/``actions`` so the endpoint can
    swallow both shapes we produce:
      * the dashboard export / API shape — ``conditions`` is a list of
        ``{field, operator, value}`` and ``actions`` a list of
        ``{type, parameters}``;
      * the raw backend / seed-file shape — ``conditions`` is a
        ``{"match", "rules"}`` dict and ``actions`` an ``{action: params}`` dict.
    Both are normalised in ``_import_conditions_actions``.
    """
    name: str
    description: Optional[str] = ""
    enabled: bool = True
    priority: int = 100
    type: Optional[str] = None
    severity: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    match: Optional[str] = "all"
    conditions: Optional[Any] = None
    actions: Optional[Any] = None
    compliance_tags: Optional[List[str]] = []


class PolicyImportRequest(BaseModel):
    policies: List[PolicyImportItem]
    # What to do when a policy with the same name already exists.
    #   skip    – leave the existing one untouched (default, safest)
    #   rename  – import the incoming one under a unique "(imported)" name
    #   replace – overwrite the existing policy with the incoming definition
    on_conflict: Literal["skip", "rename", "replace"] = "skip"


def _import_conditions_actions(item: PolicyImportItem):
    """Rebuild the backend conditions/actions dicts from one imported policy,
    accepting both the dashboard export shape (lists) and the raw storage shape
    (dicts). Mirrors the create/update endpoints so an imported policy behaves
    exactly like a hand-created one."""
    # A typed policy carrying a real config is fully described by that config;
    # let the same transformer the create path uses rebuild its rules/actions.
    if item.config and item.type:
        conditions_dict, actions_dict = transform_frontend_config_to_backend(
            item.type, item.config
        )
    else:
        raw_conditions = item.conditions
        if isinstance(raw_conditions, dict):
            conditions_dict = {
                "match": raw_conditions.get("match", item.match or "all"),
                "rules": raw_conditions.get("rules", []) or [],
            }
        elif isinstance(raw_conditions, list):
            rules = [
                {"field": r.get("field"), "operator": r.get("operator"), "value": r.get("value")}
                for r in raw_conditions
                if isinstance(r, dict)
            ]
            conditions_dict = {"match": item.match or "all", "rules": rules}
        else:
            conditions_dict = {"match": item.match or "all", "rules": []}

        raw_actions = item.actions
        if isinstance(raw_actions, dict):
            actions_dict = raw_actions
        elif isinstance(raw_actions, list):
            actions_dict = {
                a["type"]: (a.get("parameters") or {})
                for a in raw_actions
                if isinstance(a, dict) and a.get("type")
            }
        else:
            actions_dict = {}

    actions_dict = normalize_monitoring_actions(item.type, item.config, actions_dict)
    return conditions_dict, actions_dict


async def _normalize_agent_scope(
    db: AsyncSession,
    agent_id: Optional[str],
    agent_ids: Optional[List[str]],
) -> List[str]:
    """
    Normalize single-agent scoping for policies.

    Behaviour:
    - Prefer explicit ``agent_id``; otherwise use ``agent_ids``.
    - Reject more than one explicit agent (UI only supports single-agent scope).
    - If no agent is supplied, return an empty list → policy applies to all agents.
    - When an agent id is supplied, validate that it exists in the MongoDB
      ``agents`` collection (the source of truth for agents).

    Prior to this change, this function queried the SQLAlchemy ``Agent`` model,
    which expects a relational ``agents`` table. In this deployment that table
    does not exist, so any scoped policy creation triggered:

        sqlalchemy.exc.ProgrammingError: relation \"agents\" does not exist

    which surfaced as a 500 from ``POST /api/v1/policies`` and caused the UI
    to report \"failed to create policy\" whenever a Target Agent was selected.
    """
    # Normalise input into a single agent id (or none)
    if agent_id:
        normalized = [agent_id]
    else:
        normalized = [a for a in (agent_ids or []) if a]

    if len(normalized) > 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only one agent_id is allowed per policy",
        )

    # No scoping → apply to all agents
    if not normalized:
        return []

    target_id = str(normalized[0])

    # Validate existence against MongoDB agents collection (authoritative store)
    mongo = get_mongodb()
    agents_collection = mongo["agents"]
    agent_doc = await agents_collection.find_one({"agent_id": target_id})
    if not agent_doc:
        raise HTTPException(
            status_code=400,
            detail=f"agent_id '{target_id}' not found",
        )

    return [target_id]


@router.get("/")
async def get_policies(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    enabled_only: bool = False,
    current_user: User = Depends(require_role("analyst")),
    db: AsyncSession = Depends(get_db),
):
    """
    SECURITY: requires analyst role. Policy bundles include conditions,
    actions, agent_ids, and compliance tags — the full DLP enforcement
    playbook. Must not be readable by VIEWERs.
    """
    policy_service = PolicyService(db)
    policies = await policy_service.get_all_policies(
        skip=skip,
        limit=limit,
        enabled_only=enabled_only,
    )

    # Domain-scoped RBAC: a domain admin only sees their domain's policies.
    _allowed = get_user_domains(current_user)
    if _allowed is not None:
        policies = [
            p for p in policies if (getattr(p, "domain", None) or "general") in _allowed
        ]

    return [
        {
            "id": str(policy.id),
            "name": policy.name,
            "description": policy.description,
            "enabled": policy.enabled,
            "priority": policy.priority,
            "type": policy.type,
            "domain": getattr(policy, "domain", "general"),
            "severity": policy.severity,
            "config": policy.config,
            "match": policy.conditions.get("match", "all")
            if isinstance(policy.conditions, dict)
            else "all",
            "conditions": policy.conditions.get("rules", [])
            if isinstance(policy.conditions, dict)
            else [],
            "actions": [
                {"type": k, "parameters": v} for k, v in policy.actions.items()
            ]
            if isinstance(policy.actions, dict)
            else [],
            "compliance_tags": policy.compliance_tags or [],
            "agent_ids": policy.agent_ids or [],
            "created_at": policy.created_at,
            "updated_at": policy.updated_at,
            "created_by": str(policy.created_by) if policy.created_by else None,
        }
        for policy in policies
    ]


@router.get("/{policy_id}")
async def get_policy(
    policy_id: str,
    current_user: User = Depends(require_role("analyst")),
    db: AsyncSession = Depends(get_db),
):
    # ... (Implementation same as read_file)
    policy_service = PolicyService(db)
    policy = await policy_service.get_policy_by_id(policy_id)

    if not policy:
        raise HTTPException(status_code=404, detail="Policy not found")

    _authz_policy_domain(current_user, policy)

    return {
        "id": str(policy.id),
        "name": policy.name,
        "description": policy.description,
        "enabled": policy.enabled,
        "priority": policy.priority,
        "type": policy.type,
        "domain": getattr(policy, "domain", "general"),
        "severity": policy.severity,
        "config": policy.config,
        "match": policy.conditions.get("match", "all")
        if isinstance(policy.conditions, dict)
        else "all",
        "conditions": policy.conditions.get("rules", [])
        if isinstance(policy.conditions, dict)
        else [],
        "actions": [
            {"type": k, "parameters": v} for k, v in policy.actions.items()
        ]
        if isinstance(policy.actions, dict)
        else [],
        "compliance_tags": policy.compliance_tags or [],
        "agent_ids": policy.agent_ids or [],
        "created_at": policy.created_at,
        "updated_at": policy.updated_at,
        "created_by": str(policy.created_by) if policy.created_by else None,
    }


@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_policy(
    policy: PolicyUpsert,
    current_user: User = Depends(require_permission("create_policy")),
    db: AsyncSession = Depends(get_db),
):
    """
    Create a new DLP policy
    """
    print(f"DEBUG: create_policy called with type={policy.type}")
    print(f"DEBUG: config={policy.config}")
    print(f"DEBUG: conditions={policy.conditions}")
    print(f"DEBUG: actions={policy.actions}")

    # Domain-scoped RBAC: a domain admin may only create policies in their
    # own domain. The domain is derived from the policy type.
    _new_domain = domain_for_policy_type(policy.type)
    if not user_can_access_domain(current_user, _new_domain):
        raise HTTPException(
            status_code=403,
            detail=(
                f"You can only create policies in your domain. "
                f"'{policy.type}' belongs to the '{_new_domain}' domain."
            ),
        )

    policy_service = PolicyService(db)

    # Transform frontend config to backend conditions/actions if config is provided
    if policy.config and policy.type:
        conditions_dict, actions_dict = transform_frontend_config_to_backend(
            policy.type, policy.config
        )
    else:
        conditions_dict = {
            "match": policy.match,
            "rules": [cond.dict() for cond in (policy.conditions or [])]
        }
        actions_dict = {action.type: action.parameters for action in (policy.actions or [])}
        print(f"DEBUG: Converted actions_dict={actions_dict}")

    # Keep config.action and actions in sync for monitoring policies so
    # the dashboard listing and the agent's parser can never disagree
    # about what the policy actually does.
    actions_dict = normalize_monitoring_actions(policy.type, policy.config, actions_dict)

    try:
        agent_ids = await _normalize_agent_scope(db, policy.agent_id, policy.agent_ids)

        created_policy = await policy_service.create_policy(
            name=policy.name,
            description=policy.description,
            conditions=conditions_dict,
            actions=actions_dict,
            created_by=str(current_user.id),
            enabled=policy.enabled,
            priority=policy.priority,
            compliance_tags=policy.compliance_tags,
            type=policy.type,
            severity=policy.severity,
            config=policy.config,
            agent_ids=agent_ids,
        )

        logger.info(
            "Policy created",
            policy_name=policy.name,
            policy_id=str(created_policy.id),
            user=current_user.email,
        )
        await invalidate_policy_bundle_cache()
        await audit_log(current_user.id, "policy.create", {"policy_name": policy.name})

        return {
            "id": str(created_policy.id),
            "name": created_policy.name,
            "description": created_policy.description,
            "enabled": created_policy.enabled,
            "priority": created_policy.priority,
            "type": created_policy.type,
            "severity": created_policy.severity,
            "config": created_policy.config,
            "conditions": created_policy.conditions or {},
            "actions": created_policy.actions or {},
            "compliance_tags": created_policy.compliance_tags or [],
            "agent_ids": created_policy.agent_ids or [],
            "created_at": created_policy.created_at,
            "updated_at": created_policy.updated_at,
            "created_by": str(created_policy.created_by) if created_policy.created_by else None,
        }

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/{policy_id}")
async def update_policy(
    policy_id: str,
    policy: PolicyUpsert,
    current_user: User = Depends(require_permission("update_policy")),
    db: AsyncSession = Depends(get_db),
):
    """
    Update existing DLP policy
    """
    policy_service = PolicyService(db)

    # Domain-scoped RBAC: must own the existing policy, and (if the type
    # changes) may not move it into a domain you don't own.
    _existing = await policy_service.get_policy_by_id(policy_id)
    if not _existing:
        raise HTTPException(status_code=404, detail="Policy not found")
    _authz_policy_domain(current_user, _existing)
    if policy.type is not None and not user_can_access_domain(
        current_user, domain_for_policy_type(policy.type)
    ):
        raise HTTPException(
            status_code=403,
            detail="You cannot move this policy into another domain.",
        )

    # Transform frontend config to backend conditions/actions if config is provided
    if policy.config and policy.type:
        conditions_dict, actions_dict = transform_frontend_config_to_backend(
            policy.type, policy.config
        )
    else:
        conditions_dict = {
            "match": policy.match,
            "rules": [cond.dict() for cond in (policy.conditions or [])]
        }
        actions_dict = {action.type: action.parameters for action in (policy.actions or [])}

    # Collapse stale multi-action shapes (e.g. {block, alert} left over
    # from the legacy modal) down to the single canonical action.
    actions_dict = normalize_monitoring_actions(policy.type, policy.config, actions_dict)

    try:
        agent_ids = await _normalize_agent_scope(db, policy.agent_id, policy.agent_ids)

        updated_policy = await policy_service.update_policy(
            policy_id=policy_id,
            name=policy.name,
            description=policy.description,
            conditions=conditions_dict,
            actions=actions_dict,
            enabled=policy.enabled,
            priority=policy.priority,
            compliance_tags=policy.compliance_tags,
            type=policy.type,
            severity=policy.severity,
            config=policy.config,
            agent_ids=agent_ids,
        )

        if not updated_policy:
            raise HTTPException(status_code=404, detail="Policy not found")

        logger.info(
            "Policy updated",
            policy_id=policy_id,
            user=current_user.email,
        )
        await invalidate_policy_bundle_cache()
        await audit_log(current_user.id, "policy.update", {"policy_id": str(policy_id)})

        return {
            "id": str(updated_policy.id),
            "name": updated_policy.name,
            "description": updated_policy.description,
            "enabled": updated_policy.enabled,
            "priority": updated_policy.priority,
            "type": updated_policy.type,
            "severity": updated_policy.severity,
            "config": updated_policy.config,
            "conditions": updated_policy.conditions or {},
            "actions": updated_policy.actions or {},
            "compliance_tags": updated_policy.compliance_tags or [],
            "agent_ids": updated_policy.agent_ids or [],
            "created_at": updated_policy.created_at,
            "updated_at": updated_policy.updated_at,
            "created_by": str(updated_policy.created_by) if updated_policy.created_by else None,
        }

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{policy_id}")
async def delete_policy(
    policy_id: str,
    current_user: User = Depends(require_permission("delete_policy")),
    db: AsyncSession = Depends(get_db),
):
    policy_service = PolicyService(db)

    # Domain-scoped RBAC: only delete policies within your domain.
    _existing = await policy_service.get_policy_by_id(policy_id)
    if not _existing:
        raise HTTPException(status_code=404, detail="Policy not found")
    _authz_policy_domain(current_user, _existing)

    success = await policy_service.delete_policy(policy_id)

    if not success:
        raise HTTPException(status_code=404, detail="Policy not found")

    logger.info(
        "Policy deleted",
        policy_id=policy_id,
        user=current_user.email,
    )
    await invalidate_policy_bundle_cache()
    await audit_log(current_user.id, "policy.delete", {"policy_id": str(policy_id)})

    return {"message": "Policy deleted successfully"}


@router.post("/{policy_id}/enable")
async def enable_policy(
    policy_id: str,
    current_user: User = Depends(require_permission("update_policy")),
    db: AsyncSession = Depends(get_db),
):
    policy_service = PolicyService(db)
    _existing = await policy_service.get_policy_by_id(policy_id)
    if not _existing:
        raise HTTPException(status_code=404, detail="Policy not found")
    _authz_policy_domain(current_user, _existing)
    policy = await policy_service.enable_policy(policy_id)

    if not policy:
        raise HTTPException(status_code=404, detail="Policy not found")

    logger.info(
        "Policy enabled",
        policy_id=policy_id,
        user=current_user.email,
    )
    await invalidate_policy_bundle_cache()

    return {"message": "Policy enabled successfully", "policy_id": str(policy.id)}


@router.post("/{policy_id}/disable")
async def disable_policy(
    policy_id: str,
    current_user: User = Depends(require_permission("update_policy")),
    db: AsyncSession = Depends(get_db),
):
    policy_service = PolicyService(db)
    _existing = await policy_service.get_policy_by_id(policy_id)
    if not _existing:
        raise HTTPException(status_code=404, detail="Policy not found")
    _authz_policy_domain(current_user, _existing)
    policy = await policy_service.disable_policy(policy_id)

    if not policy:
        raise HTTPException(status_code=404, detail="Policy not found")

    logger.info(
        "Policy disabled",
        policy_id=policy_id,
        user=current_user.email,
    )
    await invalidate_policy_bundle_cache()

    return {"message": "Policy disabled successfully", "policy_id": str(policy.id)}


@router.post("/cache/refresh")
async def refresh_policy_bundles(
    current_user: User = Depends(require_role("analyst")),
):
    """
    Manually invalidate cached agent policy bundles.
    Agents will pull a fresh bundle on their next sync.
    """
    await invalidate_policy_bundle_cache()
    return {"message": "Policy bundle cache cleared", "status": "ok"}


@router.post("/import")
async def import_policies(
    payload: PolicyImportRequest,
    current_user: User = Depends(require_permission("create_policy")),
    db: AsyncSession = Depends(get_db),
):
    """
    Bulk-import policies from a previously exported document.

    Each policy is validated and created independently, so one malformed entry
    never aborts the whole import — the response reports the per-policy outcome
    (created / replaced / skipped / failed) instead of a single 4xx.

    Agent scoping is intentionally dropped on import: ``agent_ids`` reference
    agents in *this* deployment's MongoDB, so a policy exported from another box
    would 400 or silently mis-scope. Imported policies therefore apply to all
    agents until you re-scope them.
    """
    if not payload.policies:
        raise HTTPException(status_code=400, detail="No policies to import.")

    policy_service = PolicyService(db)

    # Snapshot existing names → policy for conflict handling (limit high enough
    # to cover any realistic policy count).
    existing = await policy_service.get_all_policies(skip=0, limit=1000)
    by_name: Dict[str, Any] = {p.name: p for p in existing}
    taken_names = set(by_name.keys())

    def _unique_name(base: str) -> str:
        candidate = f"{base} (imported)"
        n = 2
        while candidate in taken_names:
            candidate = f"{base} (imported {n})"
            n += 1
        return candidate

    results: List[Dict[str, Any]] = []
    imported = replaced = skipped = failed = 0
    changed = False

    for item in payload.policies:
        name = (item.name or "").strip()
        if not name:
            failed += 1
            results.append({"name": item.name or "(unnamed)", "status": "failed",
                            "detail": "Policy has no name."})
            continue

        # Domain-scoped RBAC: may this admin create in the target domain?
        target_domain = domain_for_policy_type(item.type)
        if not user_can_access_domain(current_user, target_domain):
            failed += 1
            results.append({"name": name, "status": "failed",
                            "detail": f"'{item.type}' is in the '{target_domain}' "
                                      f"domain, which is outside your access."})
            continue

        conflict = name in taken_names

        if conflict and payload.on_conflict == "skip":
            skipped += 1
            results.append({"name": name, "status": "skipped",
                            "detail": "A policy with this name already exists."})
            continue

        try:
            conditions_dict, actions_dict = _import_conditions_actions(item)

            if conflict and payload.on_conflict == "replace":
                existing_policy = by_name.get(name)
                # Only overwrite a policy we're actually allowed to touch.
                if existing_policy is not None and not user_can_access_domain(
                    current_user, getattr(existing_policy, "domain", None)
                ):
                    failed += 1
                    results.append({"name": name, "status": "failed",
                                    "detail": "Existing policy is outside your domain."})
                    continue
                await policy_service.update_policy(
                    policy_id=str(existing_policy.id),
                    name=name,
                    description=item.description or name,
                    conditions=conditions_dict,
                    actions=actions_dict,
                    enabled=item.enabled,
                    priority=item.priority,
                    compliance_tags=item.compliance_tags or [],
                    type=item.type,
                    severity=item.severity,
                    config=item.config,
                    agent_ids=[],
                )
                replaced += 1
                changed = True
                results.append({"name": name, "status": "replaced",
                                "detail": "Existing policy overwritten."})
                continue

            # Fresh create, or rename-on-conflict.
            create_name = _unique_name(name) if conflict else name
            created = await policy_service.create_policy(
                name=create_name,
                description=item.description or create_name,
                conditions=conditions_dict,
                actions=actions_dict,
                created_by=str(current_user.id),
                enabled=item.enabled,
                priority=item.priority,
                compliance_tags=item.compliance_tags or [],
                type=item.type,
                severity=item.severity,
                config=item.config,
                agent_ids=[],
            )
            taken_names.add(create_name)
            by_name[create_name] = created
            imported += 1
            changed = True
            results.append({"name": create_name, "status": "created",
                            "detail": f"Imported as '{create_name}'."
                            if create_name != name else "Imported."})

        except ValueError as e:
            failed += 1
            results.append({"name": name, "status": "failed", "detail": str(e)})
        except Exception as e:  # defensive: never let one entry 500 the batch
            logger.warning("Policy import entry failed", policy_name=name, error=str(e))
            failed += 1
            results.append({"name": name, "status": "failed", "detail": str(e)})

    if changed:
        await invalidate_policy_bundle_cache()
        await audit_log(
            current_user.id,
            "policy.import",
            {"imported": imported, "replaced": replaced,
             "skipped": skipped, "failed": failed},
        )

    logger.info(
        "Policies imported",
        user=current_user.email,
        imported=imported, replaced=replaced, skipped=skipped, failed=failed,
    )

    return {
        "total": len(payload.policies),
        "imported": imported,
        "replaced": replaced,
        "skipped": skipped,
        "failed": failed,
        "results": results,
    }


@router.get("/stats/summary")
async def get_policy_stats(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # ... (Implementation same as read_file)
    policy_service = PolicyService(db)
    stats = await policy_service.get_policy_stats()

    # Augment violations count using MongoDB events (last 24 hours)
    mongo = get_mongodb()
    lookback = datetime.utcnow() - timedelta(hours=24)
    violations = await mongo.dlp_events.count_documents(
        {
            "blocked": True,
            "timestamp": {"$gte": lookback},
        }
    )
    stats["violations"] = violations

    return stats
