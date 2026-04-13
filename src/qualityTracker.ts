// src/main/evolution/qualityTracker.ts
// Chain 3: Pre/post fix quality snapshots + comparison + degradation detection.
//
// Flow:
//   1. Before L2 repair: takeQualitySnapshot(agent) → store pre_scores
//   2. 24h later: take new snapshot → compare → update execution_log
//   3. If degraded: flag for human review

import { getLatestAgentScoreByDimension } from '../quality/db'
import { updateExecutionScores, getExecutionsAwaitingPostCheck } from './db'
import { logActivity } from './activityLog'
import { log } from '../logger'

// ─── Types ─────────────────────────────────────────────────────────────────

export interface QualitySnapshot {
  agent: string
  timestamp: string
  scores: Record<string, number> // dimension → score
}

export interface QualityComparison {
  agent: string
  improved: string[]
  degraded: string[]
  unchanged: string[]
  net_delta: number
  verdict: 'improved' | 'degraded' | 'neutral'
}

// ─── Snapshot ──────────────────────────────────────────────────────────────

export function takeQualitySnapshot(agent: string): QualitySnapshot {
  const scores = getLatestAgentScoreByDimension(agent)
  return {
    agent,
    timestamp: new Date().toISOString(),
    scores
  }
}

// ─── Comparison ────────────────────────────────────────────────────────────

const DEGRADATION_THRESHOLD = -5

export function compareSnapshots(
  before: QualitySnapshot,
  after: QualitySnapshot
): QualityComparison {
  const improved: string[] = []
  const degraded: string[] = []
  const unchanged: string[] = []
  let netDelta = 0

  const allDimensions = new Set([...Object.keys(before.scores), ...Object.keys(after.scores)])

  for (const dim of allDimensions) {
    const pre = before.scores[dim] ?? 0
    const post = after.scores[dim] ?? 0
    const delta = post - pre
    netDelta += delta

    if (delta > 2) improved.push(dim)
    else if (delta < -2) degraded.push(dim)
    else unchanged.push(dim)
  }

  let verdict: QualityComparison['verdict'] = 'neutral'
  if (netDelta > 5) verdict = 'improved'
  else if (netDelta < DEGRADATION_THRESHOLD) verdict = 'degraded'

  return { agent: after.agent, improved, degraded, unchanged, net_delta: netDelta, verdict }
}

// ─── Post-Fix Check ───────────────────────────────────────────────────────

export function recordPreScores(proposalId: string, snapshot: QualitySnapshot): void {
  updateExecutionScores(proposalId, 'pre_scores', JSON.stringify(snapshot))
}

export function runPendingQualityChecks(): void {
  const pending = getExecutionsAwaitingPostCheck(24)
  if (pending.length === 0) return

  log.info(`[QualityTracker] Running ${pending.length} pending post-fix quality checks`)

  for (const exec of pending) {
    if (!exec.proposal_id || !exec.agent) continue

    let preSnapshot: QualitySnapshot
    try {
      preSnapshot = JSON.parse(exec.pre_scores!) as QualitySnapshot
    } catch {
      continue
    }

    const postSnapshot = takeQualitySnapshot(exec.agent)

    // Skip if no new data points since pre-snapshot
    if (Object.keys(postSnapshot.scores).length === 0) {
      log.debug(`[QualityTracker] No post-fix scores for ${exec.agent}, skipping`)
      continue
    }

    const comparison = compareSnapshots(preSnapshot, postSnapshot)

    updateExecutionScores(exec.proposal_id, 'post_scores', JSON.stringify(postSnapshot))
    updateExecutionScores(exec.proposal_id, 'quality_delta', JSON.stringify(comparison))

    logActivity({
      event_type: 'quality_check',
      chain: 'chain3',
      summary: `${exec.agent} Post-fix quality ${comparison.verdict === 'improved' ? 'improved' : comparison.verdict === 'degraded' ? 'declined' : 'stable'} (delta=${comparison.net_delta})`,
      detail: {
        proposal_id: exec.proposal_id,
        agent: exec.agent,
        improved: comparison.improved,
        degraded: comparison.degraded,
        net_delta: comparison.net_delta
      },
      proposal_id: exec.proposal_id,
      agent: exec.agent,
      outcome: comparison.verdict === 'degraded' ? 'failed' : 'success'
    })

    if (comparison.verdict === 'degraded') {
      log.warn(
        `[QualityTracker] ${exec.agent} quality degraded after fix ${exec.proposal_id}: delta=${comparison.net_delta}`
      )
    }
  }
}
