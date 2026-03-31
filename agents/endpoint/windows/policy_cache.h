/**
 * Agent-Side Policy Cache (Windows)
 *
 * Hybrid enforcement model:
 * - IF policy cached locally → enforce instantly (<1ms)
 * - ELSE → ask backend decision API (~50-100ms)
 * - IF backend down → fail-open with cached policies + local logging
 */

#pragma once

#include <string>
#include <unordered_map>
#include <vector>
#include <mutex>
#include <chrono>
#include <fstream>
#include <functional>

struct CachedDecision {
    std::string action;      // block, allow, alert
    std::string reason;
    std::string policyId;
    std::string policyName;
    std::string severity;
    int ttlSeconds;
    std::chrono::steady_clock::time_point cachedAt;

    bool IsExpired() const {
        auto elapsed = std::chrono::steady_clock::now() - cachedAt;
        return std::chrono::duration_cast<std::chrono::seconds>(elapsed).count() > ttlSeconds;
    }
};

struct PolicyBundle {
    std::string version;
    std::string serializedPolicies; // JSON string
    std::chrono::steady_clock::time_point loadedAt;
};

class PolicyCache {
public:
    PolicyCache(const std::string& cacheDir = "C:\\ProgramData\\CyberSentinel\\cache",
                size_t maxDecisions = 10000)
        : m_cacheDir(cacheDir), m_maxDecisions(maxDecisions), m_backendAvailable(true) {}

    /**
     * Look up cached decision for an event.
     * Returns true if found (and fills outDecision), false if cache miss.
     */
    bool GetCachedDecision(const std::string& eventKey, CachedDecision& outDecision) {
        std::lock_guard<std::mutex> lock(m_mutex);
        auto it = m_decisions.find(eventKey);
        if (it != m_decisions.end() && !it->second.IsExpired()) {
            outDecision = it->second;
            return true;
        }
        if (it != m_decisions.end()) {
            m_decisions.erase(it); // Remove expired
        }
        return false;
    }

    /**
     * Cache a backend decision for future similar events.
     */
    void CacheDecision(const std::string& eventKey, const CachedDecision& decision) {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (m_decisions.size() >= m_maxDecisions) {
            EvictOldest(m_maxDecisions / 10);
        }
        m_decisions[eventKey] = decision;
    }

    /**
     * Compute a cache key from event attributes.
     * Same file + channel + event type = same key.
     */
    static std::string ComputeEventKey(const std::string& eventType,
                                        const std::string& channel,
                                        const std::string& fileHash,
                                        const std::string& fileName) {
        std::string combined = eventType + "|" + channel + "|" + fileHash + "|" + fileName;
        // Simple hash (production should use SHA-256)
        std::hash<std::string> hasher;
        return std::to_string(hasher(combined));
    }

    /**
     * Update local policy bundle from sync response.
     * Clears the decision cache since policies changed.
     */
    void UpdatePolicies(const std::string& version, const std::string& policiesJson) {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_policyBundle.version = version;
        m_policyBundle.serializedPolicies = policiesJson;
        m_policyBundle.loadedAt = std::chrono::steady_clock::now();
        m_decisions.clear(); // Invalidate cached decisions
        PersistPolicies();
    }

    std::string GetPolicyVersion() const { return m_policyBundle.version; }
    bool IsBackendAvailable() const { return m_backendAvailable; }
    void SetBackendAvailable(bool available) { m_backendAvailable = available; }

    /**
     * Offline decision: fail-open policy.
     * - Check cache first
     * - If no cache: ALLOW + log (never block everything when backend is down)
     */
    CachedDecision GetOfflineDecision(const std::string& eventKey) {
        CachedDecision cached;
        if (GetCachedDecision(eventKey, cached)) {
            return cached;
        }
        // Fail-open
        CachedDecision failOpen;
        failOpen.action = "allow";
        failOpen.reason = "Backend unavailable - fail-open policy applied";
        failOpen.ttlSeconds = 60;
        failOpen.cachedAt = std::chrono::steady_clock::now();
        return failOpen;
    }

    /**
     * Queue an event for later upload when backend becomes available.
     */
    void QueueOfflineEvent(const std::string& eventJson) {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (m_offlineQueue.size() < 50000) {
            m_offlineQueue.push_back(eventJson);
        }
    }

    /**
     * Drain a batch of queued events for upload.
     */
    std::vector<std::string> DrainOfflineQueue(size_t batchSize = 100) {
        std::lock_guard<std::mutex> lock(m_mutex);
        size_t count = (std::min)(batchSize, m_offlineQueue.size());
        std::vector<std::string> batch(m_offlineQueue.begin(), m_offlineQueue.begin() + count);
        m_offlineQueue.erase(m_offlineQueue.begin(), m_offlineQueue.begin() + count);
        return batch;
    }

    size_t GetOfflineQueueSize() const { return m_offlineQueue.size(); }
    size_t GetCachedDecisionCount() const { return m_decisions.size(); }

private:
    void EvictOldest(size_t count) {
        // Simple eviction: remove first N entries (unordered_map iteration order)
        auto it = m_decisions.begin();
        for (size_t i = 0; i < count && it != m_decisions.end(); i++) {
            it = m_decisions.erase(it);
        }
    }

    void PersistPolicies() {
        try {
            std::string path = m_cacheDir + "\\policy_bundle.json";
            std::ofstream file(path);
            if (file.is_open()) {
                file << m_policyBundle.serializedPolicies;
            }
        } catch (...) {
            // Non-fatal: persistence is best-effort
        }
    }

    std::string m_cacheDir;
    size_t m_maxDecisions;
    bool m_backendAvailable;
    std::mutex m_mutex;
    std::unordered_map<std::string, CachedDecision> m_decisions;
    PolicyBundle m_policyBundle;
    std::vector<std::string> m_offlineQueue;
};
