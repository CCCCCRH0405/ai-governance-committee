import { isAgentEnabled } from '../maintenance/agentConfig'
import { log } from '../logger'
import {
  runEvolutionThinker,
  runSelfRepair,
  runProactiveAuditEntry,
  runPromptAutoApplyEntry,
  runProposalExecutorEntry,
  runPendingQualityChecksEntry
} from './index'

let thinkerTimer: NodeJS.Timeout | null = null
let repairTimer: NodeJS.Timeout | null = null
let auditTimer: NodeJS.Timeout | null = null
let promptApplyTimer: NodeJS.Timeout | null = null
let proposalExecTimer: NodeJS.Timeout | null = null
let qualityCheckTimer: NodeJS.Timeout | null = null

// ─── Evolution Thinker: every 4 hours ───────────────────────────────────────

const THINKER_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours

export function startEvolutionScheduler(): void {
  if (thinkerTimer) return
  if (!isAgentEnabled('evolution_thinker')) {
    log.info('[Evolution] evolution_thinker agent disabled — scheduler not started')
    return
  }

  log.info('[Evolution] Starting evolution thinker scheduler (every 4h)')

  // First run after 10 minutes (let app stabilize)
  thinkerTimer = setTimeout(
    async () => {
      await runEvolutionThinker()
      // Then schedule recurring
      thinkerTimer = setInterval(() => {
        void runEvolutionThinker()
      }, THINKER_INTERVAL_MS)
    },
    10 * 60 * 1000
  )
}

export function stopEvolutionScheduler(): void {
  if (thinkerTimer) {
    clearTimeout(thinkerTimer)
    clearInterval(thinkerTimer)
    thinkerTimer = null
  }
}

// ─── Self-Repair: daily at 3:30 AM (after autodream at 3:00) ────────────────

function msUntilNext0330(): number {
  const now = new Date()
  const target = new Date()
  target.setHours(3, 30, 0, 0)
  if (target <= now) target.setDate(target.getDate() + 1)
  return target.getTime() - now.getTime()
}

export function startRepairScheduler(): void {
  if (repairTimer) return
  if (!isAgentEnabled('self_repair')) {
    log.info('[Evolution] self_repair agent disabled — scheduler not started')
    return
  }

  log.info('[Evolution] Starting self-repair scheduler (daily 3:30)')

  const scheduleNext = (): void => {
    repairTimer = setTimeout(async () => {
      await runSelfRepair()
      scheduleNext()
    }, msUntilNext0330())
  }
  scheduleNext()
}

export function stopRepairScheduler(): void {
  if (repairTimer) {
    clearTimeout(repairTimer)
    repairTimer = null
  }
}

// ─── Proactive Audit: every 6 hours ───────────────────────────────────────

const AUDIT_INTERVAL_MS = 6 * 60 * 60 * 1000

export function startAuditScheduler(): void {
  if (auditTimer) return
  if (!isAgentEnabled('self_repair')) return // shares toggle with repair

  log.info('[Evolution] Starting proactive audit scheduler (every 6h)')

  auditTimer = setTimeout(
    async () => {
      await runProactiveAuditEntry()
      auditTimer = setInterval(() => {
        void runProactiveAuditEntry()
      }, AUDIT_INTERVAL_MS)
    },
    20 * 60 * 1000 // first run after 20 minutes
  )
}

export function stopAuditScheduler(): void {
  if (auditTimer) {
    clearTimeout(auditTimer)
    clearInterval(auditTimer)
    auditTimer = null
  }
}

// ─── Prompt Auto-Apply: daily at 4:00 AM ──────────────────────────────────

function msUntilNext0400(): number {
  const now = new Date()
  const target = new Date()
  target.setHours(4, 0, 0, 0)
  if (target <= now) target.setDate(target.getDate() + 1)
  return target.getTime() - now.getTime()
}

export function startPromptApplyScheduler(): void {
  if (promptApplyTimer) return
  if (!isAgentEnabled('prompt_evolution')) return // shares toggle

  log.info('[Evolution] Starting prompt auto-apply scheduler (daily 4:00)')

  const scheduleNext = (): void => {
    promptApplyTimer = setTimeout(async () => {
      await runPromptAutoApplyEntry()
      scheduleNext()
    }, msUntilNext0400())
  }
  scheduleNext()
}

export function stopPromptApplyScheduler(): void {
  if (promptApplyTimer) {
    clearTimeout(promptApplyTimer)
    promptApplyTimer = null
  }
}

// ─── Proposal Executor: every 2 hours ─────────────────────────────────────

const PROPOSAL_EXEC_INTERVAL_MS = 2 * 60 * 60 * 1000

export function startProposalExecScheduler(): void {
  if (proposalExecTimer) return
  if (!isAgentEnabled('evolution_thinker')) return // shares toggle

  log.info('[Evolution] Starting proposal executor scheduler (every 2h)')

  proposalExecTimer = setTimeout(
    async () => {
      await runProposalExecutorEntry()
      proposalExecTimer = setInterval(() => {
        void runProposalExecutorEntry()
      }, PROPOSAL_EXEC_INTERVAL_MS)
    },
    15 * 60 * 1000 // first run after 15 minutes
  )
}

export function stopProposalExecScheduler(): void {
  if (proposalExecTimer) {
    clearTimeout(proposalExecTimer)
    clearInterval(proposalExecTimer)
    proposalExecTimer = null
  }
}

// ─── Quality Check: every 4 hours ─────────────────────────────────────────

const QUALITY_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

export function startQualityCheckScheduler(): void {
  if (qualityCheckTimer) return
  if (!isAgentEnabled('self_repair')) return

  log.info('[Evolution] Starting quality check scheduler (every 4h)')

  qualityCheckTimer = setTimeout(
    async () => {
      runPendingQualityChecksEntry()
      qualityCheckTimer = setInterval(() => {
        runPendingQualityChecksEntry()
      }, QUALITY_CHECK_INTERVAL_MS)
    },
    5 * 60 * 1000 // first run after 5 minutes
  )
}

export function stopQualityCheckScheduler(): void {
  if (qualityCheckTimer) {
    clearTimeout(qualityCheckTimer)
    clearInterval(qualityCheckTimer)
    qualityCheckTimer = null
  }
}
