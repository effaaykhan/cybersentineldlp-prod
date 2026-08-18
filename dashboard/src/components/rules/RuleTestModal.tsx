import { useState } from 'react'
import { extractErrorDetail } from '@/utils/errorUtils'
import { useMutation } from '@tanstack/react-query'
import { X, TestTube, AlertTriangle, CheckCircle } from 'lucide-react'
import { testRules, type RuleTestResponse } from '@/lib/rules-api'
import { cn } from '@/lib/utils'
import toast from 'react-hot-toast'
import Modal, { ModalFooter } from '@/components/ui/Modal'

interface RuleTestModalProps {
  isOpen: boolean
  onClose: () => void
}

export default function RuleTestModal({ isOpen, onClose }: RuleTestModalProps) {
  const [content, setContent] = useState('')
  const [result, setResult] = useState<RuleTestResponse | null>(null)

  const testMutation = useMutation({
    mutationFn: testRules,
    onSuccess: (data) => {
      setResult(data)
    },
    onError: (error: any) => {
      toast.error(extractErrorDetail(error, 'Failed to test rules'))
    },
  })

  const handleTest = () => {
    if (!content.trim()) {
      toast.error('Please enter some content to test')
      return
    }
    testMutation.mutate({ content })
  }

  const handleReset = () => {
    setContent('')
    setResult(null)
  }

  const getClassificationColor = (classification: string) => {
    switch (classification) {
      case 'Restricted':
        return 'text-cs-crit bg-cs-crit/10 border-cs-crit/30'
      case 'Confidential':
        return 'text-cs-high bg-cs-high/10 border-cs-high/30'
      case 'Internal':
        return 'text-cs-med bg-cs-med/12 border-cs-med/35'
      case 'Public':
        return 'text-cs-ok bg-cs-ok/12 border-cs-ok/30'
      default:
        return 'text-cs-ink-2 bg-cs-hair-2 border-cs-hair'
    }
  }

  const getConfidenceColor = (score: number) => {
    if (score >= 0.8) return 'text-cs-crit'
    if (score >= 0.6) return 'text-cs-high'
    if (score >= 0.3) return 'text-cs-med'
    return 'text-cs-ok'
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      size="2xl"
      initialFocus="#test-content"
      header={
        <div className="flex items-center gap-3">
          <div className="rounded-cs-sm bg-cs-indigo-faint p-2">
            <TestTube className="h-5 w-5 text-cs-indigo" />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-[19px] font-semibold tracking-[-0.01em] text-cs-ink">
              Test a rule
            </h3>
            <p className="mt-0.5 text-[12.5px] text-cs-muted">
              Paste content and see what your classification rules make of it.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto shrink-0 rounded-cs-sm p-1.5 text-cs-muted transition-colors hover:bg-cs-panel-2 hover:text-cs-ink
                       focus:outline-none focus-visible:ring-[3px] focus-visible:ring-cs-indigo-faint"
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>
      }
      footer={
        <ModalFooter>
          <button onClick={onClose} className="btn btn-secondary">Close</button>
        </ModalFooter>
      }
      bodyClassName="px-6 py-5 space-y-6"
    >
          {/* Input */}
          <div>
            <label className="block text-sm font-medium text-cs-ink-2 mb-2">
              Test Content
            </label>
            <textarea
              id="test-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="input w-full font-mono text-sm"
              rows={8}
              placeholder="Paste content here to test against classification rules...&#10;&#10;Example:&#10;My SSN is 123-45-6789&#10;Credit Card: 4111-1111-1111-1111&#10;Email: john@example.com"
            />
            <p className="text-xs text-cs-muted-2 mt-2">
              Enter any text content to see which rules it matches and how it would be classified.
            </p>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleTest}
              disabled={testMutation.isPending || !content.trim()}
              className="btn-primary flex items-center gap-2"
            >
              <TestTube className="h-4 w-4" />
              {testMutation.isPending ? 'Testing...' : 'Test Content'}
            </button>
            <button onClick={handleReset} className="btn-secondary">
              Reset
            </button>
          </div>

          {/* Results */}
          {result && (
            <div className="space-y-6 pt-6 border-t border-cs-hair">
              <div>
                <h4 className="text-lg font-semibold text-cs-ink mb-4">Test Results</h4>

                {/* Classification Overview */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                  <div className="card">
                    <div className="text-sm text-cs-muted-2 mb-1">Classification</div>
                    <div
                      className={cn(
                        'inline-flex items-center px-3 py-1.5 rounded-cs-sm border font-semibold text-base',
                        getClassificationColor(result.classification)
                      )}
                    >
                      {result.classification}
                    </div>
                  </div>

                  <div className="card">
                    <div className="text-sm text-cs-muted-2 mb-1">Confidence Score</div>
                    <div
                      className={cn(
                        'text-3xl font-bold',
                        getConfidenceColor(result.confidence_score)
                      )}
                    >
                      {(result.confidence_score * 100).toFixed(1)}%
                    </div>
                  </div>

                  <div className="card">
                    <div className="text-sm text-cs-muted-2 mb-1">Matched Rules</div>
                    <div className="text-3xl font-bold text-cs-indigo">
                      {result.matched_rules.length}
                    </div>
                    <div className="text-xs text-cs-muted-2 mt-1">
                      {result.total_matches} total matches
                    </div>
                  </div>
                </div>

                {/* Matched Rules */}
                {result.matched_rules.length > 0 ? (
                  <div>
                    <h5 className="text-sm font-semibold text-cs-ink mb-3">
                      Matched Rules ({result.matched_rules.length})
                    </h5>
                    <div className="space-y-3">
                      {result.matched_rules.map((match, index) => (
                        <div
                          key={index}
                          className="bg-cs-indigo-faint border border-cs-indigo/30 rounded-cs-sm p-4"
                        >
                          <div className="flex items-start justify-between mb-2">
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <CheckCircle className="h-4 w-4 text-cs-indigo" />
                                <span className="font-semibold text-cs-ink">
                                  {match.rule_name}
                                </span>
                                <span className="text-xs px-2 py-0.5 rounded-full bg-cs-indigo-faint text-cs-indigo">
                                  {match.rule_type}
                                </span>
                              </div>
                              {match.category && (
                                <div className="text-sm text-cs-muted-2 mb-1">
                                  Category: {match.category}
                                </div>
                              )}
                            </div>
                            <div className="text-right">
                              {match.severity && (
                                <div
                                  className={cn(
                                    'inline-flex items-center px-2 py-1 rounded-full text-xs font-medium mb-1',
                                    match.severity === 'critical'
                                      ? 'bg-cs-crit/10 text-cs-crit'
                                      : match.severity === 'high'
                                      ? 'bg-cs-high/10 text-cs-high'
                                      : match.severity === 'medium'
                                      ? 'bg-cs-med/12 text-cs-med'
                                      : 'bg-cs-ok/12 text-cs-ok'
                                  )}
                                >
                                  {match.severity}
                                </div>
                              )}
                              <div className="text-xs text-cs-muted-2">
                                Weight: {match.weight.toFixed(2)}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-4 text-sm">
                            <div className="text-cs-muted-2">
                              Matches: <span className="font-medium">{match.match_count}</span>
                            </div>
                            {match.classification_labels &&
                              match.classification_labels.length > 0 && (
                                <div className="flex items-center gap-1">
                                  <span className="text-cs-muted-2">Labels:</span>
                                  {match.classification_labels.map((label) => (
                                    <span
                                      key={label}
                                      className="px-2 py-0.5 bg-cs-indigo-faint text-cs-indigo rounded text-xs"
                                    >
                                      {label}
                                    </span>
                                  ))}
                                </div>
                              )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="bg-cs-panel-2 border border-cs-hair rounded-cs-sm p-8 text-center">
                    <AlertTriangle className="h-12 w-12 text-cs-muted mx-auto mb-3" />
                    <p className="text-cs-muted-2 font-medium">No rules matched</p>
                    <p className="text-sm text-cs-muted-2 mt-1">
                      The content did not trigger any classification rules
                    </p>
                  </div>
                )}

                {/* Details */}
                <div className="mt-6 p-4 bg-cs-panel-2 rounded-cs-sm border border-cs-hair">
                  <h5 className="text-sm font-semibold text-cs-ink mb-2">Details</h5>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-cs-muted-2">Content Length:</span>{' '}
                      <span className="font-medium">
                        {result.details.content_length} characters
                      </span>
                    </div>
                    <div>
                      <span className="text-cs-muted-2">Rules Evaluated:</span>{' '}
                      <span className="font-medium">{result.details.rules_evaluated}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
    </Modal>
  )
}
