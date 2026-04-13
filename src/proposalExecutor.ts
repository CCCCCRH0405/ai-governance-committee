// src/main/evolution/proposalExecutor.ts
// Chain 2: Approved Proposal Auto-Execution.
//
// Polls proposals with status='approved', classifies risk, and auto-executes low-risk ones.
// High-risk / skill proposals are left for user decision.
//
// Execution routes:
//   - repair (low risk) → L2 pipeline (typecheck + test + rollback)
//   - config change → direct apply
//   - skill / high risk → skip (needs user)

import { getProposalsByStatus, updateProposalStatus, countTodayRepairs } from './db'
import { executeL2Repair } from './remediation'
import { isOverBudget } from '../tokenBudget'
import { logActivity } from './activityLog'
import { takeQualitySnapshot, recordPreScores } from './qualityTracker'
import { extractAndStorePattern } from './learnedPatterns'
import { log } from '../logger'

const MAX_DAILY_AUTO_EXECUTIONS = 2
const SAFE_RISK_LEVELS = new Set(['low', 'none', null, undefined, ''])

// ─── Main Loop ─────────────────────────────────────────────────────────────

export async function runProposalExecutorLoop(): Promise<{
  executed: number
  skipped: number
  failed: number
  skippedReason: string | null
}> {
  const result = { executed: 0, skipped: 0, failed: 0, skippedReason: null as string | null }

  if (isOverBudget('primary')) {
    result.skippedReason = 'primary_over_budget'
    return result
  }

  const todayRepairs = countTodayRepairs()
  if (todayRepairs >= MAX_DAILY_AUTO_EXECUTIONS) {
    result.skippedReason = 'daily_limit_reached'
    return result
  }

  const approved = getProposalsByStatus('approved', 10)
  if (approved.length === 0) {
    result.skippedReason = 'no_approved_proposals'
    return result
  }

  const remainingSlots = MAX_DAILY_AUTO_EXECUTIONS - todayRepairs

  for (const proposal of approved.slice(0, remainingSlots)) {
    // Never auto-execute external skills — requires user approval
    if (proposal.type === 'skill') {
      logActivity({
        event_type: 'proposal_execute',
        chain: 'chain2',
        summary: `Skipped skill proposal (requires user approval): ${proposal.title}`,
        proposal_id: proposal.id,
        outcome: 'skipped'
      })
      result.skipped++
      continue
    }

    // Only auto-execute low-risk proposals
    if (!SAFE_RISK_LEVELS.has(proposal.fix_risk_level)) {
      logActivity({
        event_type: 'proposal_execute',
        chain: 'chain2',
        summary: `Skipped high-risk proposal (${proposal.fix_risk_level}): ${proposal.title}`,
        proposal_id: proposal.id,
        outcome: 'skipped'
      })
      result.skipped++
      continue
    }

    // Route: repair type with L2 pipeline
    if (proposal.type === 'repair') {
      try {
        // Extract agent from description or error_ids
        const agent = extractAgent(proposal)
        const preSnapshot = takeQualitySnapshot(agent)
        recordPreScores(proposal.id, preSnapshot)

        log.info(`[ProposalExecutor] Auto-executing repair: ${proposal.title}`)

        const errorIds = proposal.error_ids ? (JSON.parse(proposal.error_ids) as number[]) : []
        const l2Result = await executeL2Repair(
          proposal.id,
          proposal.description,
          agent,
          [proposal.description],
          errorIds
        )

        if (l2Result.success) {
          updateProposalStatus(proposal.id, 'applied', {
            applied_at: new Date().toISOString()
          })

          // L1.5: Store successful repair pattern
          extractAndStorePattern({
            agent,
            errorType: null,
            errorMessages: [proposal.description],
            fixDescription: proposal.description,
            fixFiles: l2Result.files_changed,
            fixAction: l2Result.explanation,
            proposalId: proposal.id
          })

          logActivity({
            event_type: 'proposal_execute',
            chain: 'chain2',
            summary: `Auto-executed repair: ${proposal.title}`,
            detail: {
              files: l2Result.files_changed,
              explanation: l2Result.explanation
            },
            proposal_id: proposal.id,
            agent,
            outcome: 'success'
          })
          result.executed++
        } else {
          logActivity({
            event_type: 'proposal_execute',
            chain: 'chain2',
            summary: `Auto-repair failed: ${proposal.title} — ${l2Result.error}`,
            detail: { error: l2Result.error },
            proposal_id: proposal.id,
            agent,
            outcome: 'failed'
          })
          result.failed++
        }
      } catch (err) {
        logActivity({
          event_type: 'proposal_execute',
          chain: 'chain2',
          summary: `Execution error: ${proposal.title}: ${err}`,
          proposal_id: proposal.id,
          outcome: 'failed'
        })
        result.failed++
      }
      continue
    }

    // Route: thinking/other proposals — only execute if they have concrete fix_diff
    if (proposal.fix_diff && proposal.fix_files) {
      try {
        const agent = extractAgent(proposal)
        const thinkErrorIds = proposal.error_ids ? (JSON.parse(proposal.error_ids) as number[]) : []
        const l2Result = await executeL2Repair(
          proposal.id,
          proposal.description,
          agent,
          [proposal.description],
          thinkErrorIds
        )

        if (l2Result.success) {
          updateProposalStatus(proposal.id, 'applied', {
            applied_at: new Date().toISOString()
          })
          logActivity({
            event_type: 'proposal_execute',
            chain: 'chain2',
            summary: `Auto-executed proposal: ${proposal.title}`,
            proposal_id: proposal.id,
            agent,
            outcome: 'success'
          })
          result.executed++
        } else {
          result.failed++
        }
      } catch {
        result.failed++
      }
    } else {
      // No fix_diff — this is an abstract proposal, leave for user
      logActivity({
        event_type: 'proposal_execute',
        chain: 'chain2',
        summary: `Skipped abstract proposal (no fix_diff): ${proposal.title}`,
        proposal_id: proposal.id,
        outcome: 'skipped'
      })
      result.skipped++
    }
  }

  return result
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractAgent(proposal: { description: string; error_ids?: string | null }): string {
  // Try to extract agent name from description
  const agentPatterns = [
    /agent[:\s]+(\w+)/i,
    /(morning_briefing|memory_custodian|token_audit|compliance_sentinel|flight_sentinel|custom_watcher|evolution_thinker|self_repair)/i
  ]
  for (const pattern of agentPatterns) {
    const match = proposal.description.match(pattern)
    if (match) return match[1]
  }
  return 'unknown'
}
