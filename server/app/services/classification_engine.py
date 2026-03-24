"""
Production-Grade Classification Engine
Uses dynamic rules for sensitive data detection with confidence scoring
"""

from typing import Dict, Any, List, Optional, Tuple
from dataclasses import dataclass
from datetime import datetime, timedelta
import re
import hashlib
import structlog
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models.rule import Rule

logger = structlog.get_logger()


@dataclass
class ClassificationResult:
    """Result of classification analysis"""
    classification: str  # 'Public', 'Internal', 'Confidential', 'Restricted'
    confidence_score: float  # 0.0 - 1.0
    matched_rules: List[Dict[str, Any]]
    total_matches: int
    details: Dict[str, Any]


class ClassificationEngine:
    """
    Classification Engine that uses database rules for content analysis.

    Classification Levels (based on confidence score):
    - 0.0 - 0.3: Public
    - 0.3 - 0.6: Internal
    - 0.6 - 0.8: Confidential
    - 0.8 - 1.0: Restricted
    """

    def __init__(self, session: AsyncSession, cache_ttl_seconds: int = 60):
        self.session = session
        self._cache_ttl = timedelta(seconds=cache_ttl_seconds)
        self._cached_rules: List[Rule] = []
        self._cache_expires_at: Optional[datetime] = None
        self._regex_cache: Dict[str, re.Pattern] = {}
        self._dictionary_cache: Dict[str, set] = {}

    async def classify_content(self, content: str, context: Optional[Dict[str, Any]] = None) -> ClassificationResult:
        """
        Classify content using enabled rules.

        Args:
            content: Text content to classify
            context: Additional context (file_type, source, etc.)

        Returns:
            ClassificationResult with classification level and details
        """
        if not content or not isinstance(content, str):
            return ClassificationResult(
                classification="Public",
                confidence_score=0.0,
                matched_rules=[],
                total_matches=0,
                details={"reason": "No content to classify"}
            )

        # Get enabled rules
        rules = await self._get_cached_rules()
        if not rules:
            logger.warning("No enabled rules found for classification")
            return ClassificationResult(
                classification="Public",
                confidence_score=0.0,
                matched_rules=[],
                total_matches=0,
                details={"reason": "No rules available"}
            )

        # Evaluate each rule against content
        matched_rules = []
        total_weight = 0.0
        total_matches = 0

        for rule in rules:
            matches, match_count = await self._evaluate_rule(rule, content, context)
            if matches and match_count >= rule.threshold:
                matched_rules.append({
                    "rule_id": str(rule.id),
                    "rule_name": rule.name,
                    "rule_type": rule.type,
                    "match_count": match_count,
                    "weight": rule.weight,
                    "classification_labels": rule.classification_labels or [],
                    "severity": rule.severity,
                    "category": rule.category,
                })
                # Accumulate weighted score
                # Use min to cap contribution at weight (multiple matches don't exceed weight)
                contribution = min(rule.weight, rule.weight * (match_count / rule.threshold))
                total_weight += contribution
                total_matches += match_count

        # Calculate confidence score (capped at 1.0)
        confidence_score = min(1.0, total_weight)

        # Determine classification level
        classification = self._determine_classification(confidence_score)

        logger.info(
            "Content classified",
            classification=classification,
            confidence=confidence_score,
            matched_rules_count=len(matched_rules),
            total_matches=total_matches
        )

        return ClassificationResult(
            classification=classification,
            confidence_score=confidence_score,
            matched_rules=matched_rules,
            total_matches=total_matches,
            details={
                "content_length": len(content),
                "rules_evaluated": len(rules),
                "context": context or {}
            }
        )

    async def _get_cached_rules(self) -> List[Rule]:
        """Get enabled rules with caching"""
        if self._cache_expires_at and self._cache_expires_at > datetime.utcnow() and self._cached_rules:
            return self._cached_rules

        # Fetch enabled rules from database
        stmt = select(Rule).where(Rule.enabled == True).order_by(Rule.weight.desc())
        result = await self.session.execute(stmt)
        rules = result.scalars().all()

        self._cached_rules = list(rules)
        self._cache_expires_at = datetime.utcnow() + self._cache_ttl

        logger.info(
            "Rule cache refreshed",
            rule_count=len(rules),
            cache_ttl_seconds=int(self._cache_ttl.total_seconds())
        )

        return self._cached_rules

    async def _evaluate_rule(
        self,
        rule: Rule,
        content: str,
        context: Optional[Dict[str, Any]]
    ) -> Tuple[bool, int]:
        """
        Evaluate a single rule against content.

        Returns:
            (matched: bool, match_count: int)
        """
        try:
            if rule.type == "regex":
                return await self._evaluate_regex_rule(rule, content)
            elif rule.type == "keyword":
                return await self._evaluate_keyword_rule(rule, content)
            elif rule.type == "dictionary":
                return await self._evaluate_dictionary_rule(rule, content)
            else:
                logger.warning("Unknown rule type", rule_type=rule.type, rule_name=rule.name)
                return False, 0
        except Exception as e:
            logger.error(
                "Rule evaluation failed",
                rule_name=rule.name,
                rule_type=rule.type,
                error=str(e)
            )
            return False, 0

    async def _evaluate_regex_rule(self, rule: Rule, content: str) -> Tuple[bool, int]:
        """Evaluate regex pattern rule"""
        if not rule.pattern:
            return False, 0

        # Get compiled regex from cache or compile
        pattern_key = f"{rule.id}:{rule.pattern}"
        if pattern_key not in self._regex_cache:
            flags = 0
            if rule.regex_flags:
                for flag_name in rule.regex_flags:
                    if hasattr(re, flag_name):
                        flags |= getattr(re, flag_name)
            try:
                self._regex_cache[pattern_key] = re.compile(rule.pattern, flags)
            except re.error as e:
                logger.error("Invalid regex pattern", rule_name=rule.name, error=str(e))
                return False, 0

        pattern = self._regex_cache[pattern_key]
        matches = pattern.findall(content)
        match_count = len(matches)

        return match_count > 0, match_count

    async def _evaluate_keyword_rule(self, rule: Rule, content: str) -> Tuple[bool, int]:
        """Evaluate keyword matching rule"""
        if not rule.keywords:
            return False, 0

        if rule.case_sensitive:
            search_content = content
            search_keywords = rule.keywords
        else:
            search_content = content.lower()
            search_keywords = [kw.lower() for kw in rule.keywords]

        match_count = 0
        for keyword in search_keywords:
            # Count occurrences of each keyword
            count = search_content.count(keyword)
            match_count += count

        return match_count > 0, match_count

    async def _evaluate_dictionary_rule(self, rule: Rule, content: str) -> Tuple[bool, int]:
        """Evaluate dictionary-based rule"""
        if not rule.dictionary_path:
            return False, 0

        # Load dictionary from file with caching
        dict_key = f"{rule.id}:{rule.dictionary_path}"
        if dict_key not in self._dictionary_cache:
            try:
                words = await self._load_dictionary(rule.dictionary_path)
                self._dictionary_cache[dict_key] = words
            except Exception as e:
                logger.error(
                    "Failed to load dictionary",
                    rule_name=rule.name,
                    path=rule.dictionary_path,
                    error=str(e)
                )
                return False, 0

        dictionary = self._dictionary_cache[dict_key]

        # Split content into words
        content_words = set(re.findall(r'\b\w+\b', content.lower()))

        # Find intersection
        matched_words = content_words & dictionary
        match_count = len(matched_words)

        return match_count > 0, match_count

    async def _load_dictionary(self, path: str) -> set:
        """Load dictionary file into a set of words"""
        file_path = Path(path)
        if not file_path.exists():
            raise FileNotFoundError(f"Dictionary file not found: {path}")

        with open(file_path, 'r', encoding='utf-8') as f:
            words = {line.strip().lower() for line in f if line.strip()}

        logger.info("Dictionary loaded", path=path, word_count=len(words))
        return words

    def _determine_classification(self, confidence_score: float) -> str:
        """
        Determine classification level based on confidence score.

        Thresholds:
        - 0.0 - 0.3: Public
        - 0.3 - 0.6: Internal
        - 0.6 - 0.8: Confidential
        - 0.8 - 1.0: Restricted
        """
        if confidence_score >= 0.8:
            return "Restricted"
        elif confidence_score >= 0.6:
            return "Confidential"
        elif confidence_score >= 0.3:
            return "Internal"
        else:
            return "Public"

    def clear_cache(self):
        """Clear all caches"""
        self._cached_rules = []
        self._cache_expires_at = None
        self._regex_cache.clear()
        self._dictionary_cache.clear()
        logger.info("Classification engine caches cleared")


async def get_classification_engine(session: AsyncSession) -> ClassificationEngine:
    """Factory function to create classification engine"""
    return ClassificationEngine(session)
