import { getDB } from '../db'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EvolutionProposal {
  id: string
  type: string // thinking/skill/repair/skin/sentinel
  title: string
  description: string
  source_url: string | null

  relevance_score: number | null
  relevance_distance: number | null
  relevance_matched_on: string | null // JSON array

  review_function: string | null // JSON: ReviewVerdict
  review_malware: string | null // JSON: ReviewVerdict (external skill only)
  review_utility: string | null // JSON: ReviewVerdict
  review_compliance: string | null // JSON: ReviewVerdict
  review_sandbox: string | null // JSON: ReviewVerdict (external skill only)

  error_ids: string | null // JSON: number[] (repair only)
  fix_diff: string | null
  fix_files: string | null // JSON: string[]
  fix_risk_level: string | null // low/medium/high

  user_summary: string | null // structured human-readable briefing

  status: string
  user_decision: string | null // accept/dismiss/later
  presented_at: string | null
  applied_at: string | null
  created_at: string
  updated_at: string
}

export interface InstalledSkill {
  id: string
  name: string
  version: string | null
  source_url: string | null
  proposal_id: string | null
  config_json: string | null
  run_count: number
  error_count: number
  anomaly_count: number
  last_run_at: string | null
  last_error: string | null
  status: string // active/suspended/removed
  suspended_reason: string | null
  installed_at: string
}

export interface ReviewVerdict {
  reviewer: string // ProviderId
  model: string
  tier: 'function' | 'malware' | 'utility' | 'compliance' | 'sandbox'
  pass: boolean
  risk_level: 'none' | 'low' | 'medium' | 'high' | 'critical'
  findings: string[]
  reason: string
  cost_usd: number
  duration_ms: number
  reviewed_at: string
}

// ─── Schema ─────────────────────────────────────────────────────────────────

export function ensureEvolutionTables(): void {
  const db = getDB()

  db.exec(`
    CREATE TABLE IF NOT EXISTS evolution_proposals (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      source_url TEXT,

      relevance_score REAL,
      relevance_distance INTEGER,
      relevance_matched_on TEXT,

      review_function TEXT,
      review_malware TEXT,
      review_utility TEXT,
      review_compliance TEXT,
      review_sandbox TEXT,

      error_ids TEXT,
      fix_diff TEXT,
      fix_files TEXT,
      fix_risk_level TEXT,

      status TEXT NOT NULL DEFAULT 'pending',
      user_decision TEXT,
      presented_at TEXT,
      applied_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_proposals_status ON evolution_proposals(status);
    CREATE INDEX IF NOT EXISTS idx_proposals_type ON evolution_proposals(type);

    CREATE TABLE IF NOT EXISTS installed_skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT,
      source_url TEXT,
      proposal_id TEXT REFERENCES evolution_proposals(id),
      config_json TEXT,
      run_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      anomaly_count INTEGER DEFAULT 0,
      last_run_at TEXT,
      last_error TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      suspended_reason TEXT,
      installed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_skills_status ON installed_skills(status);

    CREATE TABLE IF NOT EXISTS evolution_execution_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT REFERENCES evolution_proposals(id),
      agent TEXT,
      error_pattern TEXT,
      action_taken TEXT NOT NULL,
      files_changed TEXT,
      outcome TEXT NOT NULL,
      failure_reason TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_evo_exec_agent ON evolution_execution_log(agent);
    CREATE INDEX IF NOT EXISTS idx_evo_exec_pattern ON evolution_execution_log(error_pattern);

    CREATE TABLE IF NOT EXISTS evolution_activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      chain TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT,
      proposal_id TEXT,
      agent TEXT,
      outcome TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_activity_log_created ON evolution_activity_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_activity_log_chain ON evolution_activity_log(chain);
  `)

  // Safe migrations for new columns on existing tables
  const safeAlter = (sql: string): void => {
    try {
      db.exec(sql)
    } catch {
      /* column already exists */
    }
  }
  safeAlter('ALTER TABLE evolution_execution_log ADD COLUMN pre_scores TEXT')
  safeAlter('ALTER TABLE evolution_execution_log ADD COLUMN post_scores TEXT')
  safeAlter('ALTER TABLE evolution_execution_log ADD COLUMN quality_delta TEXT')
  safeAlter('ALTER TABLE evolution_proposals ADD COLUMN auto_executable INTEGER DEFAULT 0')
  safeAlter('ALTER TABLE evolution_proposals ADD COLUMN execution_type TEXT')
  safeAlter('ALTER TABLE evolution_proposals ADD COLUMN user_summary TEXT')

  // Learned repairs: patterns extracted from successful L2 fixes (L1.5 layer)
  db.exec(`
    CREATE TABLE IF NOT EXISTS learned_repairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      error_signature TEXT NOT NULL,
      agent TEXT NOT NULL,
      error_type TEXT,
      key_tokens TEXT NOT NULL,
      fix_description TEXT NOT NULL,
      fix_files TEXT,
      fix_action TEXT NOT NULL,
      confidence INTEGER DEFAULT 50,
      success_count INTEGER DEFAULT 1,
      fail_count INTEGER DEFAULT 0,
      source_proposal_id TEXT,
      last_applied_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_learned_repairs_sig ON learned_repairs (error_signature)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_learned_repairs_agent ON learned_repairs (agent)`)
}

// ─── Proposals CRUD ─────────────────────────────────────────────────────────

export function createProposal(
  proposal: Pick<EvolutionProposal, 'id' | 'type' | 'title' | 'description'> &
    Partial<EvolutionProposal>
): void {
  const now = new Date().toISOString()
  getDB()
    .prepare(
      `INSERT INTO evolution_proposals
       (id, type, title, description, source_url,
        relevance_score, relevance_distance, relevance_matched_on,
        status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      proposal.id,
      proposal.type,
      proposal.title,
      proposal.description,
      proposal.source_url ?? null,
      proposal.relevance_score ?? null,
      proposal.relevance_distance ?? null,
      proposal.relevance_matched_on ?? null,
      proposal.status ?? 'pending',
      proposal.created_at ?? now,
      now
    )
}

export function getProposal(id: string): EvolutionProposal | null {
  return (
    (getDB().prepare('SELECT * FROM evolution_proposals WHERE id = ?').get(id) as
      | EvolutionProposal
      | undefined) ?? null
  )
}

export function getProposalsByStatus(status: string, limit = 20): EvolutionProposal[] {
  return getDB()
    .prepare('SELECT * FROM evolution_proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?')
    .all(status, limit) as EvolutionProposal[]
}

export function getPendingProposals(limit = 10): EvolutionProposal[] {
  // Only return proposals that genuinely need user decision:
  // - skills (need install approval)
  // - repairs/sentinels flagged as needs_human
  // Thinking proposals are info — they auto-apply, no approval needed.
  return getDB()
    .prepare(
      `SELECT * FROM evolution_proposals
       WHERE status IN ('approved', 'needs_human')
         AND type != 'thinking'
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit) as EvolutionProposal[]
}

export function getRecentProposals(limit = 20): EvolutionProposal[] {
  return getDB()
    .prepare('SELECT * FROM evolution_proposals ORDER BY created_at DESC LIMIT ?')
    .all(limit) as EvolutionProposal[]
}

export function updateProposalStatus(
  id: string,
  status: string,
  extra?: Partial<Pick<EvolutionProposal, 'user_decision' | 'presented_at' | 'applied_at'>>
): void {
  const now = new Date().toISOString()
  const sets = ['status = ?', 'updated_at = ?']
  const params: unknown[] = [status, now]

  if (extra?.user_decision !== undefined) {
    sets.push('user_decision = ?')
    params.push(extra.user_decision)
  }
  if (extra?.presented_at !== undefined) {
    sets.push('presented_at = ?')
    params.push(extra.presented_at)
  }
  if (extra?.applied_at !== undefined) {
    sets.push('applied_at = ?')
    params.push(extra.applied_at)
  }
  params.push(id)

  getDB()
    .prepare(`UPDATE evolution_proposals SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params)
}

export function updateProposalReview(
  id: string,
  tier: ReviewVerdict['tier'],
  verdict: ReviewVerdict
): void {
  const column = `review_${tier}`
  getDB()
    .prepare(`UPDATE evolution_proposals SET ${column} = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(verdict), new Date().toISOString(), id)
}

export function updateProposalSummary(id: string, summary: string): void {
  getDB()
    .prepare('UPDATE evolution_proposals SET user_summary = ?, updated_at = ? WHERE id = ?')
    .run(summary, new Date().toISOString(), id)
}

export function updateProposalFix(
  id: string,
  fix: { diff: string; files: string[]; riskLevel: string }
): void {
  getDB()
    .prepare(
      `UPDATE evolution_proposals
       SET fix_diff = ?, fix_files = ?, fix_risk_level = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(fix.diff, JSON.stringify(fix.files), fix.riskLevel, new Date().toISOString(), id)
}

export function countTodayProposals(type?: string): number {
  const today = new Date().toISOString().slice(0, 10)
  if (type) {
    const row = getDB()
      .prepare(
        `SELECT COUNT(*) as cnt FROM evolution_proposals
         WHERE type = ? AND created_at >= ?`
      )
      .get(type, today) as { cnt: number }
    return row.cnt
  }
  const row = getDB()
    .prepare(
      `SELECT COUNT(*) as cnt FROM evolution_proposals
       WHERE status = 'presented' AND presented_at >= ?`
    )
    .get(today) as { cnt: number }
  return row.cnt
}

export function countTodayRepairs(): number {
  const today = new Date().toISOString().slice(0, 10)
  const row = getDB()
    .prepare(
      `SELECT COUNT(*) as cnt FROM evolution_proposals
       WHERE type = 'repair' AND status = 'applied' AND applied_at >= ?`
    )
    .get(today) as { cnt: number }
  return row.cnt
}

// ─── Installed Skills CRUD ──────────────────────────────────────────────────

export function installSkill(
  skill: Pick<InstalledSkill, 'id' | 'name'> & Partial<InstalledSkill>
): void {
  getDB()
    .prepare(
      `INSERT INTO installed_skills
       (id, name, version, source_url, proposal_id, config_json, status, installed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      skill.id,
      skill.name,
      skill.version ?? null,
      skill.source_url ?? null,
      skill.proposal_id ?? null,
      skill.config_json ?? null,
      skill.status ?? 'active',
      skill.installed_at ?? new Date().toISOString()
    )
}

export function getActiveSkills(): InstalledSkill[] {
  return getDB()
    .prepare("SELECT * FROM installed_skills WHERE status = 'active' ORDER BY installed_at DESC")
    .all() as InstalledSkill[]
}

export function getSkill(id: string): InstalledSkill | null {
  return (
    (getDB().prepare('SELECT * FROM installed_skills WHERE id = ?').get(id) as
      | InstalledSkill
      | undefined) ?? null
  )
}

export function updateSkillStatus(id: string, status: string, reason?: string): void {
  getDB()
    .prepare(`UPDATE installed_skills SET status = ?, suspended_reason = ? WHERE id = ?`)
    .run(status, reason ?? null, id)
}

export function recordSkillRun(id: string, error?: string): void {
  if (error) {
    getDB()
      .prepare(
        `UPDATE installed_skills
         SET run_count = run_count + 1, error_count = error_count + 1,
             last_run_at = ?, last_error = ?
         WHERE id = ?`
      )
      .run(new Date().toISOString(), error, id)
  } else {
    getDB()
      .prepare(
        `UPDATE installed_skills
         SET run_count = run_count + 1, last_run_at = ?
         WHERE id = ?`
      )
      .run(new Date().toISOString(), id)
  }
}

export function recordSkillAnomaly(id: string): void {
  getDB()
    .prepare('UPDATE installed_skills SET anomaly_count = anomaly_count + 1 WHERE id = ?')
    .run(id)
}

// ─── Execution Log ─────────────────────────────────────────────────────────

export interface ExecutionLogEntry {
  id: number
  proposal_id: string | null
  agent: string | null
  error_pattern: string | null
  action_taken: string
  files_changed: string | null
  outcome: string // 'success' | 'typecheck_fail' | 'test_fail' | 'apply_fail' | 'generation_fail'
  failure_reason: string | null
  duration_ms: number | null
  pre_scores?: string | null
  post_scores?: string | null
  quality_delta?: string | null
  created_at: string
}

export function logExecution(entry: Omit<ExecutionLogEntry, 'id' | 'created_at'>): void {
  getDB()
    .prepare(
      `INSERT INTO evolution_execution_log
       (proposal_id, agent, error_pattern, action_taken, files_changed, outcome, failure_reason, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.proposal_id ?? null,
      entry.agent ?? null,
      entry.error_pattern ?? null,
      entry.action_taken,
      entry.files_changed ?? null,
      entry.outcome,
      entry.failure_reason ?? null,
      entry.duration_ms ?? null,
      new Date().toISOString()
    )
}

export function getPastFailures(agent: string, limit = 5): ExecutionLogEntry[] {
  return getDB()
    .prepare(
      `SELECT * FROM evolution_execution_log
       WHERE agent = ? AND outcome != 'success'
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(agent, limit) as ExecutionLogEntry[]
}

export function getRecentExecutions(limit = 20): ExecutionLogEntry[] {
  return getDB()
    .prepare('SELECT * FROM evolution_execution_log ORDER BY created_at DESC LIMIT ?')
    .all(limit) as ExecutionLogEntry[]
}

export function updateExecutionScores(
  proposalId: string,
  field: 'pre_scores' | 'post_scores' | 'quality_delta',
  value: string
): void {
  getDB()
    .prepare(`UPDATE evolution_execution_log SET ${field} = ? WHERE proposal_id = ?`)
    .run(value, proposalId)
}

export function getExecutionsAwaitingPostCheck(ageHours = 24): ExecutionLogEntry[] {
  const cutoff = new Date(Date.now() - ageHours * 60 * 60 * 1000).toISOString()
  return getDB()
    .prepare(
      `SELECT * FROM evolution_execution_log
       WHERE outcome = 'success' AND pre_scores IS NOT NULL AND post_scores IS NULL
       AND created_at <= ?
       ORDER BY created_at ASC`
    )
    .all(cutoff) as ExecutionLogEntry[]
}

// ─── Activity Log ─────────────────────────────────────────────────────────

export type ActivityEventType =
  | 'discovery'
  | 'review'
  | 'repair_l1'
  | 'repair_l2'
  | 'prompt_apply'
  | 'proposal_execute'
  | 'quality_check'
  | 'proactive_audit'
  | 'pattern_learn'
  | 'pattern_apply'

export type ActivityOutcome = 'success' | 'skipped' | 'failed' | 'rollback' | 'pending'

export interface ActivityLogRow {
  id: number
  event_type: ActivityEventType
  chain: string
  summary: string
  detail: string | null
  proposal_id: string | null
  agent: string | null
  outcome: ActivityOutcome
  created_at: string
}

export function insertActivityLog(entry: Omit<ActivityLogRow, 'id' | 'created_at'>): void {
  getDB()
    .prepare(
      `INSERT INTO evolution_activity_log
       (event_type, chain, summary, detail, proposal_id, agent, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.event_type,
      entry.chain,
      entry.summary,
      entry.detail ?? null,
      entry.proposal_id ?? null,
      entry.agent ?? null,
      entry.outcome,
      new Date().toISOString()
    )
}

export function getActivityLogSince(since: string, limit = 500): ActivityLogRow[] {
  return getDB()
    .prepare(
      `SELECT * FROM evolution_activity_log
       WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(since, limit) as ActivityLogRow[]
}

export function getActivityLogByChain(chain: string, since: string): ActivityLogRow[] {
  return getDB()
    .prepare(
      `SELECT * FROM evolution_activity_log
       WHERE chain = ? AND created_at >= ? ORDER BY created_at DESC`
    )
    .all(chain, since) as ActivityLogRow[]
}

export function getWeekActivitySummary(since: string): {
  total: number
  byChain: Record<string, number>
  byOutcome: Record<string, number>
  byEventType: Record<string, number>
} {
  const rows = getDB()
    .prepare('SELECT chain, outcome, event_type FROM evolution_activity_log WHERE created_at >= ?')
    .all(since) as Array<{ chain: string; outcome: string; event_type: string }>

  const byChain: Record<string, number> = {}
  const byOutcome: Record<string, number> = {}
  const byEventType: Record<string, number> = {}

  for (const r of rows) {
    byChain[r.chain] = (byChain[r.chain] ?? 0) + 1
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1
    byEventType[r.event_type] = (byEventType[r.event_type] ?? 0) + 1
  }

  return { total: rows.length, byChain, byOutcome, byEventType }
}

export function cleanOldActivityLog(retainDays = 90): number {
  const cutoff = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000).toISOString()
  const result = getDB()
    .prepare('DELETE FROM evolution_activity_log WHERE created_at < ?')
    .run(cutoff)
  return result.changes
}

// ─── Learned Repairs CRUD ─────────────────────────────────────────────────

export interface LearnedRepair {
  id: number
  error_signature: string
  agent: string
  error_type: string | null
  key_tokens: string // JSON array
  fix_description: string
  fix_files: string | null // JSON array
  fix_action: string
  confidence: number
  success_count: number
  fail_count: number
  source_proposal_id: string | null
  last_applied_at: string | null
  created_at: string
}

export function insertLearnedRepair(entry: Omit<LearnedRepair, 'id' | 'created_at'>): number {
  const result = getDB()
    .prepare(
      `INSERT INTO learned_repairs
       (error_signature, agent, error_type, key_tokens, fix_description, fix_files,
        fix_action, confidence, success_count, fail_count, source_proposal_id, last_applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.error_signature,
      entry.agent,
      entry.error_type ?? null,
      entry.key_tokens,
      entry.fix_description,
      entry.fix_files ?? null,
      entry.fix_action,
      entry.confidence ?? 50,
      entry.success_count ?? 1,
      entry.fail_count ?? 0,
      entry.source_proposal_id ?? null,
      entry.last_applied_at ?? null
    )
  return result.lastInsertRowid as number
}

export function findLearnedRepairsByAgent(agent: string, limit = 10): LearnedRepair[] {
  return getDB()
    .prepare(
      `SELECT * FROM learned_repairs
       WHERE agent = ? AND confidence >= 30
       ORDER BY confidence DESC, success_count DESC
       LIMIT ?`
    )
    .all(agent, limit) as LearnedRepair[]
}

export function findLearnedRepairBySignature(signature: string): LearnedRepair | null {
  return (
    (getDB().prepare('SELECT * FROM learned_repairs WHERE error_signature = ?').get(signature) as
      | LearnedRepair
      | undefined) ?? null
  )
}

export function reinforceLearnedRepair(id: number, success: boolean): void {
  if (success) {
    getDB()
      .prepare(
        `UPDATE learned_repairs
         SET success_count = success_count + 1,
             confidence = MIN(confidence + 10, 100),
             last_applied_at = datetime('now')
         WHERE id = ?`
      )
      .run(id)
  } else {
    getDB()
      .prepare(
        `UPDATE learned_repairs
         SET fail_count = fail_count + 1,
             confidence = MAX(confidence - 20, 0)
         WHERE id = ?`
      )
      .run(id)
  }
}

export function getLearnedRepairStats(): {
  total: number
  high_confidence: number
  total_applications: number
} {
  const row = getDB()
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN confidence >= 70 THEN 1 ELSE 0 END) as high_confidence,
         SUM(success_count + fail_count) as total_applications
       FROM learned_repairs`
    )
    .get() as { total: number; high_confidence: number; total_applications: number }
  return row
}
