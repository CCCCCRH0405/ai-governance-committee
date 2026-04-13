import { runUtilityPrompt } from '../ai'
import { log } from '../logger'
import { isOverBudget } from '../tokenBudget'
import type { InterestVector } from './interestVector'
import { buildInterestVector } from './interestVector'
import { relevanceCheck } from './relevanceCheck'
import { createProposal, countTodayProposals } from './db'
import { runInternalReview } from './proposalReview'
import { logActivity } from './activityLog'

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_DAILY_PROPOSALS = 3
const SEARCH_QUERIES_PER_LOOP = 3

// ─── Query Generation ───────────────────────────────────────────────────────

function buildSearchQueriesPrompt(vector: InterestVector): string {
  const ctx = [
    vector.identity.length ? `Identity keywords: ${vector.identity.slice(0, 10).join('、')}` : '',
    vector.longTermTopics.length ? `Long-term interests: ${vector.longTermTopics.join('、')}` : '',
    vector.recentTopics.length ? `Recent topics: ${vector.recentTopics.slice(0, 10).join('、')}` : '',
    vector.tracking.length ? `Currently tracking: ${vector.tracking.join('、')}` : '',
    vector.fatigue.length ? `Fatigued topics (avoid): ${vector.fatigue.join('、')}` : ''
  ]
    .filter(Boolean)
    .join('\n')

  return `Based on the following user profile, generate ${SEARCH_QUERIES_PER_LOOP}  valuable search queries.
Queries should help the user discover new tools, news, and capabilities related to their interests.

User profile:
${ctx}

Requirements:
1. Queries should be specific, not too broad
2. Avoid fatigued topics
3. Prioritize tracked events and recent topics
4. Mix query languages for broader coverage

Strictly output in the following JSON format:
{
  "queries": ["query1", "query2", "query3"]
}`
}

function buildCandidateExtractionPrompt(searchResults: string): string {
  return `Extract valuable information items from the following search results. Each should be an independent, potentially useful discovery.

Search results:
${searchResults}

Strictly output in the following JSON format:
{
  "candidates": [
    {
      "title": "short title",
      "description": "one paragraph describing what it is and why it might be useful",
      "source_url": "source URL (if available)",
      "type": "thinking"
    }
  ]
}`
}

// ─── Main Discovery Loop ────────────────────────────────────────────────────

interface DiscoveryResult {
  searched: number
  candidates: number
  relevant: number
  reviewed: number
  approved: number
  skipped: string | null
}

/**
 * Background discovery loop.
 *
 * 1. Build interest vector (zero cost — reads DB)
 * 2. Generate search queries (fast model)
 * 3. Search (fast model with grounding)
 * 4. Extract candidates (fast model)
 * 5. Relevance filter (zero cost — local computation)
 * 6. Review committee (only for distance ≤ 1)
 */
export async function runDiscoveryLoop(): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    searched: 0,
    candidates: 0,
    relevant: 0,
    reviewed: 0,
    approved: 0,
    skipped: null
  }

  // Guard: budget check
  if (isOverBudget('primary')) {
    result.skipped = 'primary_over_budget'
    log.info('[Evolution] Discovery skipped: primary provider over budget')
    return result
  }

  // Guard: daily proposal limit
  const todayCount = countTodayProposals()
  if (todayCount >= MAX_DAILY_PROPOSALS) {
    result.skipped = 'daily_limit_reached'
    log.info('[Evolution] Discovery skipped: daily proposal limit reached')
    return result
  }

  // Step 1: Build interest vector
  const vector = buildInterestVector()
  if (
    vector.identity.length === 0 &&
    vector.longTermTopics.length === 0 &&
    vector.tracking.length === 0
  ) {
    result.skipped = 'empty_interest_vector'
    log.info('[Evolution] Discovery skipped: empty interest vector')
    return result
  }

  // Step 2: Generate search queries
  let queries: string[] = []
  try {
    const queryResult = await runUtilityPrompt(buildSearchQueriesPrompt(vector), {
      provider: 'primary',
      forceJson: true
    })
    const parsed = JSON.parse(queryResult.text.match(/\{[\s\S]*\}/)?.[0] ?? '{}')
    queries = Array.isArray(parsed.queries) ? parsed.queries : []
  } catch (err) {
    log.warn('[Evolution] Failed to generate search queries:', err)
    return result
  }

  if (queries.length === 0) return result
  result.searched = queries.length

  // Step 3 + 4: Search and extract candidates per query
  interface RawCandidate {
    title: string
    description: string
    source_url?: string
    type?: string
  }
  const allCandidates: RawCandidate[] = []

  for (const query of queries.slice(0, SEARCH_QUERIES_PER_LOOP)) {
    try {
      const searchResult = await runUtilityPrompt(query, {
        provider: 'primary',
        useSearch: true
      })

      const extraction = await runUtilityPrompt(buildCandidateExtractionPrompt(searchResult.text), {
        provider: 'primary',
        forceJson: true
      })
      const parsed = JSON.parse(extraction.text.match(/\{[\s\S]*\}/)?.[0] ?? '{}')
      if (Array.isArray(parsed.candidates)) {
        allCandidates.push(...parsed.candidates)
      }
    } catch (err) {
      log.warn(`[Evolution] Search/extraction failed for query "${query}":`, err)
    }
  }

  result.candidates = allCandidates.length
  if (allCandidates.length === 0) {
    logActivity({
      event_type: 'discovery',
      chain: 'discovery',
      summary: `Search complete, no candidates (${queries.length}  queries)`,
      detail: { queries },
      outcome: 'skipped'
    })
    return result
  }

  // Step 5: Relevance filter (zero cost)
  const interestContext = [
    ...vector.longTermTopics,
    ...vector.tracking,
    ...vector.recentTopics.slice(0, 5)
  ].join('、')

  for (const candidate of allCandidates) {
    const rel = relevanceCheck(`${candidate.title} ${candidate.description}`, vector)

    // distance 3: discard
    if (rel.distance >= 3) continue
    // distance 2: archive but don't review
    if (rel.distance === 2) {
      result.relevant++
      const id = `evo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      createProposal({
        id,
        type: candidate.type || 'thinking',
        title: candidate.title,
        description: candidate.description,
        source_url: candidate.source_url ?? null,
        relevance_score: rel.score,
        relevance_distance: rel.distance,
        relevance_matched_on: JSON.stringify(rel.matchedOn),
        status: 'archived'
      })
      continue
    }

    // distance 0-1: create proposal
    result.relevant++
    const id = `evo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const proposalType = candidate.type || 'thinking'

    // Thinking proposals = info for user, no approval needed → direct to applied
    // Skill/repair/sentinel proposals = need review committee
    if (proposalType === 'thinking') {
      createProposal({
        id,
        type: proposalType,
        title: candidate.title,
        description: candidate.description,
        source_url: candidate.source_url ?? null,
        relevance_score: rel.score,
        relevance_distance: rel.distance,
        relevance_matched_on: JSON.stringify(rel.matchedOn),
        status: 'applied'
      })
      result.approved++
      logActivity({
        event_type: 'discovery',
        chain: 'discovery',
        summary: `Discovery push: ${candidate.title}`,
        detail: { title: candidate.title, distance: rel.distance, score: rel.score },
        proposal_id: id,
        outcome: 'success'
      })
    } else {
      // Non-thinking types go through review committee
      createProposal({
        id,
        type: proposalType,
        title: candidate.title,
        description: candidate.description,
        source_url: candidate.source_url ?? null,
        relevance_score: rel.score,
        relevance_distance: rel.distance,
        relevance_matched_on: JSON.stringify(rel.matchedOn),
        status: 'reviewing'
      })

      if (countTodayProposals() >= MAX_DAILY_PROPOSALS) break

      try {
        result.reviewed++
        const review = await runInternalReview(id, interestContext)
        if (review.approved) {
          result.approved++
          logActivity({
            event_type: 'discovery',
            chain: 'discovery',
            summary: `Discovery approved: ${candidate.title}`,
            detail: { title: candidate.title, distance: rel.distance, score: rel.score },
            proposal_id: id,
            outcome: 'success'
          })
        }
      } catch (err) {
        log.warn(`[Evolution] Review failed for proposal ${id}:`, err)
      }
    }
  }

  logActivity({
    event_type: 'discovery',
    chain: 'discovery',
    summary: `Discovery loop complete: ${result.candidates}  candidates, ${result.relevant}  relevant, ${result.approved}  approved`,
    detail: { ...result },
    outcome: result.approved > 0 ? 'success' : 'skipped'
  })

  return result
}
