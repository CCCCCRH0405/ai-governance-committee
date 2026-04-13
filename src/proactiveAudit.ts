// src/main/evolution/proactiveAudit.ts
// Chain 4: Proactive Self-Audit — detect quality decline without crashes.
//
// Two responsibilities:
//   A. Agent quality trends: score decline / negative signal rate → improvement proposals
//   B. Pipeline health: is discovery/intelligence/repair running? Output quality ok?

import { getAgentScores, getRecentConversationSignals } from '../quality/db'
import { getAgentStatus } from '../maintenance/db'
import { createProposal, countTodayProposals, getActivityLogSince } from './db'
import { isOverBudget } from '../tokenBudget'
import { logActivity } from './activityLog'
import { log } from '../logger'
import type { AIUsage, ProviderId } from '../../shared/types'

type UtilityCallResult = {
  text: string
  provider: ProviderId
  model: string
  usage?: AIUsage
}

const DECLINE_THRESHOLD = -5
const MIN_DATA_POINTS = 5
const MAX_DIAGNOSES_PER_RUN = 3
const MONITORED_AGENTS = [
  'morning_briefing',
  'memory_custodian',
  'token_audit',
  'compliance_sentinel',
  'flight_sentinel',
  'custom_watcher',
  'prompt_evolution'
]

// ─── Trend Analysis ────────────────────────────────────────────────────────

interface AgentTrend {
  agent: string
  dataPoints: number
  recentAvg: number
  previousAvg: number
  delta: number
  declining: boolean
  negativeSignalRate: number
}

function analyzeAgentTrend(agent: string): AgentTrend {
  const scores = getAgentScores(agent, 30)
  const dataPoints = scores.length

  if (dataPoints < MIN_DATA_POINTS) {
    return {
      agent,
      dataPoints,
      recentAvg: 0,
      previousAvg: 0,
      delta: 0,
      declining: false,
      negativeSignalRate: 0
    }
  }

  // Recent 5 vs previous 10
  const recent = scores.slice(0, 5).map((s) => s.score)
  const previous = scores.slice(5, 15).map((s) => s.score)

  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length
  const previousAvg =
    previous.length > 0 ? previous.reduce((a, b) => a + b, 0) / previous.length : recentAvg
  const delta = recentAvg - previousAvg

  return {
    agent,
    dataPoints,
    recentAvg,
    previousAvg,
    delta,
    declining: delta < DECLINE_THRESHOLD,
    negativeSignalRate: 0 // filled below
  }
}

function analyzeSignalsByAgent(): Record<
  string,
  { total: number; negative: number; rate: number }
> {
  const signals = getRecentConversationSignals(100)
  const agentSignals: Record<string, { total: number; negative: number }> = {}

  for (const s of signals) {
    const agent = s.related_agent
    if (!agent) continue
    if (!agentSignals[agent]) agentSignals[agent] = { total: 0, negative: 0 }
    agentSignals[agent].total++
    if (s.signal_type === 'negative') agentSignals[agent].negative++
  }

  const result: Record<string, { total: number; negative: number; rate: number }> = {}
  for (const [agent, counts] of Object.entries(agentSignals)) {
    result[agent] = {
      ...counts,
      rate: counts.total > 0 ? counts.negative / counts.total : 0
    }
  }
  return result
}

// ─── Pipeline Health ───────────────────────────────────────────────────

interface PipelineIssue {
  pipeline: string
  problem: string
  severity: 'warning' | 'error'
}

/**
 * Check if key pipelines are running and producing output.
 * Zero cost — reads agent_status + activity_log (DB only).
 */
function checkPipelineHealth(): PipelineIssue[] {
  const issues: PipelineIssue[] = []
  const now = Date.now()

  // Pipelines to monitor: agent_name → expected max interval (hours)
  const pipelines: Array<{ agent: string; label: string; maxHours: number }> = [
    { agent: 'evolution_thinker', label: 'Discovery', maxHours: 8 },
    { agent: 'morning_briefing', label: 'Morning Brief', maxHours: 28 },
    { agent: 'self_repair', label: 'Self-Repair', maxHours: 28 },
    { agent: 'memory_custodian', label: 'Memory Custodian', maxHours: 28 }
  ]

  for (const p of pipelines) {
    const status = getAgentStatus(p.agent)
    if (!status) continue

    // Check: is agent enabled but hasn't run?
    if (status.enabled && !status.last_run_at) {
      issues.push({
        pipeline: p.label,
        problem: `${p.agent} is enabled but has never run`,
        severity: 'warning'
      })
      continue
    }

    // Check: hasn't run within expected interval
    if (status.last_run_at) {
      const lastRun = new Date(status.last_run_at).getTime()
      const hoursSince = (now - lastRun) / (60 * 60 * 1000)
      if (hoursSince > p.maxHours) {
        issues.push({
          pipeline: p.label,
          problem: `${p.agent}   ${hoursSince.toFixed(0)}h since last run (expected within  ${p.maxHours}h)`,
          severity: hoursSince > p.maxHours * 2 ? 'error' : 'warning'
        })
      }
    }

    // Check: last run failed
    if (status.last_status === 'error' || status.last_status === 'failed') {
      issues.push({
        pipeline: p.label,
        problem: `${p.agent} last run failed: ${status.last_error?.slice(0, 100) ?? 'unknown'}`,
        severity: 'error'
      })
    }
  }

  // Check discovery output quality: too many discoveries dismissed by user → quality issue
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()
  const discoveryLogs = getActivityLogSince(weekAgo, 200).filter(
    (l) => l.chain === 'discovery' && l.event_type === 'discovery'
  )
  const successDiscoveries = discoveryLogs.filter((l) => l.outcome === 'success').length
  const skippedDiscoveries = discoveryLogs.filter((l) => l.outcome === 'skipped').length
  if (successDiscoveries + skippedDiscoveries > 3 && successDiscoveries === 0) {
    issues.push({
      pipeline: 'Discovery',
      problem: `${skippedDiscoveries} searches this week returned no useful results, interest vector may need updating`,
      severity: 'warning'
    })
  }

  return issues
}

// ─── Main Loop ─────────────────────────────────────────────────────────────

export async function runProactiveAuditLoop(
  caller?: (prompt: string) => Promise<UtilityCallResult>
): Promise<{
  agents_checked: number
  declining_agents: string[]
  pipeline_issues: number
  proposals_created: number
  skipped: string | null
}> {
  const result = {
    agents_checked: 0,
    declining_agents: [] as string[],
    pipeline_issues: 0,
    proposals_created: 0,
    skipped: null as string | null
  }

  if (isOverBudget('primary')) {
    result.skipped = 'primary_over_budget'
    return result
  }

  const todayProposals = countTodayProposals()
  if (todayProposals >= MAX_DIAGNOSES_PER_RUN) {
    result.skipped = 'daily_proposal_limit'
    return result
  }

  const signalsByAgent = analyzeSignalsByAgent()
  const decliningAgents: AgentTrend[] = []

  for (const agent of MONITORED_AGENTS) {
    const trend = analyzeAgentTrend(agent)
    result.agents_checked++

    // Enrich with signal data
    const signalData = signalsByAgent[agent]
    if (signalData) {
      trend.negativeSignalRate = signalData.rate
    }

    // Flag as declining if score drops OR high negative signal rate
    if (trend.declining || (signalData && signalData.rate > 0.3 && signalData.total >= 5)) {
      decliningAgents.push(trend)
      result.declining_agents.push(agent)
    }

    logActivity({
      event_type: 'proactive_audit',
      chain: 'chain4',
      summary: `${agent}: delta=${trend.delta.toFixed(1)}, signals=${trend.negativeSignalRate.toFixed(2)}, ${trend.declining ? 'declining' : 'stable'}`,
      detail: {
        dataPoints: trend.dataPoints,
        recentAvg: trend.recentAvg,
        previousAvg: trend.previousAvg,
        delta: trend.delta,
        negativeSignalRate: trend.negativeSignalRate
      },
      agent,
      outcome: trend.declining ? 'failed' : 'success'
    })
  }

  // ── Pipeline health checks (zero cost) ───────────────────────────────
  const pipelineIssues = checkPipelineHealth()
  result.pipeline_issues = pipelineIssues.length
  for (const issue of pipelineIssues) {
    logActivity({
      event_type: 'proactive_audit',
      chain: 'chain4',
      summary: `Pipeline ${issue.pipeline}: ${issue.problem}`,
      detail: { pipeline: issue.pipeline, problem: issue.problem, severity: issue.severity },
      outcome: issue.severity === 'error' ? 'failed' : 'pending'
    })

    // Create repair proposal for error-level issues
    if (
      issue.severity === 'error' &&
      todayProposals + result.proposals_created < MAX_DIAGNOSES_PER_RUN
    ) {
      const proposalId = `pipeline_${issue.pipeline.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`
      createProposal({
        id: proposalId,
        type: 'repair',
        title: `[Pipeline anomaly] ${issue.pipeline}: ${issue.problem.slice(0, 60)}`,
        description: issue.problem,
        status: 'pending'
      })
      result.proposals_created++
    }
  }

  if (decliningAgents.length === 0 && pipelineIssues.length === 0) {
    log.info('[ProactiveAudit] All agents stable, all pipelines healthy')
    return result
  }

  if (decliningAgents.length === 0) {
    log.info(`[ProactiveAudit] Agents stable, ${pipelineIssues.length} pipeline issue(s)`)
    return result
  }

  // Generate improvement proposals for declining agents
  const remainingSlots = MAX_DIAGNOSES_PER_RUN - todayProposals
  for (const trend of decliningAgents.slice(0, remainingSlots)) {
    try {
      let diagnosis: string

      if (caller) {
        const diagPrompt = `You are an agent quality auditor. The following agent has been declining in quality. Diagnose the cause and suggest a specific fix.

Agent: ${trend.agent}
Score trend: recent 5 avg=${trend.recentAvg.toFixed(1)}, previous 10 avg=${trend.previousAvg.toFixed(1)}, delta=${trend.delta.toFixed(1)}
User negative signal rate: ${(trend.negativeSignalRate * 100).toFixed(0)}%

Strictly output JSON:
{
  "diagnosis": "root cause (under 80 chars)",
  "suggestion": "specific actionable fix (under 80 chars)",
  "target": "file or prompt path to modify"
}`
        const aiResult = await caller(diagPrompt)
        diagnosis = aiResult.text
      } else {
        diagnosis = `${trend.agent} score declining (delta=${trend.delta.toFixed(1)}), negative signal rate ${(trend.negativeSignalRate * 100).toFixed(0)}%`
      }

      const proposalId = `audit_${trend.agent}_${Date.now()}`
      createProposal({
        id: proposalId,
        type: 'repair',
        title: `[Self-audit] ${trend.agent} quality declining, needs improvement`,
        description: diagnosis,
        status: 'pending'
      })

      logActivity({
        event_type: 'proactive_audit',
        chain: 'chain4',
        summary: `For  ${trend.agent} generated improvement proposal: ${proposalId}`,
        detail: { trend, diagnosis: diagnosis.slice(0, 200) },
        proposal_id: proposalId,
        agent: trend.agent,
        outcome: 'success'
      })

      result.proposals_created++
    } catch (err) {
      log.warn(`[ProactiveAudit] Failed to diagnose ${trend.agent}:`, err)
    }
  }

  return result
}
