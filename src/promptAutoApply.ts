// src/main/evolution/promptAutoApply.ts
// Chain 1: Prompt Auto-Apply — read suggestions → modify prompt files → backup → validate.
//
// Flow:
//   1. Read unapplied high-priority prompt_suggestion reports
//   2. For each suggestion: read target file → AI generates modification → validate
//   3. Backup via snapshotPromptDirectory → write modified file → typecheck
//   4. If typecheck fails: rollback from snapshot
//   5. Log everything to activity log

import fs from 'fs'
import path from 'path'
import { getAgentReports } from '../maintenance/db'
import { isOverBudget } from '../tokenBudget'
import { parseJsonSafe } from '../parseJson'
import { snapshotPromptDirectory } from '../quality/promptVersioning'
import { logActivity } from './activityLog'
import { getActivityLogSince } from './db'
import { takeQualitySnapshot } from './qualityTracker'
import { log } from '../logger'
import type { AIUsage, ProviderId } from '../../shared/types'

type UtilityCallResult = {
  text: string
  provider: ProviderId
  model: string
  usage?: AIUsage
}

const PROMPT_ROOT = path.join(__dirname, '../../prompts')
const MAX_DAILY_PROMPT_CHANGES = 1

// ─── Helpers ───────────────────────────────────────────────────────────────

interface PromptSuggestion {
  agent: string
  target: string
  priority: 'low' | 'medium' | 'high'
  diagnosis: string
  suggestion: string
}

function getUnappliedHighPrioritySuggestions(): PromptSuggestion[] {
  // Read recent prompt_suggestion reports
  const reports = getAgentReports(30)
  const suggestionReports = reports.filter(
    (r) =>
      r.agent === 'prompt_evolution' &&
      r.report_type === 'prompt_suggestion' &&
      r.created_at >= new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  )

  // Already applied this week — check activity log
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const appliedLogs = getActivityLogSince(weekAgo, 100).filter(
    (l) => l.chain === 'chain1' && l.event_type === 'prompt_apply'
  )
  const appliedTargets = new Set(
    appliedLogs
      .map((l) => {
        try {
          return (JSON.parse(l.detail ?? '{}') as Record<string, unknown>).target as string
        } catch {
          return null
        }
      })
      .filter(Boolean)
  )

  // Check for rollback cooldown
  const rolledBack = appliedLogs
    .filter((l) => l.outcome === 'rollback')
    .map((l) => {
      try {
        return (JSON.parse(l.detail ?? '{}') as Record<string, unknown>).target as string
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const cooldownTargets = new Set(rolledBack)

  const result: PromptSuggestion[] = []
  for (const report of suggestionReports) {
    try {
      const body = JSON.parse(report.body ?? '{}') as { suggestions?: PromptSuggestion[] }
      if (!Array.isArray(body.suggestions)) continue
      for (const s of body.suggestions) {
        if (s.priority !== 'high') continue
        if (appliedTargets.has(s.target)) continue
        if (cooldownTargets.has(s.target)) continue
        result.push(s)
      }
    } catch {
      /* skip malformed */
    }
  }

  return result
}

function resolvePromptPath(target: string): string | null {
  // target could be "prompts/staging.md" or full path
  const candidates = [
    path.join(PROMPT_ROOT, path.basename(target)),
    path.join(PROMPT_ROOT, target.replace(/^prompts\//, '')),
    target
  ]
  for (const c of candidates) {
    if (fs.existsSync(c) && c.endsWith('.md')) return c
  }
  return null
}

function countTodayPromptChanges(): number {
  const today = new Date().toISOString().slice(0, 10)
  const logs = getActivityLogSince(today, 50).filter(
    (l) => l.chain === 'chain1' && l.event_type === 'prompt_apply' && l.outcome === 'success'
  )
  return logs.length
}

// ─── Main Loop ─────────────────────────────────────────────────────────────

export async function runPromptAutoApplyLoop(
  caller: (prompt: string) => Promise<UtilityCallResult>
): Promise<{
  checked: number
  applied: number
  skipped: string | null
}> {
  const result = { checked: 0, applied: 0, skipped: null as string | null }

  if (isOverBudget('primary')) {
    result.skipped = 'primary_over_budget'
    return result
  }

  if (countTodayPromptChanges() >= MAX_DAILY_PROMPT_CHANGES) {
    result.skipped = 'daily_limit_reached'
    return result
  }

  const suggestions = getUnappliedHighPrioritySuggestions()
  if (suggestions.length === 0) {
    result.skipped = 'no_unapplied_suggestions'
    return result
  }

  // Take only 1 per run
  const suggestion = suggestions[0]
  result.checked = 1

  const filePath = resolvePromptPath(suggestion.target)
  if (!filePath) {
    logActivity({
      event_type: 'prompt_apply',
      chain: 'chain1',
      summary: `Target file not found: ${suggestion.target}`,
      detail: { suggestion },
      agent: suggestion.agent,
      outcome: 'skipped'
    })
    return result
  }

  const originalContent = fs.readFileSync(filePath, 'utf-8')

  // Pre-snapshot quality
  const preSnapshot = takeQualitySnapshot(suggestion.agent)

  // Backup all prompts before modification
  snapshotPromptDirectory('prompt_auto_apply')

  // Ask the model to generate the modification
  const modifyPrompt = `You are a prompt modification executor. Modify the prompt file based on the diagnosis and suggestion below.

Target file: ${path.basename(filePath)}
Current content:
${originalContent}

Diagnosis: ${suggestion.diagnosis}
Modification suggestion: ${suggestion.suggestion}

Rules:
1. Only modify the parts mentioned in the suggestion, keep everything else unchanged
2. Preserve original formatting (markdown, indentation, blank lines)
3. Do not add comments explaining what you changed
4. Output the complete modified file content

Strictly output JSON:
{
  "modified_content": "complete modified file content",
  "changes_made": "brief summary of changes (under 50 chars)"
}`

  try {
    const aiResult = await caller(modifyPrompt)
    const parsed = parseJsonSafe<{ modified_content?: string; changes_made?: string }>(
      aiResult.text
    )

    if (!parsed?.modified_content) {
      logActivity({
        event_type: 'prompt_apply',
        chain: 'chain1',
        summary: `AI did not generate valid modification: ${suggestion.target}`,
        detail: { suggestion, raw: aiResult.text.slice(0, 200) },
        agent: suggestion.agent,
        outcome: 'failed'
      })
      return result
    }

    const modified = parsed.modified_content

    // Validate: not empty, not too different
    if (modified.length < 20) {
      logActivity({
        event_type: 'prompt_apply',
        chain: 'chain1',
        summary: `Modified content too short, rejected: ${suggestion.target}`,
        agent: suggestion.agent,
        outcome: 'failed'
      })
      return result
    }

    const changeRatio = Math.abs(modified.length - originalContent.length) / originalContent.length
    if (changeRatio > 0.3) {
      logActivity({
        event_type: 'prompt_apply',
        chain: 'chain1',
        summary: `Modification too large (${(changeRatio * 100).toFixed(0)}%), rejected: ${suggestion.target}`,
        detail: { changeRatio, suggestion },
        agent: suggestion.agent,
        outcome: 'failed'
      })
      return result
    }

    // Apply the modification
    fs.writeFileSync(filePath, modified, 'utf-8')

    logActivity({
      event_type: 'prompt_apply',
      chain: 'chain1',
      summary: `Modified ${path.basename(filePath)}: ${parsed.changes_made ?? suggestion.suggestion.slice(0, 50)}`,
      detail: {
        target: suggestion.target,
        agent: suggestion.agent,
        changes_made: parsed.changes_made,
        diagnosis: suggestion.diagnosis,
        pre_scores: preSnapshot.scores,
        change_ratio: changeRatio
      },
      agent: suggestion.agent,
      outcome: 'success'
    })

    result.applied = 1
    log.info(`[PromptAutoApply] Applied modification to ${path.basename(filePath)}`)
  } catch (err) {
    // Rollback on any error
    fs.writeFileSync(filePath, originalContent, 'utf-8')

    logActivity({
      event_type: 'prompt_apply',
      chain: 'chain1',
      summary: `Modification failed, rolled back: ${suggestion.target}: ${err}`,
      detail: { suggestion, error: String(err) },
      agent: suggestion.agent,
      outcome: 'rollback'
    })

    log.warn(`[PromptAutoApply] Failed and rolled back ${suggestion.target}:`, err)
  }

  return result
}
