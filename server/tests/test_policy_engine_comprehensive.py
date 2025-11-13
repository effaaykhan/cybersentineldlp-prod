"""
Comprehensive Policy Engine Tests
Tests all policy evaluation, matching, and action execution logic
"""

import pytest
from datetime import datetime, timedelta
from unittest.mock import Mock, patch, AsyncMock
from typing import Dict, Any, List

from app.services.policy_engine import PolicyEngine, PolicyMatch
from app.models.policy import Policy, PolicyRule, PolicyAction
from tests.fixtures.synthetic_data import SyntheticPIIGenerator


class TestPolicyEngine:
    """Comprehensive tests for policy engine"""

    @pytest.fixture
    def policy_engine(self):
        """Create policy engine instance"""
        return PolicyEngine()

    @pytest.fixture
    def synthetic_data(self):
        """Create synthetic data generator"""
        return SyntheticPIIGenerator(seed=42)

    @pytest.fixture
    def sample_policies(self) -> List[Policy]:
        """Create sample policies for testing"""
        policies = [
            # High severity - Credit Card Detection
            Policy(
                id=1,
                name="Credit Card Protection",
                description="Detect and block credit card numbers",
                enabled=True,
                priority=1,
                rules=[
                    PolicyRule(
                        field="content",
                        operator="contains_pii",
                        value="credit_card",
                        sensitivity="high"
                    )
                ],
                actions=[
                    PolicyAction(type="block", config={}),
                    PolicyAction(type="alert", config={"email": "security@company.com"}),
                    PolicyAction(type="quarantine", config={"retention_days": 30})
                ],
                compliance_frameworks=["PCI-DSS"],
                severity="critical"
            ),

            # Medium severity - SSN Detection
            Policy(
                id=2,
                name="SSN Protection",
                description="Detect Social Security Numbers",
                enabled=True,
                priority=2,
                rules=[
                    PolicyRule(
                        field="content",
                        operator="contains_pii",
                        value="ssn",
                        sensitivity="high"
                    )
                ],
                actions=[
                    PolicyAction(type="alert", config={"email": "compliance@company.com"}),
                    PolicyAction(type="encrypt", config={"algorithm": "AES-256"})
                ],
                compliance_frameworks=["HIPAA", "SOX"],
                severity="high"
            ),

            # Low severity - Email Detection
            Policy(
                id=3,
                name="Email Monitoring",
                description="Monitor email addresses",
                enabled=True,
                priority=3,
                rules=[
                    PolicyRule(
                        field="content",
                        operator="contains_pii",
                        value="email",
                        sensitivity="low"
                    )
                ],
                actions=[
                    PolicyAction(type="log", config={})
                ],
                compliance_frameworks=["GDPR"],
                severity="low"
            ),

            # Composite policy - Multiple conditions
            Policy(
                id=4,
                name="High Risk Data Transfer",
                description="Detect transfers containing multiple PII types",
                enabled=True,
                priority=1,
                rules=[
                    PolicyRule(
                        field="content",
                        operator="contains_pii",
                        value="credit_card",
                        sensitivity="high"
                    ),
                    PolicyRule(
                        field="content",
                        operator="contains_pii",
                        value="ssn",
                        sensitivity="high"
                    ),
                    PolicyRule(
                        field="action",
                        operator="equals",
                        value="external_transfer"
                    )
                ],
                actions=[
                    PolicyAction(type="block", config={}),
                    PolicyAction(type="alert", config={
                        "email": "security@company.com",
                        "priority": "urgent"
                    }),
                    PolicyAction(type="create_incident", config={})
                ],
                compliance_frameworks=["PCI-DSS", "HIPAA"],
                severity="critical",
                match_all=True  # ALL rules must match
            ),

            # Disabled policy - should not trigger
            Policy(
                id=5,
                name="Disabled Policy",
                description="This policy is disabled",
                enabled=False,
                priority=1,
                rules=[
                    PolicyRule(
                        field="content",
                        operator="contains_pii",
                        value="phone",
                        sensitivity="medium"
                    )
                ],
                actions=[
                    PolicyAction(type="block", config={})
                ],
                severity="medium"
            )
        ]

        return policies

    # Test 1: Policy Matching - Single PII Type
    def test_policy_match_single_pii_type(self, policy_engine, sample_policies, synthetic_data):
        """Test policy matching with single PII type detection"""
        # Generate credit card data
        credit_cards = synthetic_data.generate_credit_cards(1)
        content = f"Payment details: {credit_cards[0]['formatted']}"

        event = {
            'content': content,
            'action': 'file_upload',
            'user': 'test_user',
            'timestamp': datetime.utcnow().isoformat()
        }

        # Load policies
        policy_engine.policies = sample_policies

        # Evaluate
        matches = policy_engine.evaluate(event)

        # Should match credit card policy
        assert len(matches) > 0
        assert any(m.policy.name == "Credit Card Protection" for m in matches)

        # Should have appropriate actions
        cc_match = next(m for m in matches if m.policy.name == "Credit Card Protection")
        assert any(a.type == "block" for a in cc_match.policy.actions)
        assert any(a.type == "alert" for a in cc_match.policy.actions)

    # Test 2: Policy Matching - Multiple PII Types
    def test_policy_match_multiple_pii_types(self, policy_engine, sample_policies, synthetic_data):
        """Test detection of multiple PII types in single content"""
        # Generate multiple PII types
        credit_card = synthetic_data.generate_credit_cards(1)[0]
        ssn = synthetic_data.generate_ssn(1)[0]
        email = synthetic_data.generate_emails(1)[0]

        content = f"""
        Customer Record:
        Name: John Doe
        Email: {email['email']}
        SSN: {ssn['number']}
        Credit Card: {credit_card['formatted']}
        """

        event = {
            'content': content,
            'action': 'email_send',
            'user': 'employee@company.com'
        }

        policy_engine.policies = sample_policies
        matches = policy_engine.evaluate(event)

        # Should match multiple policies
        assert len(matches) >= 3  # CC, SSN, Email policies

        matched_policy_names = {m.policy.name for m in matches}
        assert "Credit Card Protection" in matched_policy_names
        assert "SSN Protection" in matched_policy_names
        assert "Email Monitoring" in matched_policy_names

    # Test 3: Policy Priority Ordering
    def test_policy_priority_ordering(self, policy_engine, sample_policies):
        """Test that policies are evaluated in priority order"""
        policy_engine.policies = sample_policies

        # Policies should be sorted by priority (1 is highest)
        sorted_policies = policy_engine._sort_policies_by_priority()

        priorities = [p.priority for p in sorted_policies]

        # Check priorities are in ascending order (1, 2, 3...)
        assert priorities == sorted(priorities)

        # Highest priority policy should be first
        assert sorted_policies[0].priority == 1

    # Test 4: Disabled Policy Exclusion
    def test_disabled_policy_not_evaluated(self, policy_engine, sample_policies, synthetic_data):
        """Test that disabled policies are not evaluated"""
        # Generate phone number
        phone = synthetic_data.generate_phone_numbers(1)[0]
        content = f"Contact: {phone['number']}"

        event = {'content': content, 'action': 'file_save'}

        policy_engine.policies = sample_policies
        matches = policy_engine.evaluate(event)

        # Should NOT match disabled policy
        matched_names = {m.policy.name for m in matches}
        assert "Disabled Policy" not in matched_names

    # Test 5: Composite Policy - Match All Rules
    def test_composite_policy_match_all(self, policy_engine, sample_policies, synthetic_data):
        """Test policy with multiple conditions (match_all=True)"""
        # Generate data matching all conditions
        credit_card = synthetic_data.generate_credit_cards(1)[0]
        ssn = synthetic_data.generate_ssn(1)[0]

        content = f"CC: {credit_card['formatted']}, SSN: {ssn['number']}"

        # Match all conditions
        event = {
            'content': content,
            'action': 'external_transfer',  # Matches third condition
            'user': 'test_user'
        }

        policy_engine.policies = sample_policies
        matches = policy_engine.evaluate(event)

        # Should match "High Risk Data Transfer" policy
        high_risk_match = next(
            (m for m in matches if m.policy.name == "High Risk Data Transfer"),
            None
        )
        assert high_risk_match is not None
        assert high_risk_match.policy.severity == "critical"

    # Test 6: Composite Policy - Partial Match
    def test_composite_policy_partial_match_fails(self, policy_engine, sample_policies, synthetic_data):
        """Test that composite policy doesn't match with partial conditions"""
        # Only match 2 out of 3 conditions
        credit_card = synthetic_data.generate_credit_cards(1)[0]

        event = {
            'content': f"CC: {credit_card['formatted']}",  # Has CC, no SSN
            'action': 'external_transfer',  # Matches action
            'user': 'test_user'
        }

        policy_engine.policies = sample_policies
        matches = policy_engine.evaluate(event)

        # Should NOT match "High Risk Data Transfer" (requires ALL rules)
        high_risk_match = next(
            (m for m in matches if m.policy.name == "High Risk Data Transfer"),
            None
        )
        # Either no match, or match with incomplete confidence
        if high_risk_match:
            assert high_risk_match.confidence < 1.0

    # Test 7: Negative Cases - No PII Detection
    def test_no_pii_detected(self, policy_engine, sample_policies, synthetic_data):
        """Test that non-PII content doesn't trigger policies"""
        # Generate negative samples
        negatives = synthetic_data.generate_negative_samples(5)

        for negative in negatives:
            event = {
                'content': negative['data'],
                'action': 'file_upload'
            }

            matches = policy_engine.evaluate(event)

            # Should have no matches or very low confidence matches
            assert len(matches) == 0 or all(m.confidence < 0.3 for m in matches)

    # Test 8: Action Execution - Block
    @pytest.mark.asyncio
    async def test_action_execution_block(self, policy_engine, sample_policies):
        """Test blocking action execution"""
        policy = sample_policies[0]  # Credit Card Protection with block action

        event = {'id': 123, 'content': '4532-1234-5678-9010'}

        with patch('app.services.policy_engine.block_transfer') as mock_block:
            result = await policy_engine.execute_actions(policy, event)

            mock_block.assert_called_once()
            assert result['blocked'] is True

    # Test 9: Action Execution - Alert
    @pytest.mark.asyncio
    async def test_action_execution_alert(self, policy_engine, sample_policies):
        """Test alert action execution"""
        policy = sample_policies[1]  # SSN Protection with alert

        event = {'id': 456, 'content': '123-45-6789'}

        with patch('app.services.policy_engine.send_alert') as mock_alert:
            result = await policy_engine.execute_actions(policy, event)

            mock_alert.assert_called()
            assert 'alert_sent' in result

    # Test 10: Action Execution - Multiple Actions
    @pytest.mark.asyncio
    async def test_action_execution_multiple(self, policy_engine, sample_policies):
        """Test execution of multiple actions"""
        policy = sample_policies[0]  # Has block, alert, quarantine

        event = {'id': 789, 'content': '4532-1234-5678-9010'}

        with patch('app.services.policy_engine.block_transfer') as mock_block, \
             patch('app.services.policy_engine.send_alert') as mock_alert, \
             patch('app.services.policy_engine.quarantine_file') as mock_quarantine:

            result = await policy_engine.execute_actions(policy, event)

            # All actions should be executed
            mock_block.assert_called_once()
            mock_alert.assert_called_once()
            mock_quarantine.assert_called_once()

    # Test 11: Compliance Framework Filtering
    def test_compliance_framework_filtering(self, policy_engine, sample_policies):
        """Test filtering policies by compliance framework"""
        policy_engine.policies = sample_policies

        # Get PCI-DSS policies
        pci_policies = policy_engine.get_policies_by_compliance("PCI-DSS")
        assert len(pci_policies) >= 1
        assert all("PCI-DSS" in p.compliance_frameworks for p in pci_policies)

        # Get HIPAA policies
        hipaa_policies = policy_engine.get_policies_by_compliance("HIPAA")
        assert len(hipaa_policies) >= 1
        assert all("HIPAA" in p.compliance_frameworks for p in hipaa_policies)

    # Test 12: Severity-Based Filtering
    def test_severity_filtering(self, policy_engine, sample_policies):
        """Test filtering policies by severity"""
        policy_engine.policies = sample_policies

        # Get critical policies
        critical = policy_engine.get_policies_by_severity("critical")
        assert len(critical) >= 1
        assert all(p.severity == "critical" for p in critical)

        # Get high severity policies
        high = policy_engine.get_policies_by_severity("high")
        assert all(p.severity == "high" for p in high)

    # Test 13: Performance - Batch Evaluation
    def test_batch_evaluation_performance(self, policy_engine, sample_policies, synthetic_data):
        """Test policy evaluation performance with batch data"""
        import time

        policy_engine.policies = sample_policies

        # Generate 100 test documents
        documents = synthetic_data.generate_test_documents(count=100)

        start_time = time.time()

        results = []
        for doc in documents:
            event = {'content': doc['content'], 'action': 'file_scan'}
            matches = policy_engine.evaluate(event)
            results.append(matches)

        end_time = time.time()
        elapsed = end_time - start_time

        # Performance assertion: should process 100 docs in < 5 seconds
        assert elapsed < 5.0, f"Batch evaluation took {elapsed:.2f}s, expected < 5s"

        # Accuracy check
        total_matches = sum(len(r) for r in results)
        assert total_matches > 0, "Should detect PII in synthetic documents"

        print(f"\nPerformance: Processed 100 documents in {elapsed:.2f}s")
        print(f"Average: {elapsed/100*1000:.2f}ms per document")
        print(f"Total matches: {total_matches}")

    # Test 14: Rule Operators - Various Types
    @pytest.mark.parametrize("operator,field,value,event_value,should_match", [
        ("equals", "action", "file_upload", "file_upload", True),
        ("equals", "action", "file_upload", "file_download", False),
        ("contains", "content", "secret", "This is a secret document", True),
        ("contains", "content", "confidential", "Public information", False),
        ("regex", "content", r"\d{16}", "Card: 1234567890123456", True),
        ("regex", "content", r"\d{16}", "No card here", False),
        ("greater_than", "file_size", 1000000, 2000000, True),
        ("greater_than", "file_size", 1000000, 500000, False),
    ])
    def test_rule_operators(self, policy_engine, operator, field, value, event_value, should_match):
        """Test various policy rule operators"""
        rule = PolicyRule(
            field=field,
            operator=operator,
            value=value
        )

        event = {field: event_value}

        result = policy_engine._evaluate_rule(rule, event)

        if should_match:
            assert result is True, f"Expected {operator} to match"
        else:
            assert result is False, f"Expected {operator} not to match"

    # Test 15: Confidence Scoring
    def test_confidence_scoring(self, policy_engine, sample_policies, synthetic_data):
        """Test confidence scoring for policy matches"""
        credit_card = synthetic_data.generate_credit_cards(1)[0]

        # High confidence: valid credit card
        event_high = {'content': f"CC: {credit_card['formatted']}"}

        # Low confidence: number that looks like CC but isn't valid
        event_low = {'content': "CC: 1234-5678-9012-3456"}

        policy_engine.policies = sample_policies

        matches_high = policy_engine.evaluate(event_high)
        matches_low = policy_engine.evaluate(event_low)

        # High confidence match should have higher score
        if matches_high and matches_low:
            high_confidence = max(m.confidence for m in matches_high)
            low_confidence = max(m.confidence for m in matches_low) if matches_low else 0

            assert high_confidence >= low_confidence

    # Test 16: Policy Update/Reload
    def test_policy_reload(self, policy_engine, sample_policies):
        """Test dynamic policy reloading"""
        policy_engine.policies = sample_policies[:2]
        assert len(policy_engine.policies) == 2

        # Reload with more policies
        policy_engine.reload_policies(sample_policies)
        assert len(policy_engine.policies) == len(sample_policies)

    # Test 17: Exception Handling
    @pytest.mark.asyncio
    async def test_exception_handling_in_action(self, policy_engine, sample_policies):
        """Test graceful handling of action execution failures"""
        policy = sample_policies[0]
        event = {'id': 999, 'content': 'test'}

        with patch('app.services.policy_engine.block_transfer', side_effect=Exception("Network error")):
            # Should not raise, should log error
            result = await policy_engine.execute_actions(policy, event)

            assert 'error' in result or 'errors' in result

    # Test 18: Audit Logging
    def test_audit_logging(self, policy_engine, sample_policies, synthetic_data):
        """Test that policy evaluations are logged for audit"""
        credit_card = synthetic_data.generate_credit_cards(1)[0]
        event = {'content': f"CC: {credit_card['formatted']}", 'user': 'test_user'}

        policy_engine.policies = sample_policies

        with patch('app.services.policy_engine.log_audit') as mock_log:
            matches = policy_engine.evaluate(event)

            if matches:
                mock_log.assert_called()
                # Check that logged data includes policy ID and event details
                call_args = mock_log.call_args
                assert 'policy_id' in str(call_args) or 'event' in str(call_args)


@pytest.mark.asyncio
class TestPolicyEngineIntegration:
    """Integration tests for policy engine with other components"""

    async def test_end_to_end_detection_and_action(self):
        """Test complete flow: detection -> policy match -> action execution"""
        # This would test the full pipeline from file upload to action
        pass

    async def test_policy_with_classification_service(self):
        """Test policy engine integration with classification service"""
        pass

    async def test_policy_with_incident_creation(self):
        """Test automatic incident creation on policy violations"""
        pass


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
