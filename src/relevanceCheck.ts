import { extractSearchTerms } from '../memory/normalizer'
import type { InterestVector } from './interestVector'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RelevanceResult {
  score: number // 0-1
  distance: number // 0, 1, 2, 3+
  matchedOn: string[] // which interest dimensions matched
  reason: string
}

// ─── Core ───────────────────────────────────────────────────────────────────

function termOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setB = new Set(b)
  let hits = 0
  for (const term of a) {
    if (setB.has(term)) hits++
  }
  return hits / Math.max(a.length, b.length)
}

/**
 * Zero-cost relevance check — no AI calls, pure local computation.
 * Scores a candidate text against the user's interest vector.
 *
 * Scoring tiers:
 *   tracking (active story threads):  +0.4
 *   recentTopics:                     +0.3
 *   longTermTopics:                   +0.2
 *   identity:                         +0.1
 *   fatigue (tired topics):           -0.3
 *
 * Distance mapping:
 *   score >= 0.5 → distance 0 (directly relevant)
 *   score >= 0.3 → distance 1 (one step away)
 *   score >= 0.15 → distance 2 (indirectly relevant)
 *   else → distance 3+ (irrelevant)
 *
 * Filter threshold: distance ≤ 1 enters review.
 * Distance 2 is archived but not pushed. Distance 3 is discarded.
 */
export function relevanceCheck(candidate: string, vector: InterestVector): RelevanceResult {
  const candidateTokens = extractSearchTerms(candidate)
  let score = 0
  const matchedOn: string[] = []

  // Tier 1: active story threads (highest weight)
  for (const track of vector.tracking) {
    const overlap = termOverlap(candidateTokens, extractSearchTerms(track))
    if (overlap > 0.3) {
      score += 0.4
      matchedOn.push(`tracking:${track}`)
    }
  }

  // Tier 2: recent conversation topics
  for (const topic of vector.recentTopics) {
    if (candidateTokens.includes(topic)) {
      score += 0.3
      matchedOn.push(`recent:${topic}`)
    }
  }

  // Tier 3: long-term interests
  for (const topic of vector.longTermTopics) {
    const topicTokens = extractSearchTerms(topic)
    if (topicTokens.some((t) => candidateTokens.includes(t))) {
      score += 0.2
      matchedOn.push(`interest:${topic}`)
    }
  }

  // Tier 4: identity keywords (baseline)
  for (const kw of vector.identity) {
    if (candidateTokens.includes(kw)) {
      score += 0.1
      matchedOn.push(`identity:${kw}`)
    }
  }

  // Negative: fatigued topics
  for (const tired of vector.fatigue) {
    const tiredTokens = extractSearchTerms(tired)
    if (tiredTokens.some((t) => candidateTokens.includes(t))) {
      score -= 0.3
      matchedOn.push(`fatigue:${tired}`)
    }
  }

  score = Math.max(0, Math.min(1, score))
  const distance = score >= 0.5 ? 0 : score >= 0.3 ? 1 : score >= 0.15 ? 2 : 3

  return {
    score,
    distance,
    matchedOn,
    reason: matchedOn.length ? `Matched: ${matchedOn.join(', ')}` : 'No interest dimensions matched'
  }
}
