import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, AlertTriangle, ShieldAlert, Search } from 'lucide-react'
import LoadingSpinner from '@/components/LoadingSpinner'
import ErrorMessage from '@/components/ErrorMessage'
import AlertDetailsModal from '@/components/alerts/AlertDetailsModal'
import Pagination from '@/components/ui/Pagination'
import { getAlerts } from '@/lib/api'
import { formatRelativeTime, getSeverityColor, cn } from '@/lib/utils'

type FilterType = 'all' | 'high' | 'critical'

export default function Alerts() {
  const [selectedAlert, setSelectedAlert] = useState<any>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [filter, setFilter] = useState<FilterType>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  const { data: alertsData, isLoading, error, refetch } = useQuery({
    queryKey: ['alerts'],
    // Pull a generous window so the client-side severity filter + search still
    // operate across the whole set; the list itself is paginated client-side.
    queryFn: () => getAlerts({ limit: 500 }),
    refetchInterval: 10000,
  })

  // Changing the severity filter or search returns to the first page.
  useEffect(() => {
    setPage(1)
  }, [filter, searchQuery])

  const handleAlertClick = (alert: any) => {
    setSelectedAlert(alert)
    setIsModalOpen(true)
  }

  if (isLoading) {
    return <LoadingSpinner size="lg" />
  }

  if (error) {
    return <ErrorMessage message="Failed to load alerts" retry={() => refetch()} />
  }

  // Handle both old format (array) and new format (object with alerts and counts)
  let alerts: any[] = []
  let counts: Record<string, number> = {}
  
  if (!alertsData) {
    // No data - use empty arrays
    alerts = []
  } else if (Array.isArray(alertsData)) {
    // Old format: direct array
    alerts = alertsData
  } else if (typeof alertsData === 'object' && alertsData !== null) {
    // New format: object with alerts and counts
    if ('alerts' in alertsData && Array.isArray(alertsData.alerts)) {
      alerts = alertsData.alerts
    }
    if ('counts' in alertsData && typeof alertsData.counts === 'object' && alertsData.counts !== null) {
      counts = alertsData.counts
    }
  }
  
  // Ensure alerts is always an array
  if (!Array.isArray(alerts)) {
    alerts = []
  }
  
  // Calculate alert counts by type
  const totalAlertsCount = typeof counts.total === 'number' ? counts.total : alerts.length
  const highAlertsCount = alerts.filter((a) => a && a.severity === 'high').length
  const criticalAlertsCount = alerts.filter((a) => a && a.severity === 'critical').length

  // Filter and search alerts
  const filteredAlerts = alerts.filter((alert) => {
    // Drop anything falsy before touching it. The counts above already guard
    // this way; this filter did not, and with the default "all" filter and an
    // empty search box BOTH conditions below short-circuit without reading
    // `alert` — so a null would sail through to the render and blow up on
    // `key={alert.id}`.
    if (!alert) return false

    // Apply severity filter
    if (filter === 'high' && alert.severity !== 'high') return false
    if (filter === 'critical' && alert.severity !== 'critical') return false

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      return (
        alert.title?.toLowerCase().includes(query) ||
        alert.description?.toLowerCase().includes(query) ||
        alert.agent_id?.toLowerCase().includes(query) ||
        alert.event_id?.toLowerCase().includes(query) ||
        alert.severity?.toLowerCase().includes(query)
      )
    }

    return true
  })

  const pagedAlerts = filteredAlerts.slice((page - 1) * pageSize, page * pageSize)

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <p className="eyebrow mb-1.5">Security</p>
        <h1 className="text-2xl font-bold tracking-tight text-cs-ink">Alerts</h1>
        <p className="mt-1 text-sm text-cs-ink-2">
          Manage security alerts from DLP policies
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div
          className={`card-modern cursor-pointer ${filter === 'all' ? 'ring-2 ring-primary-500' : ''}`}
          onClick={() => setFilter('all')}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary-50 rounded-cs-sm">
              <ShieldAlert className="h-5 w-5 text-primary-600" />
            </div>
            <div>
              <p className="text-sm text-cs-ink-2">Total Alerts</p>
              <p className="font-mono text-2xl font-semibold tabular-nums text-primary-600">{totalAlertsCount}</p>
            </div>
          </div>
        </div>

        <div
          className={`card-modern cursor-pointer ${filter === 'high' ? 'ring-2 ring-cs-high' : ''}`}
          onClick={() => setFilter('high')}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 bg-cs-high/[0.07] rounded-cs-sm">
              <AlertTriangle className="h-5 w-5 text-cs-high" />
            </div>
            <div>
              <p className="text-sm text-cs-ink-2">High Alerts</p>
              <p className="font-mono text-2xl font-semibold tabular-nums text-cs-high">
                {highAlertsCount}
              </p>
            </div>
          </div>
        </div>

        <div
          className={`card-modern cursor-pointer ${filter === 'critical' ? 'ring-2 ring-cs-crit' : ''}`}
          onClick={() => setFilter('critical')}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 bg-cs-crit/[0.07] rounded-cs-sm">
              <AlertCircle className="h-5 w-5 text-cs-crit" />
            </div>
            <div>
              <p className="text-sm text-cs-ink-2">Critical Alerts</p>
              <p className="font-mono text-2xl font-semibold tabular-nums text-cs-crit">
                {criticalAlertsCount}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Search Bar */}
      <div className="card">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-cs-muted" />
          <input
            type="text"
            placeholder="Search alerts by title, description, agent ID, severity..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="input pl-10"
          />
        </div>
      </div>

      {/* Alerts List */}
      <div className="card p-0">
        <div className="px-6 py-4 border-b border-cs-hair">
          <h3 className="section-title">
            {filter === 'all' ? 'All Alerts' : filter === 'high' ? 'High Severity Alerts' : 'Critical Severity Alerts'}
            {searchQuery && ` - Search: "${searchQuery}"`}
          </h3>
        </div>

        <div className="divide-y divide-cs-hair">
          {!filteredAlerts || filteredAlerts.length === 0 ? (
            <div className="p-12 text-center">
              <AlertCircle className="h-12 w-12 text-cs-muted mx-auto mb-3" />
              <p className="text-cs-ink-2 font-medium">
                {searchQuery ? 'No alerts found' : filter === 'all' ? 'No alerts' : `No ${filter} severity alerts`}
              </p>
              <p className="text-sm text-cs-muted mt-1">
                {searchQuery
                  ? 'Try adjusting your search query'
                  : filter === 'all'
                  ? 'Alerts will appear here when policies trigger'
                  : 'Click "Total Alerts" to see all alerts'
                }
              </p>
            </div>
          ) : (
            pagedAlerts.map((alert) => (
              <div
                key={alert.id}
                className="p-4 hover:bg-cs-panel-2 cursor-pointer transition-colors"
                onClick={() => handleAlertClick(alert)}
              >
                <div className="flex items-start gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={cn('badge', getSeverityColor(alert.severity))}
                      >
                        {alert.severity}
                      </span>
                      {alert.status === 'new' && (
                        <span className="badge badge-danger">New</span>
                      )}
                      {alert.status === 'acknowledged' && (
                        <span className="badge badge-warning">Acknowledged</span>
                      )}
                      {alert.status === 'resolved' && (
                        <span className="badge badge-success">Resolved</span>
                      )}
                    </div>

                    <h4 className="font-medium text-cs-ink">{alert.title}</h4>
                    <p className="mt-1 text-sm text-cs-ink-2">
                      {alert.description}
                    </p>

                    <div className="mt-2 flex items-center gap-3 text-xs text-cs-muted">
                      <span>Agent: <span className="num">{alert.agent_id}</span></span>
                      <span>•</span>
                      <span className="num">{formatRelativeTime(alert.created_at)}</span>
                      <span>•</span>
                      <code className="num bg-cs-hair-2 text-cs-ink-2 px-1 py-0.5 rounded">
                        {alert.event_id}
                      </code>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Pagination */}
        {filteredAlerts.length > 0 && (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={filteredAlerts.length}
            itemLabel="alerts"
            onPageChange={setPage}
            onPageSizeChange={(size) => { setPageSize(size); setPage(1) }}
          />
        )}
      </div>

      {/* Alert Details Modal */}
      <AlertDetailsModal
        alert={selectedAlert}
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false)
          setSelectedAlert(null)
        }}
      />
    </div>
  )
}
