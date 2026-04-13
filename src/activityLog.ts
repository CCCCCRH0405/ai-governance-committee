// src/main/evolution/activityLog.ts
// Unified activity logging for all evolution chains.
// Every action the evolution system takes is recorded here for weekly audit.

import {
  insertActivityLog,
  getActivityLogSince,
  getActivityLogByChain,
  getWeekActivitySummary,
  cleanOldActivityLog,
  type ActivityEventType,
  type ActivityOutcome,
  type ActivityLogRow
} from './db'
import { log } from '../logger'

// ─── Public API ────────────────────────────────────────────────────────────

export interface ActivityEntry {
  event_type: ActivityEventType
  chain: string
  summary: string
  detail?: Record<string, unknown>
  proposal_id?: string
  agent?: string
  outcome: ActivityOutcome
}

export function logActivity(entry: ActivityEntry): void {
  try {
    insertActivityLog({
      event_type: entry.event_type,
      chain: entry.chain,
      summary: entry.summary,
      detail: entry.detail ? JSON.stringify(entry.detail) : null,
      proposal_id: entry.proposal_id ?? null,
      agent: entry.agent ?? null,
      outcome: entry.outcome
    })
    log.debug(
      `[ActivityLog] ${entry.chain}/${entry.event_type}: ${entry.summary} → ${entry.outcome}`
    )
  } catch (err) {
    log.warn('[ActivityLog] Failed to write activity log:', err)
  }
}

export function getActivitiesSince(since: string, limit?: number): ActivityLogRow[] {
  return getActivityLogSince(since, limit)
}

export function getActivitiesByChain(chain: string, since: string): ActivityLogRow[] {
  return getActivityLogByChain(chain, since)
}

export function getWeekSummary(since?: string): ReturnType<typeof getWeekActivitySummary> {
  const start = since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  return getWeekActivitySummary(start)
}

export function cleanupOldLogs(retainDays = 90): number {
  const deleted = cleanOldActivityLog(retainDays)
  if (deleted > 0) {
    log.info(`[ActivityLog] Cleaned ${deleted} entries older than ${retainDays} days`)
  }
  return deleted
}
