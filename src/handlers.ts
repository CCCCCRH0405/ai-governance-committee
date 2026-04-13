import { ipcMain } from 'electron'
import {
  getRecentProposals,
  getProposal,
  updateProposalStatus,
  getActiveSkills,
  getSkill,
  updateSkillStatus,
  getPendingProposals,
  getActivityLogSince
} from './db'
import { buildInterestVector } from './interestVector'
import { relevanceCheck } from './relevanceCheck'
import { runEvolutionThinker, runSelfRepair } from './index'
import { generateWeeklyReport } from './weeklyReport'

export function registerEvolutionHandlers(): void {
  // ── Proposals ───────────────────────────────────────────────────────────

  ipcMain.handle('evolution:getProposals', (_, limit = 20) => getRecentProposals(limit))

  ipcMain.handle('evolution:getPending', (_, limit = 10) => getPendingProposals(limit))

  ipcMain.handle('evolution:getProposal', (_, id: string) => getProposal(id))

  ipcMain.handle('evolution:decide', (_, id: string, decision: 'accept' | 'dismiss' | 'later') => {
    const now = new Date().toISOString()
    if (decision === 'accept') {
      updateProposalStatus(id, 'accepted', {
        user_decision: 'accept',
        presented_at: now
      })
    } else if (decision === 'dismiss') {
      updateProposalStatus(id, 'dismissed', {
        user_decision: 'dismiss',
        presented_at: now
      })
    } else {
      updateProposalStatus(id, 'approved', { user_decision: 'later' })
    }
    return { ok: true }
  })

  // ── Installed Skills ────────────────────────────────────────────────────

  ipcMain.handle('evolution:getSkills', () => getActiveSkills())

  ipcMain.handle('evolution:getSkill', (_, id: string) => getSkill(id))

  ipcMain.handle('evolution:suspendSkill', (_, id: string, reason: string) => {
    updateSkillStatus(id, 'suspended', reason)
    return { ok: true }
  })

  ipcMain.handle('evolution:removeSkill', (_, id: string) => {
    updateSkillStatus(id, 'removed', 'User removed')
    return { ok: true }
  })

  // ── Interest Vector (debug/inspect) ─────────────────────────────────────

  ipcMain.handle('evolution:getInterestVector', () => buildInterestVector())

  ipcMain.handle('evolution:testRelevance', (_, text: string) => {
    const vector = buildInterestVector()
    return relevanceCheck(text, vector)
  })

  // ── Manual Triggers ─────────────────────────────────────────────────────

  ipcMain.handle('evolution:runDiscovery', () => runEvolutionThinker())
  ipcMain.handle('evolution:runRepair', () => runSelfRepair())

  // ── Weekly Report & Activity Log ────────────────────────────────────────

  ipcMain.handle('evolution:weeklyReport', (_, weekStartIso?: string) => {
    const start = weekStartIso ? new Date(weekStartIso) : undefined
    return generateWeeklyReport(start)
  })

  ipcMain.handle('evolution:getActivityLog', (_, since: string, limit?: number) => {
    return getActivityLogSince(since, limit ?? 200)
  })
}
