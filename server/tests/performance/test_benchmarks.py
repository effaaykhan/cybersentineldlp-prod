"""
Performance Benchmarking Tests
Measure detection latency, throughput, and accuracy metrics
"""

import pytest
import time
import asyncio
from statistics import mean, median, stdev
from typing import List, Dict, Any
import json

from tests.fixtures.synthetic_data import SyntheticPIIGenerator
from app.services.policy_engine import PolicyEngine
from app.ml.classifier import DLPClassifier


class PerformanceBenchmark:
    """Performance testing and metrics collection"""

    def __init__(self):
        self.results = []
        self.metrics = {}

    def measure_execution_time(self, func, *args, **kwargs):
        """Measure execution time of a function"""
        start = time.perf_counter()
        result = func(*args, **kwargs)
        end = time.perf_counter()
        elapsed_ms = (end - start) * 1000
        return result, elapsed_ms

    async def measure_async_execution_time(self, func, *args, **kwargs):
        """Measure execution time of an async function"""
        start = time.perf_counter()
        result = await func(*args, **kwargs)
        end = time.perf_counter()
        elapsed_ms = (end - start) * 1000
        return result, elapsed_ms

    def calculate_statistics(self, measurements: List[float]) -> Dict[str, float]:
        """Calculate statistical metrics from measurements"""
        if not measurements:
            return {}

        return {
            'count': len(measurements),
            'min': min(measurements),
            'max': max(measurements),
            'mean': mean(measurements),
            'median': median(measurements),
            'stdev': stdev(measurements) if len(measurements) > 1 else 0,
            'p50': self._percentile(measurements, 50),
            'p95': self._percentile(measurements, 95),
            'p99': self._percentile(measurements, 99)
        }

    def _percentile(self, data: List[float], percentile: int) -> float:
        """Calculate percentile value"""
        sorted_data = sorted(data)
        index = int((percentile / 100) * len(sorted_data))
        return sorted_data[min(index, len(sorted_data) - 1)]

    def calculate_accuracy_metrics(
        self,
        true_positives: int,
        false_positives: int,
        true_negatives: int,
        false_negatives: int
    ) -> Dict[str, float]:
        """Calculate accuracy, precision, recall, F1 score"""
        total = true_positives + false_positives + true_negatives + false_negatives

        accuracy = (true_positives + true_negatives) / total if total > 0 else 0

        precision = true_positives / (true_positives + false_positives) if (true_positives + false_positives) > 0 else 0

        recall = true_positives / (true_positives + false_negatives) if (true_positives + false_negatives) > 0 else 0

        f1_score = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0

        return {
            'accuracy': accuracy,
            'precision': precision,
            'recall': recall,
            'f1_score': f1_score,
            'true_positives': true_positives,
            'false_positives': false_positives,
            'true_negatives': true_negatives,
            'false_negatives': false_negatives
        }


class TestDetectionPerformance:
    """Test detection performance metrics"""

    @pytest.fixture
    def benchmark(self):
        return PerformanceBenchmark()

    @pytest.fixture
    def synthetic_data(self):
        return SyntheticPIIGenerator(seed=42)

    @pytest.fixture
    def policy_engine(self):
        engine = PolicyEngine()
        # Load default policies
        engine.load_default_policies()
        return engine

    def test_single_document_latency(self, benchmark, synthetic_data, policy_engine):
        """
        Test: Measure latency for single document processing
        Target: < 100ms for p95 latency
        """
        documents = synthetic_data.generate_test_documents(count=100)
        latencies = []

        for doc in documents:
            event = {'content': doc['content'], 'action': 'file_scan'}

            _, elapsed = benchmark.measure_execution_time(
                policy_engine.evaluate,
                event
            )
            latencies.append(elapsed)

        stats = benchmark.calculate_statistics(latencies)

        print(f"\n=== Single Document Latency ===")
        print(f"Mean:   {stats['mean']:.2f}ms")
        print(f"Median: {stats['median']:.2f}ms")
        print(f"p95:    {stats['p95']:.2f}ms")
        print(f"p99:    {stats['p99']:.2f}ms")
        print(f"Min:    {stats['min']:.2f}ms")
        print(f"Max:    {stats['max']:.2f}ms")

        # Performance assertion
        assert stats['p95'] < 100, f"p95 latency {stats['p95']:.2f}ms exceeds 100ms target"
        assert stats['mean'] < 50, f"Mean latency {stats['mean']:.2f}ms exceeds 50ms target"

    def test_throughput_events_per_second(self, benchmark, synthetic_data, policy_engine):
        """
        Test: Measure throughput (events/second)
        Target: > 100 events/second
        """
        num_events = 1000
        documents = synthetic_data.generate_test_documents(count=num_events)

        start_time = time.perf_counter()

        for doc in documents:
            event = {'content': doc['content'], 'action': 'file_scan'}
            policy_engine.evaluate(event)

        end_time = time.perf_counter()
        elapsed_seconds = end_time - start_time

        throughput = num_events / elapsed_seconds

        print(f"\n=== Throughput Test ===")
        print(f"Events processed: {num_events}")
        print(f"Total time: {elapsed_seconds:.2f}s")
        print(f"Throughput: {throughput:.2f} events/second")

        # Performance assertion
        assert throughput > 100, f"Throughput {throughput:.2f} events/s is below 100 events/s target"

    def test_concurrent_processing(self, benchmark, synthetic_data, policy_engine):
        """
        Test: Measure performance with concurrent requests
        Target: Handle 10 concurrent requests with < 200ms latency
        """
        documents = synthetic_data.generate_test_documents(count=10)

        async def process_event(doc):
            event = {'content': doc['content'], 'action': 'file_scan'}
            start = time.perf_counter()
            result = policy_engine.evaluate(event)
            end = time.perf_counter()
            return (end - start) * 1000, result

        async def run_concurrent():
            tasks = [process_event(doc) for doc in documents]
            results = await asyncio.gather(*tasks)
            return results

        # Run concurrent processing
        latencies_and_results = asyncio.run(run_concurrent())
        latencies = [lr[0] for lr in latencies_and_results]

        stats = benchmark.calculate_statistics(latencies)

        print(f"\n=== Concurrent Processing (10 requests) ===")
        print(f"Mean latency: {stats['mean']:.2f}ms")
        print(f"p95 latency: {stats['p95']:.2f}ms")
        print(f"Max latency: {stats['max']:.2f}ms")

        # Performance assertion
        assert stats['p95'] < 200, f"Concurrent p95 latency {stats['p95']:.2f}ms exceeds 200ms"

    def test_detection_accuracy_credit_cards(self, benchmark, synthetic_data, policy_engine):
        """
        Test: Measure detection accuracy for credit cards
        Target: > 95% accuracy, < 2% false positives
        """
        # Generate positive samples (real credit cards)
        positive_samples = synthetic_data.generate_credit_cards(count=100)

        # Generate negative samples (should not be detected)
        negative_samples = synthetic_data.generate_negative_samples(count=100)

        true_positives = 0
        false_negatives = 0
        true_negatives = 0
        false_positives = 0

        # Test positive samples
        for cc in positive_samples:
            event = {'content': f"Payment: {cc['formatted']}", 'action': 'test'}
            matches = policy_engine.evaluate(event)

            # Check if credit card was detected
            detected = any(
                'credit' in str(m.policy.name).lower() or
                'card' in str(m.policy.name).lower()
                for m in matches
            )

            if detected:
                true_positives += 1
            else:
                false_negatives += 1

        # Test negative samples
        for neg in negative_samples:
            event = {'content': neg['data'], 'action': 'test'}
            matches = policy_engine.evaluate(event)

            detected = any(
                'credit' in str(m.policy.name).lower() or
                'card' in str(m.policy.name).lower()
                for m in matches
            )

            if not detected:
                true_negatives += 1
            else:
                false_positives += 1

        metrics = benchmark.calculate_accuracy_metrics(
            true_positives, false_positives, true_negatives, false_negatives
        )

        print(f"\n=== Credit Card Detection Accuracy ===")
        print(f"Accuracy:  {metrics['accuracy']*100:.2f}%")
        print(f"Precision: {metrics['precision']*100:.2f}%")
        print(f"Recall:    {metrics['recall']*100:.2f}%")
        print(f"F1 Score:  {metrics['f1_score']:.4f}")
        print(f"True Positives:  {metrics['true_positives']}")
        print(f"False Positives: {metrics['false_positives']}")
        print(f"True Negatives:  {metrics['true_negatives']}")
        print(f"False Negatives: {metrics['false_negatives']}")

        # Accuracy assertions
        assert metrics['accuracy'] > 0.95, f"Accuracy {metrics['accuracy']*100:.2f}% below 95% target"
        assert metrics['precision'] > 0.95, f"Precision {metrics['precision']*100:.2f}% below 95% target"

        # False positive rate should be < 2%
        false_positive_rate = false_positives / (false_positives + true_negatives)
        assert false_positive_rate < 0.02, f"False positive rate {false_positive_rate*100:.2f}% exceeds 2%"

    def test_detection_accuracy_ssn(self, benchmark, synthetic_data, policy_engine):
        """
        Test: Measure detection accuracy for SSN
        Target: > 95% accuracy
        """
        positive_samples = synthetic_data.generate_ssn(count=100)
        negative_samples = synthetic_data.generate_negative_samples(count=100)

        true_positives = 0
        false_negatives = 0
        true_negatives = 0
        false_positives = 0

        # Test positive samples
        for ssn in positive_samples:
            event = {'content': f"SSN: {ssn['number']}", 'action': 'test'}
            matches = policy_engine.evaluate(event)

            detected = any('ssn' in str(m.policy.name).lower() for m in matches)

            if detected:
                true_positives += 1
            else:
                false_negatives += 1

        # Test negative samples
        for neg in negative_samples:
            event = {'content': neg['data'], 'action': 'test'}
            matches = policy_engine.evaluate(event)

            detected = any('ssn' in str(m.policy.name).lower() for m in matches)

            if not detected:
                true_negatives += 1
            else:
                false_positives += 1

        metrics = benchmark.calculate_accuracy_metrics(
            true_positives, false_positives, true_negatives, false_negatives
        )

        print(f"\n=== SSN Detection Accuracy ===")
        print(f"Accuracy:  {metrics['accuracy']*100:.2f}%")
        print(f"Precision: {metrics['precision']*100:.2f}%")
        print(f"Recall:    {metrics['recall']*100:.2f}%")
        print(f"F1 Score:  {metrics['f1_score']:.4f}")

        assert metrics['accuracy'] > 0.95, f"SSN accuracy {metrics['accuracy']*100:.2f}% below 95% target"

    def test_memory_usage(self, benchmark, synthetic_data, policy_engine):
        """
        Test: Measure memory usage during processing
        Target: < 500MB for 1000 events
        """
        import psutil
        import os

        process = psutil.Process(os.getpid())

        # Baseline memory
        baseline_memory = process.memory_info().rss / 1024 / 1024  # MB

        # Process 1000 documents
        documents = synthetic_data.generate_test_documents(count=1000)

        for doc in documents:
            event = {'content': doc['content'], 'action': 'file_scan'}
            policy_engine.evaluate(event)

        # Peak memory
        peak_memory = process.memory_info().rss / 1024 / 1024  # MB
        memory_increase = peak_memory - baseline_memory

        print(f"\n=== Memory Usage ===")
        print(f"Baseline: {baseline_memory:.2f} MB")
        print(f"Peak:     {peak_memory:.2f} MB")
        print(f"Increase: {memory_increase:.2f} MB")

        # Memory assertion
        assert memory_increase < 500, f"Memory increase {memory_increase:.2f}MB exceeds 500MB target"

    def test_scalability_large_dataset(self, benchmark, synthetic_data, policy_engine):
        """
        Test: Measure scalability with large dataset
        Target: Linear scaling up to 10,000 events
        """
        sizes = [100, 500, 1000, 5000]
        results = []

        for size in sizes:
            documents = synthetic_data.generate_test_documents(count=size)

            start_time = time.perf_counter()

            for doc in documents:
                event = {'content': doc['content'], 'action': 'file_scan'}
                policy_engine.evaluate(event)

            end_time = time.perf_counter()
            elapsed = end_time - start_time

            throughput = size / elapsed
            results.append({
                'size': size,
                'time': elapsed,
                'throughput': throughput
            })

        print(f"\n=== Scalability Test ===")
        for result in results:
            print(f"Size: {result['size']:5d} | Time: {result['time']:6.2f}s | Throughput: {result['throughput']:7.2f} events/s")

        # Check that throughput doesn't degrade significantly
        throughputs = [r['throughput'] for r in results]
        min_throughput = min(throughputs)
        max_throughput = max(throughputs)

        degradation = (max_throughput - min_throughput) / max_throughput
        assert degradation < 0.5, f"Throughput degraded by {degradation*100:.1f}% (should be < 50%)"

    def test_false_positive_rate_comprehensive(self, benchmark, synthetic_data, policy_engine):
        """
        Test: Comprehensive false positive rate across all PII types
        Target: < 2% overall false positive rate
        """
        # Generate 500 negative samples (no PII)
        negative_samples = synthetic_data.generate_negative_samples(count=500)

        false_positives = 0

        for sample in negative_samples:
            event = {'content': sample['data'], 'action': 'test'}
            matches = policy_engine.evaluate(event)

            # Any detection is a false positive
            if len(matches) > 0:
                false_positives += 1

        false_positive_rate = false_positives / len(negative_samples)

        print(f"\n=== False Positive Rate ===")
        print(f"Total negative samples: {len(negative_samples)}")
        print(f"False positives: {false_positives}")
        print(f"False positive rate: {false_positive_rate*100:.2f}%")

        assert false_positive_rate < 0.02, f"False positive rate {false_positive_rate*100:.2f}% exceeds 2% target"

    def test_generate_performance_report(self, benchmark, synthetic_data, policy_engine):
        """Generate comprehensive performance report"""
        report = {
            'timestamp': time.strftime('%Y-%m-%d %H:%M:%S'),
            'system': {
                'platform': 'unknown',  # Would use platform.system()
                'python_version': 'unknown'  # Would use sys.version
            },
            'tests': []
        }

        # Run quick performance tests
        docs = synthetic_data.generate_test_documents(count=100)
        latencies = []

        for doc in docs:
            event = {'content': doc['content'], 'action': 'test'}
            _, elapsed = benchmark.measure_execution_time(policy_engine.evaluate, event)
            latencies.append(elapsed)

        stats = benchmark.calculate_statistics(latencies)

        report['tests'].append({
            'name': 'Latency Test',
            'metrics': stats,
            'target_met': stats['p95'] < 100
        })

        # Save report
        report_path = 'tests/performance/performance_report.json'
        with open(report_path, 'w') as f:
            json.dump(report, f, indent=2)

        print(f"\n=== Performance Report Generated ===")
        print(f"Report saved to: {report_path}")
        print(json.dumps(report, indent=2))


@pytest.mark.benchmark
class TestMLModelPerformance:
    """Test ML model inference performance"""

    def test_classifier_inference_speed(self):
        """Test ML classifier inference speed"""
        # Would test actual ML model if available
        pass

    def test_batch_classification_performance(self):
        """Test batch classification throughput"""
        pass


if __name__ == "__main__":
    # Run performance tests
    pytest.main([__file__, "-v", "-m", "not benchmark", "--tb=short"])
