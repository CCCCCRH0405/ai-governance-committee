// src/main/evolution/learnedPatterns.ts
// L1.5 Layer: Dynamic learned repair patterns.
//
// Sits between hardcoded L1 (KNOWN_PATTERNS) and expensive L2 (AI diagnosis).
// Extracts patterns from successful L2 repairs, matches against new errors,
// and reinforces or degrades confidence based on re-application outcomes.

import {
  insertLearnedRepair,
  findLearnedRepairsByAgent,
  findLearnedRepairBySignature,
  reinforceLearnedRepair,
  type LearnedRepair
} from './db'
import { logActivity } from './activityLog'
import { log } from '../logger'

// ─── Signature Generation ─────────────────────────────────────────────────

// Noise tokens to strip from error messages before generating signatures
const NOISE_PATTERNS = [
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\dZ]*/g, // timestamps
  /0x[0-9a-f]+/gi, // hex addresses
  /\b\d{5,}\b/g, // long numbers (IDs, ports are 4-5 digits so keep short ones)
  /at\s+\S+\s+\([^)]+\)/g, // stack trace lines
  /\/[\w/.-]+\.(js|ts|mjs)/g, // file paths (vary across installs)
  /\bERR_\w+/g // Node error codes (too specific)
]

/**
 * Normalize an error message into stable key tokens for signature matching.
 * Strips timestamps, paths, IDs — keeps meaningful keywords.
 */
export function extractKeyTokens(message: string): string[] {
  let cleaned = message.toLowerCase()
  for (const pattern of NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, '')
  }
  // Split into tokens, keep only meaningful ones (3+ chars, not pure numbers)
  const tokens = cleaned
    .split(/[\s,;:=()[\]{}"'`|]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t))
  // Deduplicate and take top 15
  return [...new Set(tokens)].slice(0, 15)
}

/**
 * Generate a stable error signature: agent:error_type:sorted_key_tokens
 */
export function generateSignature(
  agent: string,
  errorType: string | null,
  message: string
): string {
  const tokens = extractKeyTokens(message)
  const typePart = errorType || 'unknown'
  // Sort for stability
  return `${agent}:${typePart}:${tokens.sort().join(',')}`
}

// ─── Pattern Extraction ───────────────────────────────────────────────────

interface RepairOutcome {
  agent: string
  errorType: string | null
  errorMessages: string[]
  fixDescription: string
  fixFiles: string[]
  fixAction: string
  proposalId: string
}

/**
 * Extract a learned pattern from a successful repair and store it.
 * Called after L2 repair succeeds.
 */
export function extractAndStorePattern(outcome: RepairOutcome): number | null {
  // Combine error messages for signature
  const combinedMsg = outcome.errorMessages.join(' ')
  if (combinedMsg.length < 10) return null // too short to learn from

  const signature = generateSignature(outcome.agent, outcome.errorType, combinedMsg)

  // Check if we already have this exact pattern
  const existing = findLearnedRepairBySignature(signature)
  if (existing) {
    // Reinforce existing pattern
    reinforceLearnedRepair(existing.id, true)
    log.info(
      `[LearnedPatterns] Reinforced existing pattern #${existing.id} (confidence: ${existing.confidence + 10})`
    )
    logActivity({
      event_type: 'pattern_learn',
      chain: 'repair',
      summary: `Reinforced existing repair pattern #${existing.id}: ${outcome.agent}`,
      detail: { patternId: existing.id, newConfidence: Math.min(existing.confidence + 10, 100) },
      agent: outcome.agent,
      proposal_id: outcome.proposalId,
      outcome: 'success'
    })
    return existing.id
  }

  // Create new pattern
  const keyTokens = extractKeyTokens(combinedMsg)
  const id = insertLearnedRepair({
    error_signature: signature,
    agent: outcome.agent,
    error_type: outcome.errorType ?? null,
    key_tokens: JSON.stringify(keyTokens),
    fix_description: outcome.fixDescription,
    fix_files: outcome.fixFiles.length > 0 ? JSON.stringify(outcome.fixFiles) : null,
    fix_action: outcome.fixAction,
    confidence: 50,
    success_count: 1,
    fail_count: 0,
    source_proposal_id: outcome.proposalId,
    last_applied_at: null
  })

  log.info(
    `[LearnedPatterns] Stored new pattern #${id}: ${outcome.agent} — ${outcome.fixAction.slice(0, 60)}`
  )

  logActivity({
    event_type: 'pattern_learn',
    chain: 'repair',
    summary: `Learned new repair pattern #${id}: ${outcome.agent} — ${outcome.fixAction.slice(0, 50)}`,
    detail: {
      patternId: id,
      signature,
      keyTokens,
      fixFiles: outcome.fixFiles,
      fixDescription: outcome.fixDescription.slice(0, 200)
    },
    agent: outcome.agent,
    proposal_id: outcome.proposalId,
    outcome: 'success'
  })

  return id
}

// ─── Security Skepticism ─────────────────────────────────────────────────
// Supply-chain attacks (fake npm packages, hijacked accounts) remind us:
// even a proven pattern can become dangerous if the environment changed.
// Scan every fix for security-sensitive operations before trusting it.

const SECURITY_WATCHWORDS = [
  'npm install',
  'npm i ',
  'npx ',
  'require(',
  'child_process',
  'exec(',
  'execSync',
  'spawn(',
  'eval(',
  'Function(',
  'fetch(',
  'http://',
  'https://',
  'credential',
  'token',
  'password',
  'secret',
  'api_key',
  'apikey',
  '.env',
  'process.env',
  'fs.write',
  'fs.unlink',
  'fs.rm',
  'import(',
  'child_process'
]

/** Days after which an unvalidated pattern starts losing confidence */
const STALENESS_THRESHOLD_DAYS = 30
/** Confidence points lost per 30-day period of staleness */
const STALENESS_DECAY_PER_PERIOD = 5

export interface PatternSecurityFlag {
  isSuspicious: boolean
  watchwordsFound: string[]
}

/**
 * Scan a pattern's fix action for security-sensitive keywords.
 * Patterns touching network/exec/credentials should never skip AI review.
 */
export function scanPatternSecurity(fixAction: string): PatternSecurityFlag {
  const lower = fixAction.toLowerCase()
  const found = SECURITY_WATCHWORDS.filter((w) => lower.includes(w.toLowerCase()))
  return { isSuspicious: found.length > 0, watchwordsFound: found }
}

/**
 * Calculate effective confidence after time-based decay.
 * Patterns that haven't been re-validated in a while lose trust.
 */
function decayedConfidence(pattern: LearnedRepair): number {
  const lastCheck = pattern.last_applied_at || pattern.created_at
  const daysSince = (Date.now() - new Date(lastCheck).getTime()) / (1000 * 60 * 60 * 24)
  if (daysSince <= STALENESS_THRESHOLD_DAYS) return pattern.confidence
  const periods = Math.floor((daysSince - STALENESS_THRESHOLD_DAYS) / 30)
  return Math.max(0, pattern.confidence - periods * STALENESS_DECAY_PER_PERIOD)
}

// ─── Pattern Matching ─────────────────────────────────────────────────────

const MIN_MATCH_CONFIDENCE = 40
const MIN_TOKEN_OVERLAP = 0.5

interface PatternMatch {
  pattern: LearnedRepair
  tokenOverlap: number
  recommendation: string
  /** Effective confidence after time decay */
  effectiveConfidence: number
  /** Security scan result — if suspicious, caller must not skip AI diagnosis */
  security: PatternSecurityFlag
}

/**
 * Calculate token overlap ratio between two token sets.
 */
function tokenOverlap(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 || tokensB.length === 0) return 0
  const setB = new Set(tokensB)
  const shared = tokensA.filter((t) => setB.has(t)).length
  return shared / Math.max(tokensA.length, tokensB.length)
}

/**
 * Find matching learned patterns for a new error.
 * Returns the best match above threshold, or null.
 */
export function findMatchingPattern(
  agent: string,
  errorType: string | null,
  errorMessages: string[]
): PatternMatch | null {
  const candidates = findLearnedRepairsByAgent(agent)
  if (candidates.length === 0) return null

  const errorTokens = extractKeyTokens(errorMessages.join(' '))
  if (errorTokens.length === 0) return null

  let bestMatch: PatternMatch | null = null
  let bestScore = 0

  for (const pattern of candidates) {
    // Use decayed confidence instead of raw — stale patterns lose trust
    const effective = decayedConfidence(pattern)
    if (effective < MIN_MATCH_CONFIDENCE) continue

    let patternTokens: string[]
    try {
      patternTokens = JSON.parse(pattern.key_tokens) as string[]
    } catch {
      continue
    }

    const overlap = tokenOverlap(errorTokens, patternTokens)
    if (overlap < MIN_TOKEN_OVERLAP) continue

    // Score = overlap * effective confidence, bonus for matching error_type
    const typeBonus = errorType && pattern.error_type === errorType ? 1.2 : 1.0
    const score = overlap * effective * typeBonus
    if (score > bestScore) {
      bestScore = score
      const security = scanPatternSecurity(pattern.fix_action)
      bestMatch = {
        pattern,
        tokenOverlap: overlap,
        recommendation: pattern.fix_description,
        effectiveConfidence: effective,
        security
      }
    }
  }

  return bestMatch
}

/**
 * Record the outcome when a learned pattern's fix is applied.
 */
export function recordPatternOutcome(patternId: number, success: boolean): void {
  reinforceLearnedRepair(patternId, success)

  logActivity({
    event_type: 'pattern_apply',
    chain: 'repair',
    summary: success
      ? `Learned pattern #${patternId} worked again`
      : `Learned pattern #${patternId} failed to resolve, confidence reduced`,
    detail: { patternId, success },
    outcome: success ? 'success' : 'failed'
  })
}
