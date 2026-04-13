// src/main/evolution/userSummary.ts
// Generates structured, human-readable summaries for proposals.
//
// When a proposal reaches the user (approved / needs_human), it must read
// like a colleague's briefing — not a raw diagnostic dump.

import type { EvolutionProposal, ReviewVerdict } from './db'
import { getDB } from '../db'

// ─── Type-specific headers ─────────────────────────────────────────────────

const TYPE_HEADERS: Record<string, string> = {
  skill: '📋 New skill proposal',
  repair: '🔧 Issue needs your attention',
  sentinel: '🛡️ New sentinel proposal',
  skin: '🎨 New theme proposal'
}

// ─── Review verdict formatting ─────────────────────────────────────────────

function formatVerdict(json: string | null, label: string): string {
  if (!json) return `${label} ⏳`
  try {
    const v = JSON.parse(json) as ReviewVerdict
    return `${label} ${v.pass ? '✅' : '❌'}`
  } catch {
    return `${label} ⏳`
  }
}

function formatReviewLine(proposal: EvolutionProposal): string {
  return [
    formatVerdict(proposal.review_function, 'Function review'),
    formatVerdict(proposal.review_utility, 'Utility review'),
    formatVerdict(proposal.review_compliance, 'Compliance review')
  ].join(' | ')
}

// ─── Interest context ──────────────────────────────────────────────────────

function describeMatchedInterests(matchedOn: string | null): string | null {
  if (!matchedOn) return null
  try {
    const terms = JSON.parse(matchedOn) as string[]
    if (terms.length === 0) return null
    return `You recently followed: ${terms.slice(0, 5).join('、')}`
  } catch {
    return null
  }
}

// ─── Error context for repairs ─────────────────────────────────────────────

function describeErrors(errorIds: string | null, agent: string | null): string | null {
  if (!errorIds) return null
  try {
    const ids = JSON.parse(errorIds) as number[]
    if (ids.length === 0) return null

    // Fetch the actual error messages for context
    const placeholders = ids.map(() => '?').join(',')
    const errors = getDB()
      .prepare(
        `SELECT error_type, error_message FROM error_log
         WHERE id IN (${placeholders}) LIMIT 3`
      )
      .all(...ids) as Array<{ error_type: string | null; error_message: string | null }>

    const agentNote = agent ? ` (agent: ${agent})` : ''
    const count = ids.length
    const sample = errors
      .filter((e) => e.error_message)
      .map((e) => (e.error_message || '').slice(0, 80))
      .slice(0, 2)
      .join('；')

    return `In the past 24 hours,  ${count}  related errors occurred${agentNote}${sample ? `：${sample}` : ''}`
  } catch {
    return null
  }
}

// ─── Extract agent from repair description ─────────────────────────────────

function extractAgentFromDescription(desc: string): string | null {
  const match = desc.match(/\[([^\]]+)\]/)
  return match ? match[1] : null
}

// ─── L3 reason explanation ─────────────────────────────────────────────────

function explainL3Reason(proposal: EvolutionProposal): string {
  const desc = proposal.description.toLowerCase()

  // Core file involvement
  const coreFiles = ['db.ts', 'ai.ts', 'index.ts', 'ipc.ts', 'safestore.ts']
  const mentionedCore = coreFiles.filter((f) => desc.includes(f))
  if (mentionedCore.length > 0) {
    return `Involves core files (${mentionedCore.join('、')}) — auto-modification not allowed`
  }

  // Loop detection
  if (desc.includes('repair') && desc.includes('times')) {
    return 'Same issue repaired twice and still failing — needs your judgment'
  }

  return 'This issue exceeds the scope of automatic repair'
}

// ─── Main builders ─────────────────────────────────────────────────────────

/**
 * Build a user-facing summary for a skill/sentinel/skin proposal
 * that has passed (or been flagged by) the review committee.
 */
export function buildDiscoverySummary(proposal: EvolutionProposal): string {
  const header = TYPE_HEADERS[proposal.type] ?? '📦 New discovery'
  const lines: string[] = [header, '']

  // What is it
  lines.push(`What: ${proposal.title}`)

  // Why recommended
  const interestNote = describeMatchedInterests(proposal.relevance_matched_on)
  if (interestNote) {
    lines.push(`Why recommended: ${interestNote}`)
  }

  // What it does
  // Strip the title from description to avoid repetition
  const desc = proposal.description.replace(proposal.title, '').trim()
  if (desc && desc.length > 5) {
    lines.push(`${proposal.type === 'skill' ? 'What it does' : 'Effect'}: ${desc.slice(0, 200)}`)
  }

  // Source
  if (proposal.source_url) {
    lines.push(`Source: ${proposal.source_url}`)
  }

  // Review result
  lines.push(`Review result: ${formatReviewLine(proposal)}`)

  return lines.join('\n')
}

/**
 * Build a user-facing summary for an L3 repair that needs human attention.
 */
export function buildRepairSummary(proposal: EvolutionProposal): string {
  const header = TYPE_HEADERS.repair
  const lines: string[] = [header, '']

  const agent = extractAgentFromDescription(proposal.title)

  // What is it
  // The title format is "[agent] diagnosis.slice(0,80)"
  const diagPart = proposal.title.replace(/^\[[^\]]+\]\s*/, '')
  lines.push(`What: ${diagPart || proposal.title}`)

  // Why you are needed
  const reason = explainL3Reason(proposal)
  lines.push(`Why you are needed: ${reason}`)

  // Error context
  const errorNote = describeErrors(proposal.error_ids, agent)
  if (errorNote) {
    lines.push(`Context: ${errorNote}`)
  }

  // Suggested fix
  const fixMatch = proposal.description.match(/Suggested fix[：:]\s*(.+)/s)
  if (fixMatch) {
    lines.push(`Suggested fix: ${fixMatch[1].slice(0, 200)}`)
  }

  return lines.join('\n')
}

/**
 * Build user summary based on proposal type.
 */
export function buildUserSummary(proposal: EvolutionProposal): string {
  if (proposal.type === 'repair') {
    return buildRepairSummary(proposal)
  }
  return buildDiscoverySummary(proposal)
}
