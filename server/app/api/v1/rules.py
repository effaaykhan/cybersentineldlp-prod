"""
Rule Management API Endpoints
CRUD operations and testing for classification rules
"""

from typing import List, Optional, Dict, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status, Query, Body
from pydantic import BaseModel, Field, ConfigDict, field_validator
import structlog

from app.core.security import get_current_user, require_role
from app.core.database import get_db
from app.services.rule_service import RuleService
from app.services.classification_engine import ClassificationEngine
from sqlalchemy.ext.asyncio import AsyncSession

logger = structlog.get_logger()
router = APIRouter()


# Pydantic Models

class RuleCreate(BaseModel):
    """Rule creation request"""
    name: str = Field(..., min_length=3, max_length=255, description="Unique rule name")
    description: Optional[str] = Field(None, max_length=1000)
    type: str = Field(..., description="Rule type: regex, keyword, or dictionary")
    pattern: Optional[str] = Field(None, description="Regex pattern (for regex type)")
    regex_flags: Optional[List[str]] = Field(None, description="Regex flags like IGNORECASE, MULTILINE")
    keywords: Optional[List[str]] = Field(None, description="List of keywords (for keyword type)")
    case_sensitive: bool = Field(False, description="Case sensitive keyword matching")
    dictionary_path: Optional[str] = Field(None, description="Path to dictionary file (for dictionary type)")
    threshold: int = Field(1, ge=1, description="Minimum matches required")
    weight: float = Field(0.5, ge=0.0, le=1.0, description="Weight for confidence scoring")
    classification_labels: Optional[List[str]] = Field(None, description="Classification labels (e.g., ['PII', 'FINANCIAL'])")
    severity: Optional[str] = Field(None, description="Severity: low, medium, high, critical")
    category: Optional[str] = Field(None, description="Category (e.g., PII, Financial, Healthcare)")
    tags: Optional[List[str]] = Field(None, description="Custom tags")
    enabled: bool = Field(True, description="Enable rule immediately")

    @field_validator('type')
    @classmethod
    def validate_type(cls, v):
        valid_types = ['regex', 'keyword', 'dictionary']
        if v not in valid_types:
            raise ValueError(f"Type must be one of: {valid_types}")
        return v

    @field_validator('severity')
    @classmethod
    def validate_severity(cls, v):
        if v is not None:
            valid_severities = ['low', 'medium', 'high', 'critical']
            if v not in valid_severities:
                raise ValueError(f"Severity must be one of: {valid_severities}")
        return v


class RuleUpdate(BaseModel):
    """Rule update request"""
    name: Optional[str] = Field(None, min_length=3, max_length=255)
    description: Optional[str] = Field(None, max_length=1000)
    pattern: Optional[str] = None
    regex_flags: Optional[List[str]] = None
    keywords: Optional[List[str]] = None
    case_sensitive: Optional[bool] = None
    dictionary_path: Optional[str] = None
    threshold: Optional[int] = Field(None, ge=1)
    weight: Optional[float] = Field(None, ge=0.0, le=1.0)
    classification_labels: Optional[List[str]] = None
    severity: Optional[str] = None
    category: Optional[str] = None
    tags: Optional[List[str]] = None
    enabled: Optional[bool] = None

    @field_validator('severity')
    @classmethod
    def validate_severity(cls, v):
        if v is not None:
            valid_severities = ['low', 'medium', 'high', 'critical']
            if v not in valid_severities:
                raise ValueError(f"Severity must be one of: {valid_severities}")
        return v


class RuleResponse(BaseModel):
    """Rule response model"""
    id: str
    name: str
    description: Optional[str]
    enabled: bool
    type: str
    pattern: Optional[str]
    regex_flags: Optional[List[str]]
    keywords: Optional[List[str]]
    case_sensitive: Optional[bool]
    dictionary_path: Optional[str]
    dictionary_hash: Optional[str]
    threshold: int
    weight: float
    classification_labels: Optional[List[str]]
    severity: Optional[str]
    category: Optional[str]
    tags: Optional[List[str]]
    created_by: str
    created_at: str
    updated_at: str
    match_count: int
    last_matched_at: Optional[str]

    model_config = ConfigDict(from_attributes=True)


class RuleTestRequest(BaseModel):
    """Rule testing request"""
    content: str = Field(..., min_length=1, description="Content to test against rules")
    rule_ids: Optional[List[str]] = Field(None, description="Specific rule IDs to test (empty = all enabled rules)")


class RuleTestResponse(BaseModel):
    """Rule testing response"""
    classification: str
    confidence_score: float
    matched_rules: List[Dict[str, Any]]
    total_matches: int
    details: Dict[str, Any]


# API Endpoints

@router.post("/", status_code=status.HTTP_201_CREATED, response_model=RuleResponse)
async def create_rule(
    rule: RuleCreate,
    current_user: dict = Depends(require_role("admin")),
    session: AsyncSession = Depends(get_db),
):
    """
    Create a new classification rule.

    Requires admin role.
    """
    service = RuleService(session)

    try:
        created_rule = await service.create_rule(
            name=rule.name,
            type=rule.type,
            created_by=UUID(current_user["sub"]),
            description=rule.description,
            pattern=rule.pattern,
            regex_flags=rule.regex_flags,
            keywords=rule.keywords,
            case_sensitive=rule.case_sensitive,
            dictionary_path=rule.dictionary_path,
            threshold=rule.threshold,
            weight=rule.weight,
            classification_labels=rule.classification_labels,
            severity=rule.severity,
            category=rule.category,
            tags=rule.tags,
            enabled=rule.enabled,
        )

        return RuleResponse(**created_rule.to_dict())

    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.get("/", response_model=List[RuleResponse])
async def list_rules(
    enabled_only: bool = Query(False, description="Only return enabled rules"),
    type: Optional[str] = Query(None, description="Filter by rule type"),
    category: Optional[str] = Query(None, description="Filter by category"),
    severity: Optional[str] = Query(None, description="Filter by severity"),
    skip: int = Query(0, ge=0, description="Pagination offset"),
    limit: int = Query(100, ge=1, le=1000, description="Maximum results"),
    current_user: dict = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """
    List classification rules with optional filters.
    """
    service = RuleService(session)

    rules = await service.list_rules(
        enabled_only=enabled_only,
        type=type,
        category=category,
        severity=severity,
        skip=skip,
        limit=limit,
    )

    return [RuleResponse(**rule.to_dict()) for rule in rules]


@router.get("/statistics")
async def get_rule_statistics(
    current_user: dict = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """
    Get rule statistics.
    """
    service = RuleService(session)
    stats = await service.get_rule_statistics()
    return stats


@router.get("/{rule_id}", response_model=RuleResponse)
async def get_rule(
    rule_id: UUID,
    current_user: dict = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """
    Get a specific rule by ID.
    """
    service = RuleService(session)
    rule = await service.get_rule(rule_id)

    if not rule:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Rule {rule_id} not found"
        )

    return RuleResponse(**rule.to_dict())


@router.put("/{rule_id}", response_model=RuleResponse)
async def update_rule(
    rule_id: UUID,
    updates: RuleUpdate,
    current_user: dict = Depends(require_role("admin")),
    session: AsyncSession = Depends(get_db),
):
    """
    Update a rule.

    Requires admin role.
    """
    service = RuleService(session)

    # Convert to dict, excluding unset fields
    update_data = updates.model_dump(exclude_unset=True)

    try:
        updated_rule = await service.update_rule(rule_id, **update_data)

        if not updated_rule:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Rule {rule_id} not found"
            )

        return RuleResponse(**updated_rule.to_dict())

    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.delete("/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rule(
    rule_id: UUID,
    current_user: dict = Depends(require_role("admin")),
    session: AsyncSession = Depends(get_db),
):
    """
    Delete a rule.

    Requires admin role.
    """
    service = RuleService(session)
    deleted = await service.delete_rule(rule_id)

    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Rule {rule_id} not found"
        )


@router.post("/{rule_id}/toggle", response_model=RuleResponse)
async def toggle_rule(
    rule_id: UUID,
    enabled: bool = Body(..., embed=True),
    current_user: dict = Depends(require_role("admin")),
    session: AsyncSession = Depends(get_db),
):
    """
    Enable or disable a rule.

    Requires admin role.
    """
    service = RuleService(session)
    updated_rule = await service.toggle_rule(rule_id, enabled)

    if not updated_rule:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Rule {rule_id} not found"
        )

    return RuleResponse(**updated_rule.to_dict())


@router.post("/test", response_model=RuleTestResponse)
async def test_rules(
    test_request: RuleTestRequest,
    current_user: dict = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """
    Test content against classification rules.

    This endpoint allows testing content against all enabled rules or specific rules
    to see what would be detected and how it would be classified.
    """
    engine = ClassificationEngine(session)

    # If specific rule_ids provided, filter to those rules only
    if test_request.rule_ids:
        # TODO: Filter to specific rules - for now, use all rules
        pass

    result = await engine.classify_content(test_request.content)

    return RuleTestResponse(
        classification=result.classification,
        confidence_score=result.confidence_score,
        matched_rules=result.matched_rules,
        total_matches=result.total_matches,
        details=result.details,
    )


@router.post("/bulk-import")
async def bulk_import_rules(
    rules: List[RuleCreate],
    current_user: dict = Depends(require_role("admin")),
    session: AsyncSession = Depends(get_db),
):
    """
    Bulk import rules.

    Requires admin role.
    """
    service = RuleService(session)
    created_rules = []
    errors = []

    for idx, rule_data in enumerate(rules):
        try:
            created_rule = await service.create_rule(
                name=rule_data.name,
                type=rule_data.type,
                created_by=UUID(current_user["sub"]),
                description=rule_data.description,
                pattern=rule_data.pattern,
                regex_flags=rule_data.regex_flags,
                keywords=rule_data.keywords,
                case_sensitive=rule_data.case_sensitive,
                dictionary_path=rule_data.dictionary_path,
                threshold=rule_data.threshold,
                weight=rule_data.weight,
                classification_labels=rule_data.classification_labels,
                severity=rule_data.severity,
                category=rule_data.category,
                tags=rule_data.tags,
                enabled=rule_data.enabled,
            )
            created_rules.append(created_rule.to_dict())
        except Exception as e:
            errors.append({
                "index": idx,
                "name": rule_data.name,
                "error": str(e)
            })

    return {
        "success_count": len(created_rules),
        "error_count": len(errors),
        "created_rules": created_rules,
        "errors": errors,
    }
