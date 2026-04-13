import { getDB } from '../db'
import { runUtilityPrompt } from '../ai'
import { log } from '../logger'
import { isOverBudget } from '../tokenBudget'
import {
  createProposal,
  countTodayRepairs,
  updateProposalStatus,
  updateProposalSummary,
  getProposal
} from './db'
import { executeL2Repair } from './remediation'
import { logActivity } from './activityLog'
import { takeQualitySnapshot, recordPreScores } from './qualityTracker'
import {
  findMatchingPattern,
  extractAndStorePattern,
  recordPatternOutcome
} from './learnedPatterns'
import { buildRepairSummary } from './userSummary'
import { pushToTelegram } from '../telegram/bridge'

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_DAILY_REPAIRS = 2
const CORE_FILES = new Set(['db.ts', 'ai.ts', 'index.ts', 'ipc.ts', 'safeStore.ts'])
const MAX_REPAIR_ATTEMPTS_PER_ERROR = 2

// ─── Types ──────────────────────────────────────────────────────────────────

interface ErrorEntry {
  id: number
  error_id: string | null
  agent: string | null
  model: string | null
  error_type: string | null
  error_message: string | null
  context: string | null
  created_at: string
}

interface DiagnosisResult {
  agent: string
  error_count: number
  errors: ErrorEntry[]
  diagnosis: string
  category: 'known_pattern' | 'fixable' | 'needs_human'
  change_level: 'L1' | 'L2' | 'L3'
  suggested_fix: string | null
}

interface RepairResult {
  diagnosed: number
  l1_resolved: number
  l2_proposals: number
  l2_applied: number
  l2_failed: number
  l3_flagged: number
  skipped: string | null
  applied_fixes: Array<{ proposal: string; files: string[]; explanation: string }>
}

// ─── Known Error Patterns (L1 auto-resolve) ─────────────────────────────────

const KNOWN_PATTERNS: Array<{
  match: (msg: string) => boolean
  resolution: string
}> = [
  {
    match: (m) => m.includes('ECONNREFUSED') && m.includes('11434'),
    resolution: 'Local model server not running — skipped this call'
  },
  {
    match: (m) => m.includes('timeout') || m.includes('timed out'),
    resolution: 'API timeout — transient network issue, auto-retried'
  },
  {
    match: (m) => m.includes('circuit breaker is OPEN'),
    resolution: 'Circuit breaker OPEN — waiting for recovery'
  },
  {
    match: (m) => m.includes('rate limit') || m.includes('429'),
    resolution: 'API rate limited — cooling down'
  },
  {
    match: (m) => m.includes('SQLITE_BUSY'),
    resolution: 'DB busy — WAL checkpoint conflict, usually self-resolves'
  }
]

// ─── Detection Phase (read-only) ────────────────────────────────────────────

function getRecentUnresolvedErrors(hours = 24): ErrorEntry[] {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
  return getDB()
    .prepare(
      `SELECT id, error_id, agent, model, error_type, error_message, context, created_at
       FROM error_log
       WHERE resolved = 0 AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT 50`
    )
    .all(since) as ErrorEntry[]
}

function groupByAgent(errors: ErrorEntry[]): Map<string, ErrorEntry[]> {
  const groups = new Map<string, ErrorEntry[]>()
  for (const err of errors) {
    const key = err.agent || 'unknown'
    const list = groups.get(key) || []
    list.push(err)
    groups.set(key, list)
  }
  return groups
}

function matchKnownPattern(errors: ErrorEntry[]): string | null {
  for (const err of errors) {
    const msg = (err.error_message || '').toLowerCase()
    const pattern = KNOWN_PATTERNS.find((p) => p.match(msg))
    if (pattern) return pattern.resolution
  }
  return null
}

function resolveErrors(errorIds: number[], resolution: string): void {
  const db = getDB()
  const stmt = db.prepare('UPDATE error_log SET resolved = 1, resolution = ? WHERE id = ?')
  const tx = db.transaction(() => {
    for (const id of errorIds) {
      stmt.run(resolution, id)
    }
  })
  tx()
}

// ─── Diagnosis (fast model — cheap) ───────────────────────────────────────

function buildDiagnosisPrompt(agent: string, errors: ErrorEntry[]): string {
  const errorSummary = errors
    .slice(0, 10)
    .map(
      (e) =>
        `- [${e.created_at}] ${e.error_type}: ${(e.error_message || '').slice(0, 200)} (context: ${e.context || 'N/A'})`
    )
    .join('\n')

  return `You are a system diagnostician. Analyze the following agent "${agent}"  error logs. Provide root cause analysis and classification.

Error list:
${errorSummary}

Classification rules:
- known_pattern: known transient issues (network timeout, local model down, rate limit), auto-mark resolved
- fixable: code bug or config error, fixable with small changes
- needs_human: unknown errors, core module issues, requires human intervention

Change level:
- L1: no side effects (mark resolved, retry)
- L2: small code/config changes (add try/catch, fix parameters)
- L3: core logic/architecture changes (DB schema, routing)

Strictly output in the following JSON format:
{
  "diagnosis": "root cause analysis",
  "category": "known_pattern"/"fixable"/"needs_human",
  "change_level": "L1"/"L2"/"L3",
  "suggested_fix": "suggested fix if fixable (null otherwise)"
}`
}

// ─── Self-Repair Main ───────────────────────────────────────────────────────

/**
 * Self-repair patrol loop.
 *
 * 1. Read error_log (last 24h, resolved=0)
 * 2. Group by agent
 * 3. Match known patterns → L1 auto-resolve
 * 4. Unknown errors → AI diagnosis → categorize
 * 5. L2 fixable → auto-generate fix, apply, typecheck+test, keep or rollback
 * 6. L3 / core files → needs_human proposal
 */
export async function runSelfRepairLoop(): Promise<RepairResult> {
  const result: RepairResult = {
    diagnosed: 0,
    l1_resolved: 0,
    l2_proposals: 0,
    l2_applied: 0,
    l2_failed: 0,
    l3_flagged: 0,
    skipped: null,
    applied_fixes: []
  }

  // Guard: budget
  if (isOverBudget('primary')) {
    result.skipped = 'primary_over_budget'
    return result
  }

  // Guard: daily repair limit
  if (countTodayRepairs() >= MAX_DAILY_REPAIRS) {
    result.skipped = 'daily_repair_limit'
    return result
  }

  const errors = getRecentUnresolvedErrors()
  if (errors.length === 0) {
    result.skipped = 'no_errors'
    return result
  }

  const groups = groupByAgent(errors)

  for (const [agent, agentErrors] of groups) {
    result.diagnosed++

    // L1: Try known pattern match first (zero cost)
    const knownResolution = matchKnownPattern(agentErrors)
    if (knownResolution) {
      resolveErrors(
        agentErrors.map((e) => e.id),
        knownResolution
      )
      result.l1_resolved += agentErrors.length
      logActivity({
        event_type: 'repair_l1',
        chain: 'repair',
        summary: `L1 auto-resolved ${agentErrors.length}  entries: ${knownResolution}`,
        detail: { errorIds: agentErrors.map((e) => e.id), resolution: knownResolution },
        agent,
        outcome: 'success'
      })
      log.info(
        `[Evolution] L1 auto-resolved ${agentErrors.length} errors for ${agent}: ${knownResolution}`
      )
      continue
    }

    // L1.5: Check learned patterns before expensive AI diagnosis
    const errorMsgsForMatch = agentErrors.map((e) => e.error_message || '').filter(Boolean)
    const patternMatch = findMatchingPattern(
      agent,
      agentErrors[0].error_type ?? null,
      errorMsgsForMatch
    )
    if (patternMatch && patternMatch.tokenOverlap >= 0.6) {
      const secNote = patternMatch.security.isSuspicious
        ? ` ⚠️ Security sniff triggered: ${patternMatch.security.watchwordsFound.join(', ')}`
        : ''
      log.info(
        `[Evolution] L1.5 match for ${agent}: pattern #${patternMatch.pattern.id} (overlap=${patternMatch.tokenOverlap.toFixed(2)}, effective=${patternMatch.effectiveConfidence}, raw=${patternMatch.pattern.confidence})${secNote}`
      )
      logActivity({
        event_type: 'repair_l1',
        chain: 'repair',
        summary: `L1.5 learned pattern match for ${agent}: ${patternMatch.pattern.fix_action.slice(0, 60)}${secNote}`,
        detail: {
          patternId: patternMatch.pattern.id,
          overlap: patternMatch.tokenOverlap,
          effectiveConfidence: patternMatch.effectiveConfidence,
          rawConfidence: patternMatch.pattern.confidence,
          recommendation: patternMatch.recommendation.slice(0, 200),
          securityFlag: patternMatch.security
        },
        agent,
        outcome: 'success'
      })
      // Security-suspicious patterns NEVER skip AI diagnosis — always verify.
      // Clean patterns with high confidence can provide context to speed up diagnosis.
    }

    // Diagnosis via AI
    try {
      // Inject learned pattern as context if available
      let diagPrompt = buildDiagnosisPrompt(agent, agentErrors)
      if (patternMatch) {
        const secWarning = patternMatch.security.isSuspicious
          ? `\n⚠️ Security warning: this historical fix involves sensitive operations (${patternMatch.security.watchwordsFound.join(', ')}) — re-evaluate independently, do not trust blindly.`
          : ''
        diagPrompt += `\n\nHistorical repair reference (previous fix for similar error, effective confidence ${patternMatch.effectiveConfidence}%）：\n${patternMatch.recommendation}${secWarning}`
      }

      const diagResult = await runUtilityPrompt(diagPrompt, {
        provider: 'primary',
        forceJson: true
      })

      const jsonMatch = diagResult.text.match(/\{[\s\S]*\}/)
      const diag: DiagnosisResult = {
        agent,
        error_count: agentErrors.length,
        errors: agentErrors,
        ...(jsonMatch
          ? JSON.parse(jsonMatch[0])
          : {
              diagnosis: 'Parse failed',
              category: 'needs_human',
              change_level: 'L3',
              suggested_fix: null
            })
      }

      // Check for core file involvement → force L3
      if (diag.suggested_fix) {
        const mentionsCore = [...CORE_FILES].some((f) =>
          diag.suggested_fix!.toLowerCase().includes(f)
        )
        if (mentionsCore) {
          diag.category = 'needs_human'
          diag.change_level = 'L3'
        }
      }

      // Check for repeat failures (loop detection)
      const prevRepairCount = getDB()
        .prepare(
          `SELECT COUNT(*) as cnt FROM evolution_proposals
           WHERE type = 'repair' AND error_ids LIKE ? AND status IN ('applied', 'rejected')`
        )
        .get(`%"${agentErrors[0].id}"%`) as { cnt: number }

      if (prevRepairCount.cnt >= MAX_REPAIR_ATTEMPTS_PER_ERROR) {
        diag.category = 'needs_human'
        diag.change_level = 'L3'
        log.warn(
          `[Evolution] Error ${agentErrors[0].id} repaired ${prevRepairCount.cnt} times → needs_human`
        )
      }

      if (diag.category === 'known_pattern') {
        resolveErrors(
          agentErrors.map((e) => e.id),
          diag.diagnosis
        )
        result.l1_resolved += agentErrors.length
      } else {
        // Create repair proposal (L2 or L3)
        const id = `repair_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
        const errorIds = agentErrors.map((e) => e.id)
        createProposal({
          id,
          type: 'repair',
          title: `[${agent}] ${diag.diagnosis.slice(0, 80)}`,
          description:
            diag.diagnosis + (diag.suggested_fix ? `\n\nSuggested fix: ${diag.suggested_fix}` : ''),
          status: diag.change_level === 'L3' ? 'needs_human' : 'pending'
        })

        // Store error IDs linkage
        getDB()
          .prepare('UPDATE evolution_proposals SET error_ids = ? WHERE id = ?')
          .run(JSON.stringify(errorIds), id)

        if (diag.change_level === 'L3') {
          result.l3_flagged++
          updateProposalStatus(id, 'needs_human')

          // Generate user-facing summary and push to Telegram
          const fresh = getProposal(id)
          if (fresh) {
            const summary = buildRepairSummary(fresh)
            updateProposalSummary(id, summary)
            pushToTelegram(summary).catch(() => {})
          }

          logActivity({
            event_type: 'repair_l2',
            chain: 'repair',
            summary: `L3 needs human intervention: ${agent} — ${diag.diagnosis.slice(0, 60)}`,
            detail: { diagnosis: diag.diagnosis, errorCount: agentErrors.length },
            proposal_id: id,
            agent,
            outcome: 'pending'
          })
        } else {
          result.l2_proposals++

          // Quality snapshot before repair
          const preSnapshot = takeQualitySnapshot(agent)
          recordPreScores(id, preSnapshot)

          // L2: Auto-execute repair (generate fix → apply → typecheck → test)
          try {
            const errorMsgs = agentErrors.map((e) => e.error_message || '').filter(Boolean)
            const remediation = await executeL2Repair(
              id,
              diag.diagnosis,
              agent,
              errorMsgs,
              errorIds
            )

            if (remediation.success) {
              result.l2_applied++
              result.applied_fixes.push({
                proposal: id,
                files: remediation.files_changed,
                explanation: remediation.explanation
              })

              // L1.5: Extract and store the successful repair pattern
              extractAndStorePattern({
                agent,
                errorType: agentErrors[0].error_type ?? null,
                errorMessages: errorMsgs,
                fixDescription: diag.diagnosis + '\n' + remediation.explanation,
                fixFiles: remediation.files_changed,
                fixAction: remediation.explanation,
                proposalId: id
              })
              // If we matched a pattern earlier, reinforce it
              if (patternMatch) {
                recordPatternOutcome(patternMatch.pattern.id, true)
              }

              logActivity({
                event_type: 'repair_l2',
                chain: 'repair',
                summary: `L2 repair succeeded: ${agent} — ${remediation.explanation.slice(0, 60)}`,
                detail: {
                  files: remediation.files_changed,
                  explanation: remediation.explanation
                },
                proposal_id: id,
                agent,
                outcome: 'success'
              })
            } else {
              result.l2_failed++
              // Degrade matched pattern confidence on failure
              if (patternMatch) {
                recordPatternOutcome(patternMatch.pattern.id, false)
              }
              logActivity({
                event_type: 'repair_l2',
                chain: 'repair',
                summary: `L2 repair failed: ${agent} — ${remediation.error}`,
                detail: { error: remediation.error },
                proposal_id: id,
                agent,
                outcome: 'failed'
              })
              log.info(`[Evolution] L2 repair failed for ${id}: ${remediation.error}`)
            }
          } catch (err) {
            result.l2_failed++
            logActivity({
              event_type: 'repair_l2',
              chain: 'repair',
              summary: `L2 Execution error: ${agent} — ${err}`,
              proposal_id: id,
              agent,
              outcome: 'failed'
            })
            log.warn(`[Evolution] L2 execution error for ${id}:`, err)
          }
        }
      }
    } catch (err) {
      log.warn(`[Evolution] Diagnosis failed for agent ${agent}:`, err)
    }
  }

  log.info(
    `[Evolution] Self-repair complete: ${result.l1_resolved} L1, ${result.l2_proposals} L2 (${result.l2_applied} applied, ${result.l2_failed} failed), ${result.l3_flagged} L3`
  )
  return result
}
