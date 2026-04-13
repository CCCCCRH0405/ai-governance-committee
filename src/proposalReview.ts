import { runUtilityPrompt } from '../ai'
import { log } from '../logger'
import type { ReviewVerdict } from './db'
import {
  updateProposalReview,
  updateProposalStatus,
  updateProposalSummary,
  getProposal
} from './db'
import { logActivity } from './activityLog'
import { buildDiscoverySummary } from './userSummary'
import { pushToTelegram } from '../telegram/bridge'

// ─── Security keywords for cross-validation ─────────────────────────────────

const SECURITY_KEYWORDS = [
  'network',
  'fetch',
  'exec',
  'spawn',
  'credential',
  'token',
  'env',
  'exfiltrat',
  'upload',
  'external',
  'http',
  'socket',
  'child_process',
  'eval',
  'require'
]

// ─── Conflict Detection ─────────────────────────────────────────────────────

export function detectReviewConflict(reviews: ReviewVerdict[]): boolean {
  const securityReviews = reviews.filter((r) => r.tier === 'malware' || r.tier === 'compliance')
  const otherPasses = reviews.filter(
    (r) => r.pass && r.tier !== 'malware' && r.tier !== 'compliance'
  )

  if (securityReviews.length === 0) return false

  for (const other of otherPasses) {
    for (const finding of other.findings) {
      if (SECURITY_KEYWORDS.some((kw) => finding.toLowerCase().includes(kw))) {
        return true
      }
    }
  }
  return false
}

// ─── Review Prompts ─────────────────────────────────────────────────────────

function buildFunctionReviewPrompt(title: string, description: string): string {
  return `You are a function reviewer. Review the following proposal for functional soundness.

Proposal title: ${title}
Proposal description: ${description}

Please evaluate:
1. Is the functionality clearly and reasonably described?
2. Does it provide real value?
3. Are there obvious technical issues?

Strictly output in the following JSON format, no other content:
{
  "pass": true/false,
  "risk_level": "none"/"low"/"medium"/"high",
  "findings": ["issue found 1", "issue found 2"],
  "reason": "summary"
}`
}

function buildUtilityReviewPrompt(
  title: string,
  description: string,
  interestContext: string
): string {
  return `You are a utility reviewer. Review the following proposal for practical value to the user.

Proposal title: ${title}
Proposal description: ${description}

User interest context: ${interestContext}

Please evaluate:
1. Is this actually useful to the user?
2. Is the cost reasonable?
3. Is there a better alternative?
4. Will this create noise?

Strictly output in the following JSON format:
{
  "pass": true/false,
  "risk_level": "none"/"low"/"medium"/"high",
  "findings": ["finding 1"],
  "reason": "summary"
}`
}

function buildComplianceReviewPrompt(title: string, description: string): string {
  return `You are a compliance reviewer. Review the following proposal for privacy and compliance risks.

Proposal title: ${title}
Proposal description: ${description}

Please check:
1. Does it involve personal data processing (GDPR/privacy risks)?
2. Does it require additional permissions (network/file/system)?
3. Does it conflict with user-defined rules?
4. Are there license issues?

Strictly output in the following JSON format:
{
  "pass": true/false,
  "risk_level": "none"/"low"/"medium"/"high",
  "findings": ["finding 1"],
  "reason": "summary"
}`
}

// ─── Parse Review Result ────────────────────────────────────────────────────

function parseReviewResult(
  raw: string,
  reviewer: string,
  model: string,
  tier: ReviewVerdict['tier'],
  startTime: number
): ReviewVerdict {
  const duration = Date.now() - startTime
  try {
    // Extract JSON from response (might have markdown fencing)
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { pass: false, reason: 'Parse error' }
    return {
      reviewer,
      model,
      tier,
      pass: !!parsed.pass,
      risk_level: parsed.risk_level || 'medium',
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      reason: parsed.reason || '',
      cost_usd: 0, // Estimated later from usage
      duration_ms: duration,
      reviewed_at: new Date().toISOString()
    }
  } catch {
    return {
      reviewer,
      model,
      tier,
      pass: false,
      risk_level: 'high',
      findings: ['Failed to parse review output'],
      reason: `Failed to parse review output: ${raw.slice(0, 200)}`,
      cost_usd: 0,
      duration_ms: duration,
      reviewed_at: new Date().toISOString()
    }
  }
}

// ─── 3-Layer Internal Review ────────────────────────────────────────────────

/**
 * Run the standard 3-layer review for internal proposals (thinking/skin/sentinel).
 *
 * Layer 1: Function review (fast model — cheapest)
 * Layer 2: Utility review (fast model)
 * Layer 3: Compliance review (secondary model)
 *
 * All must pass. Any failure → rejected.
 * Cross-validation detects conflicts → needs_human.
 */
export async function runInternalReview(
  proposalId: string,
  interestContext: string
): Promise<{ approved: boolean; conflict: boolean }> {
  const proposal = getProposal(proposalId)
  if (!proposal) throw new Error(`Proposal not found: ${proposalId}`)

  const verdicts: ReviewVerdict[] = []

  // Layer 1: Function review (fast model)
  log.info(`[Evolution] Reviewing proposal ${proposalId} — function`)
  const funcStart = Date.now()
  try {
    const funcResult = await runUtilityPrompt(
      buildFunctionReviewPrompt(proposal.title, proposal.description),
      { provider: 'primary', forceJson: true }
    )
    const funcVerdict = parseReviewResult(
      funcResult.text,
      funcResult.provider,
      funcResult.model,
      'function',
      funcStart
    )
    verdicts.push(funcVerdict)
    updateProposalReview(proposalId, 'function', funcVerdict)

    if (!funcVerdict.pass) {
      updateProposalStatus(proposalId, 'rejected')
      log.info(`[Evolution] Proposal ${proposalId} rejected at function review`)
      return { approved: false, conflict: false }
    }
  } catch (err) {
    log.warn(`[Evolution] Function review failed for ${proposalId}:`, err)
    updateProposalStatus(proposalId, 'rejected')
    return { approved: false, conflict: false }
  }

  // Layer 2: Utility review (fast model — separate call, isolated context)
  log.info(`[Evolution] Reviewing proposal ${proposalId} — utility`)
  const utilStart = Date.now()
  try {
    const utilResult = await runUtilityPrompt(
      buildUtilityReviewPrompt(proposal.title, proposal.description, interestContext),
      { provider: 'primary', forceJson: true }
    )
    const utilVerdict = parseReviewResult(
      utilResult.text,
      utilResult.provider,
      utilResult.model,
      'utility',
      utilStart
    )
    verdicts.push(utilVerdict)
    updateProposalReview(proposalId, 'utility', utilVerdict)

    if (!utilVerdict.pass) {
      updateProposalStatus(proposalId, 'rejected')
      log.info(`[Evolution] Proposal ${proposalId} rejected at utility review`)
      return { approved: false, conflict: false }
    }
  } catch (err) {
    log.warn(`[Evolution] Utility review failed for ${proposalId}:`, err)
    updateProposalStatus(proposalId, 'rejected')
    return { approved: false, conflict: false }
  }

  // Layer 3: Compliance review (secondary model — different perspective)
  log.info(`[Evolution] Reviewing proposal ${proposalId} — compliance`)
  const compStart = Date.now()
  try {
    const compResult = await runUtilityPrompt(
      buildComplianceReviewPrompt(proposal.title, proposal.description),
      { provider: 'secondary', forceJson: true }
    )
    const compVerdict = parseReviewResult(
      compResult.text,
      compResult.provider,
      compResult.model,
      'compliance',
      compStart
    )
    verdicts.push(compVerdict)
    updateProposalReview(proposalId, 'compliance', compVerdict)

    if (!compVerdict.pass) {
      updateProposalStatus(proposalId, 'rejected')
      log.info(`[Evolution] Proposal ${proposalId} rejected at compliance review`)
      return { approved: false, conflict: false }
    }
  } catch (err) {
    log.warn(`[Evolution] Compliance review failed for ${proposalId}:`, err)
    updateProposalStatus(proposalId, 'rejected')
    return { approved: false, conflict: false }
  }

  // Cross-validation: detect conflicts between reviewers
  const conflict = detectReviewConflict(verdicts)
  if (conflict) {
    updateProposalStatus(proposalId, 'needs_human')
    log.warn(`[Evolution] Proposal ${proposalId} has review conflicts → needs_human`)

    // Generate user-facing summary and push to Telegram
    const fresh = getProposal(proposalId)
    if (fresh) {
      const summary = buildDiscoverySummary(fresh)
      updateProposalSummary(proposalId, summary)
      pushToTelegram(summary + '\n\n⚠️ Reviewers disagree — needs your attention.').catch(() => {})
    }

    return { approved: false, conflict: true }
  }

  // All passed, no conflicts
  updateProposalStatus(proposalId, 'approved')
  log.info(`[Evolution] Proposal ${proposalId} approved (3/3 pass)`)

  // Generate user-facing summary and push to Telegram
  const fresh = getProposal(proposalId)
  if (fresh) {
    const summary = buildDiscoverySummary(fresh)
    updateProposalSummary(proposalId, summary)
    pushToTelegram(summary).catch(() => {})
  }

  logActivity({
    event_type: 'review',
    chain: 'discovery',
    summary: `Review passed (3/3): ${proposal.title}`,
    detail: {
      tiers: verdicts.map((v) => ({ tier: v.tier, pass: v.pass, risk: v.risk_level }))
    },
    proposal_id: proposalId,
    outcome: 'success'
  })

  return { approved: true, conflict: false }
}
