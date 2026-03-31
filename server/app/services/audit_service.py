"""
Audit Logging Service
"""
from typing import Optional, List
from datetime import datetime
from uuid import UUID
from sqlalchemy import select, and_, func
from sqlalchemy.ext.asyncio import AsyncSession
import structlog

from app.models.audit_log import AuditLog

logger = structlog.get_logger()


class AuditService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def log_action(self, user_id: Optional[UUID], action: str, details: dict = None) -> AuditLog:
        entry = AuditLog(user_id=user_id, action=action, details=details)
        self.db.add(entry)
        await self.db.flush()
        return entry

    async def get_logs(self, skip=0, limit=100, user_id=None, action=None, start_date=None, end_date=None) -> List[AuditLog]:
        query = select(AuditLog)
        filters = []
        if user_id:
            filters.append(AuditLog.user_id == user_id)
        if action:
            filters.append(AuditLog.action == action)
        if start_date:
            filters.append(AuditLog.created_at >= start_date)
        if end_date:
            filters.append(AuditLog.created_at <= end_date)
        if filters:
            query = query.where(and_(*filters))
        query = query.order_by(AuditLog.created_at.desc()).offset(skip).limit(limit)
        result = await self.db.execute(query)
        return list(result.scalars().all())

    async def count_logs(self, user_id=None, action=None, start_date=None, end_date=None) -> int:
        query = select(func.count(AuditLog.id))
        filters = []
        if user_id:
            filters.append(AuditLog.user_id == user_id)
        if action:
            filters.append(AuditLog.action == action)
        if start_date:
            filters.append(AuditLog.created_at >= start_date)
        if end_date:
            filters.append(AuditLog.created_at <= end_date)
        if filters:
            query = query.where(and_(*filters))
        result = await self.db.execute(query)
        return result.scalar() or 0

    async def get_distinct_actions(self) -> List[str]:
        result = await self.db.execute(select(AuditLog.action).distinct().order_by(AuditLog.action))
        return [row[0] for row in result.fetchall()]


async def audit_log(user_id, action: str, details: dict = None):
    """Fire-and-forget audit log entry. Uses its own session."""
    import app.core.database as _db
    try:
        if _db.postgres_session_factory:
            async with _db.postgres_session_factory() as session:
                svc = AuditService(session)
                await svc.log_action(user_id, action, details)
                await session.commit()
    except Exception as e:
        logger.warning("Failed to write audit log", action=action, error=str(e))
