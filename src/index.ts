import type { ProviderId, AIUsage } from '../../shared/types'
import { log } from '../logger'
import { updateAgentStatus, insertAgentReport } from '../maintenance/db'
import { ensureEvolutionTables, getProposalsByStatus } from './db'
import { runDiscoveryLoop } from './discovery'
import { runSelfRepairLoop } from './selfRepair'
import { runProactiveAuditLoop } from './proactiveAudit'
import { runPromptAutoApplyLoop } from './promptAutoApply'
import { runProposalExecutorLoop } from './proposalExecutor'
import { runPendingQualityChecks } from './qualityTracker'
import { cleanupOldLogs } from './activityLog'

// ─── Initialization ─────────────────────────────────────────────────────────

export function initEvolution(): void {
  ensureEvolutionTables()
  log.info('[Evolution] Tables initialized')
}

// ─── Background Thinking (Agent: evolution_thinker) ─────────────────────────

export async function runEvolutionThinker(): Promise<void> {
  log.info('[Evolution] Starting background thinking loop')
  updateAgentStatus('evolution_thinker', 'running')

  try {
    const result = await runDiscoveryLoop()

    const body = JSON.stringify({
      searched: result.searched,
      candidates: result.candidates,
      relevant: result.relevant,
      reviewed: result.reviewed,
      approved: result.approved,
      skipped: result.skipped
    })

    if (result.skipped) {
      updateAgentStatus('evolution_thinker', 'idle', result.skipped)
      log.info(`[Evolution] Thinking loop skipped: ${result.skipped}`)
    } else {
      updateAgentStatus('evolution_thinker', 'success')

      // Write report if anything was discovered
      if (result.candidates > 0) {
        insertAgentReport(
          'evolution_thinker',
          'evolution_discovery',
          `Found ${result.candidates}  candidates, ${result.approved}  approved`,
          body,
          result.approved > 0 ? 'info' : 'warning'
        )
      }
    }

    // Notify about approved proposals waiting for user
    const approved = getProposalsByStatus('approved', 5)
    if (approved.length > 0) {
      log.info(`[Evolution] ${approved.length} approved proposals waiting for user`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    updateAgentStatus('evolution_thinker', 'error', msg)
    log.error('[Evolution] Thinking loop failed:', err)
  }
}

// ─── Self-Repair (Agent: self_repair) ───────────────────────────────────────

export async function runSelfRepair(): Promise<void> {
  log.info('[Evolution] Starting self-repair patrol')
  updateAgentStatus('self_repair', 'running')

  try {
    const result = await runSelfRepairLoop()

    const body = JSON.stringify({
      diagnosed: result.diagnosed,
      l1_resolved: result.l1_resolved,
      l2_proposals: result.l2_proposals,
      l2_applied: result.l2_applied,
      l2_failed: result.l2_failed,
      l3_flagged: result.l3_flagged,
      applied_fixes: result.applied_fixes,
      skipped: result.skipped
    })

    if (result.skipped) {
      updateAgentStatus('self_repair', 'idle', result.skipped)
    } else {
      updateAgentStatus('self_repair', 'success')

      const hasWork = result.l1_resolved > 0 || result.l2_proposals > 0 || result.l3_flagged > 0
      if (hasWork) {
        const appliedNote =
          result.l2_applied > 0
            ? ` (${result.l2_applied}  auto-fixed: ${result.applied_fixes.map((f) => f.files.join(',')).join('; ')})`
            : ''
        insertAgentReport(
          'self_repair',
          'self_repair',
          `Patrol complete: L1=${result.l1_resolved} L2=${result.l2_proposals}${appliedNote} L3=${result.l3_flagged}`,
          body,
          result.l3_flagged > 0 ? 'warning' : result.l2_applied > 0 ? 'info' : 'warning'
        )
      }
    }

    // Clean up old activity logs during repair window
    cleanupOldLogs(90)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    updateAgentStatus('self_repair', 'error', msg)
    log.error('[Evolution] Self-repair failed:', err)
  }
}

// ─── Proactive Audit ───────────────────────────────────────────────────────

export async function runProactiveAuditEntry(): Promise<void> {
  log.info('[Evolution] Starting proactive audit')
  updateAgentStatus('self_repair', 'running')

  try {
    const result = await runProactiveAuditLoop()

    if (result.skipped) {
      log.info(`[Evolution] Proactive audit skipped: ${result.skipped}`)
    } else if (result.proposals_created > 0) {
      insertAgentReport(
        'self_repair',
        'proactive_audit',
        `Audit complete: ${result.agents_checked} agents, ${result.declining_agents.length} declining, ${result.proposals_created} proposals`,
        JSON.stringify(result)
      )
    }

    updateAgentStatus('self_repair', 'idle')
  } catch (err) {
    log.error('[Evolution] Proactive audit failed:', err)
  }
}

// ─── Prompt Auto-Apply ────────────────────────────────────────────────────

export async function runPromptAutoApplyEntry(): Promise<void> {
  log.info('[Evolution] Starting prompt auto-apply')

  try {
    const { runUtilityPrompt } = await import('../ai')
    const caller = async (
      prompt: string
    ): Promise<{ text: string; provider: ProviderId; model: string; usage?: AIUsage }> => {
      return runUtilityPrompt(prompt, { provider: 'primary', forceJson: true })
    }
    const result = await runPromptAutoApplyLoop(caller)

    if (result.applied > 0) {
      insertAgentReport(
        'prompt_evolution',
        'prompt_auto_apply',
        `Prompt auto-modified: ${result.applied}  files`,
        JSON.stringify(result)
      )
    }
  } catch (err) {
    log.error('[Evolution] Prompt auto-apply failed:', err)
  }
}

// ─── Proposal Executor ────────────────────────────────────────────────────

export async function runProposalExecutorEntry(): Promise<void> {
  log.info('[Evolution] Starting proposal executor')

  try {
    const result = await runProposalExecutorLoop()

    if (result.executed > 0) {
      insertAgentReport(
        'evolution_thinker',
        'proposal_executor',
        `Proposal auto-executed: ${result.executed}  succeeded, ${result.failed}  failed`,
        JSON.stringify(result)
      )
    }
  } catch (err) {
    log.error('[Evolution] Proposal executor failed:', err)
  }
}

// ─── Quality Check ────────────────────────────────────────────────────────

export function runPendingQualityChecksEntry(): void {
  try {
    runPendingQualityChecks()
  } catch (err) {
    log.error('[Evolution] Quality check failed:', err)
  }
}
