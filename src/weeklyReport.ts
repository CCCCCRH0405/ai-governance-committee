// src/main/evolution/weeklyReport.ts
// Weekly audit report generator — produces structured JSON for Sunday review.
//
// Covers all evolution chains:
//   - Proposals created / reviewed / approved / rejected / auto-executed
//   - L2 repairs attempted + outcomes
//   - Prompt modifications + effects
//   - Quality trends across agents
//   - Anomalies and concerns

import {
  getActivityLogSince,
  getWeekActivitySummary,
  getRecentProposals,
  type ActivityLogRow
} from './db'
import { getAgentScores } from '../quality/db'

// ─── Types ─────────────────────────────────────────────────────────────────

export interface WeeklyEvolutionReport {
  period: { start: string; end: string }
  summary: {
    total_activities: number
    by_chain: Record<string, number>
    by_outcome: Record<string, number>
  }
  proposals: {
    created: number
    reviewed: number
    approved: number
    rejected: number
    auto_executed: number
    details: Array<{
      id: string
      title: string
      type: string
      status: string
      risk_level: string | null
      created_at: string
    }>
  }
  repairs: {
    l1_resolved: number
    l2_attempted: number
    l2_succeeded: number
    l2_failed: number
    details: Array<{
      proposal_id: string | null
      agent: string | null
      outcome: string
      summary: string
    }>
  }
  prompt_modifications: {
    applied: number
    rolled_back: number
    details: Array<{
      target: string
      outcome: string
      summary: string
    }>
  }
  quality_trends: {
    improving_agents: string[]
    declining_agents: string[]
    stable_agents: string[]
  }
  anomalies: string[]
  activity_log: ActivityLogRow[]
}

// ─── Generator ─────────────────────────────────────────────────────────────

const MONITORED_AGENTS = [
  'morning_briefing',
  'memory_custodian',
  'token_audit',
  'compliance_sentinel',
  'flight_sentinel',
  'custom_watcher',
  'prompt_evolution',
  'evolution_thinker',
  'self_repair'
]

export function generateWeeklyReport(weekStart?: Date): WeeklyEvolutionReport {
  const start = weekStart ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const startIso = start.toISOString()
  const endIso = new Date().toISOString()

  // Activity summary
  const summary = getWeekActivitySummary(startIso)

  // Full activity log
  const activityLog = getActivityLogSince(startIso, 500)

  // Proposals this week
  const allProposals = getRecentProposals(100).filter((p) => p.created_at >= startIso)
  const proposalDetails = allProposals.map((p) => ({
    id: p.id,
    title: p.title,
    type: p.type,
    status: p.status,
    risk_level: p.fix_risk_level,
    created_at: p.created_at
  }))

  // Repairs
  const repairLogs = activityLog.filter(
    (l) => l.event_type === 'repair_l1' || l.event_type === 'repair_l2'
  )
  const l1Logs = repairLogs.filter((l) => l.event_type === 'repair_l1')
  const l2Logs = repairLogs.filter((l) => l.event_type === 'repair_l2')

  // Prompt modifications
  const promptLogs = activityLog.filter(
    (l) => l.chain === 'chain1' && l.event_type === 'prompt_apply'
  )

  // Quality trends
  const improving: string[] = []
  const declining: string[] = []
  const stable: string[] = []

  for (const agent of MONITORED_AGENTS) {
    const scores = getAgentScores(agent, 15)
    if (scores.length < 5) {
      stable.push(agent)
      continue
    }
    const recent = scores.slice(0, 5).map((s) => s.score)
    const previous = scores.slice(5, 10).map((s) => s.score)
    if (previous.length === 0) {
      stable.push(agent)
      continue
    }
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length
    const previousAvg = previous.reduce((a, b) => a + b, 0) / previous.length
    const delta = recentAvg - previousAvg

    if (delta > 5) improving.push(agent)
    else if (delta < -5) declining.push(agent)
    else stable.push(agent)
  }

  // Anomalies
  const anomalies: string[] = []

  // Anomaly: repeated repair failures
  const failedRepairs = l2Logs.filter((l) => l.outcome === 'failed' || l.outcome === 'rollback')
  const agentFailCounts: Record<string, number> = {}
  for (const l of failedRepairs) {
    const a = l.agent ?? 'unknown'
    agentFailCounts[a] = (agentFailCounts[a] ?? 0) + 1
  }
  for (const [agent, count] of Object.entries(agentFailCounts)) {
    if (count >= 3) {
      anomalies.push(`${agent} repair failures this week ${count}  — may need human intervention`)
    }
  }

  // Anomaly: prompt rollback
  const promptRollbacks = promptLogs.filter((l) => l.outcome === 'rollback')
  if (promptRollbacks.length > 0) {
    anomalies.push(`This week had  ${promptRollbacks.length}  prompt modifications rolled back`)
  }

  // Anomaly: declining agents
  if (declining.length > 0) {
    anomalies.push(`Agents with quality decline: ${declining.join(', ')}`)
  }

  // Anomaly: quality check degradation
  const qualityDegradations = activityLog.filter(
    (l) => l.event_type === 'quality_check' && l.outcome === 'failed'
  )
  if (qualityDegradations.length > 0) {
    anomalies.push(`${qualityDegradations.length} repairs resulted in quality degradation`)
  }

  return {
    period: { start: startIso, end: endIso },
    summary: {
      total_activities: summary.total,
      by_chain: summary.byChain,
      by_outcome: summary.byOutcome
    },
    proposals: {
      created: allProposals.length,
      reviewed: allProposals.filter((p) =>
        ['approved', 'rejected', 'needs_human'].includes(p.status)
      ).length,
      approved: allProposals.filter((p) => p.status === 'approved').length,
      rejected: allProposals.filter((p) => p.status === 'rejected').length,
      auto_executed: allProposals.filter((p) => p.status === 'applied' && !p.user_decision).length,
      details: proposalDetails
    },
    repairs: {
      l1_resolved: l1Logs.filter((l) => l.outcome === 'success').length,
      l2_attempted: l2Logs.length,
      l2_succeeded: l2Logs.filter((l) => l.outcome === 'success').length,
      l2_failed: l2Logs.filter((l) => l.outcome === 'failed' || l.outcome === 'rollback').length,
      details: repairLogs.map((l) => ({
        proposal_id: l.proposal_id,
        agent: l.agent,
        outcome: l.outcome,
        summary: l.summary
      }))
    },
    prompt_modifications: {
      applied: promptLogs.filter((l) => l.outcome === 'success').length,
      rolled_back: promptRollbacks.length,
      details: promptLogs.map((l) => {
        let target = ''
        try {
          target = (JSON.parse(l.detail ?? '{}') as Record<string, unknown>).target as string
        } catch {
          /* */
        }
        return { target: target || 'unknown', outcome: l.outcome, summary: l.summary }
      })
    },
    quality_trends: {
      improving_agents: improving,
      declining_agents: declining,
      stable_agents: stable
    },
    anomalies,
    activity_log: activityLog
  }
}
