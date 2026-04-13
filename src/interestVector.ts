import { getKeyFacts } from '../memory/db'
import { getStyleProfile, getRecentConversationSignals } from '../quality/db'
import { getStoryThreads } from '../intelligence/db'
import { extractSearchTerms } from '../memory/normalizer'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface InterestVector {
  identity: string[] // who the user is (identity keywords)
  longTermTopics: string[] // long-term interests
  recentTopics: string[] // recent conversation topics
  tracking: string[] // active story threads being tracked
  fatigue: string[] // topics the user is tired of
}

// ─── Builders ───────────────────────────────────────────────────────────────

function extractIdentityKeywords(facts: Array<{ content: string }>): string[] {
  const keywords: string[] = []
  for (const fact of facts) {
    const terms = extractSearchTerms(fact.content)
    keywords.push(...terms.slice(0, 5))
  }
  // Dedupe and limit
  return [...new Set(keywords)].slice(0, 30)
}

function extractRecentTopics(
  signals: Array<{ content: string | null; signal_type: string }>
): string[] {
  const topics: string[] = []
  for (const signal of signals) {
    if (!signal.content) continue
    // Focus on substantive signals, not just reactions
    if (signal.signal_type === 'short_reply') continue
    const terms = extractSearchTerms(signal.content)
    topics.push(...terms.slice(0, 3))
  }
  return [...new Set(topics)].slice(0, 20)
}

function safeParseJsonArray(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

export function buildInterestVector(): InterestVector {
  const keyFacts = getKeyFacts(30)
  const profile = getStyleProfile()
  const signals = getRecentConversationSignals(100)
  const threads = getStoryThreads('active')

  return {
    identity: extractIdentityKeywords(keyFacts),
    longTermTopics: safeParseJsonArray(profile.topic_interests),
    recentTopics: extractRecentTopics(signals),
    tracking: threads.map((t) => t.title),
    fatigue: safeParseJsonArray(profile.topic_fatigue)
  }
}
