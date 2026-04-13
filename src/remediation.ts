/**
 * L2 Autonomous Repair Execution Engine
 *
 * Flow: AI generates fix → apply to file → typecheck → test → keep or rollback
 * Safety: core files blocked, path whitelist, typecheck+test gate, auto-rollback
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { app } from 'electron'
import { runUtilityPrompt } from '../ai'
import { log } from '../logger'
import { updateProposalFix, updateProposalStatus, logExecution, getPastFailures } from './db'

// ─── Safety Boundaries ─────────────────────────────────────────────────────

const CORE_FILES = new Set(['db.ts', 'ai.ts', 'index.ts', 'ipc.ts', 'safeStore.ts'])
const ALLOWED_PREFIXES = ['src/main/', 'config/', 'prompts/']
const BLOCKED_PREFIXES = ['src/preload/', 'src/renderer/', 'node_modules/', '.git/']

// ─── Types ──────────────────────────────────────────────────────────────────

interface FixInstruction {
  file_path: string // relative to project root
  old_code: string
  new_code: string
}

export interface RemediationResult {
  success: boolean
  fix_applied: boolean
  typecheck_passed: boolean | null
  test_passed: boolean | null
  error?: string
  files_changed: string[]
  explanation: string
}

// ─── Path Safety ────────────────────────────────────────────────────────────

function isPathAllowed(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/')

  if (BLOCKED_PREFIXES.some((d) => normalized.includes(d))) return false

  const fileName = normalized.split('/').pop() || ''
  if (CORE_FILES.has(fileName)) return false

  return ALLOWED_PREFIXES.some((d) => normalized.startsWith(d))
}

function getProjectRoot(): string {
  return app.getAppPath()
}

// ─── Fix Generation ─────────────────────────────────────────────────────────

function buildFixPrompt(
  diagnosis: string,
  agent: string,
  errorMessages: string[],
  fileContents: Map<string, string>,
  pastFailures: Array<{ action_taken: string; failure_reason: string | null }>
): string {
  const contextFiles = [...fileContents.entries()]
    .map(([p, content]) => `=== ${p} ===\n${content}`)
    .join('\n\n')

  const failureSection =
    pastFailures.length > 0
      ? `\n\n⚠️ The following fixes were tried before and failed — do not repeat:\n${pastFailures
          .map((f) => `- Attempted: ${f.action_taken}\n  Failure reason: ${f.failure_reason || 'unknown'}`)
          .join('\n')}\n`
      : ''

  return `You are a code repair engineer. Generate a precise code fix based on the following diagnosis.

Diagnosis: ${diagnosis}
Agent: ${agent}

Error messages:
${errorMessages.map((m) => `- ${m}`).join('\n')}
${failureSection}
Related file contents:
${contextFiles}

Requirements:
1. Make only the minimum necessary changes
2. old_code must be an exact code snippet from the file (including indentation)
3. Ensure safe fixes with appropriate try/catch
4. Do not modify db.ts / ai.ts / index.ts / ipc.ts / safeStore.ts

Strictly output in the following JSON format:
{
  "fixes": [
    {
      "file_path": "src/main/xxx/yyy.ts",
      "old_code": "original code snippet",
      "new_code": "fixed code snippet"
    }
  ],
  "explanation": "brief description of what was fixed"
}`
}

function guessRelevantFiles(agent: string, errorMessages: string[]): string[] {
  const combined = `${agent} ${errorMessages.join(' ')}`.toLowerCase()
  const candidates: string[] = []

  // Extract file paths mentioned in error messages
  const filePattern = /src\/main\/[\w/]+\.ts/g
  for (const msg of errorMessages) {
    const matches = msg.match(filePattern)
    if (matches) candidates.push(...matches)
  }

  // Guess from agent name
  const agentToDir: Record<string, string> = {
    morning_briefing: 'src/main/intelligence/morningBrief.ts',
    intelligence: 'src/main/intelligence/orchestrator.ts',
    compliance_sentinel: 'src/main/sentinels/compliance.ts',
    flight_sentinel: 'src/main/sentinels/flights.ts',
    memory_custodian: 'src/main/memory/custodian.ts',
    daily_checklist: 'src/main/maintenance/checklist.ts',
    token_audit: 'src/main/maintenance/tokenAudit.ts',
    heartbeat: 'src/main/maintenance/heartbeat.ts',
    evolution_thinker: 'src/main/evolution/discovery.ts',
    self_repair: 'src/main/evolution/selfRepair.ts',
    prompt_evolution: 'src/main/quality/promptEvolution.ts'
  }

  if (agentToDir[agent]) candidates.push(agentToDir[agent])

  // Guess from error keywords
  if (combined.includes('scheduler')) candidates.push('src/main/intelligence/scheduler.ts')
  if (combined.includes('telegram')) candidates.push('src/main/telegram/bridge.ts')
  if (combined.includes('custodian')) candidates.push('src/main/memory/custodian.ts')
  if (combined.includes('embedding')) candidates.push('src/main/memory/embedding.ts')

  // Deduplicate
  return [...new Set(candidates)].slice(0, 3)
}

async function generateFix(
  diagnosis: string,
  agent: string,
  errorMessages: string[]
): Promise<{ fixes: FixInstruction[]; explanation: string }> {
  const root = getProjectRoot()

  // Read relevant source files so the model has context
  const relevantPaths = guessRelevantFiles(agent, errorMessages)
  const fileContents = new Map<string, string>()
  for (const relPath of relevantPaths) {
    const absPath = resolve(root, relPath)
    if (existsSync(absPath)) {
      const content = readFileSync(absPath, 'utf-8')
      // Limit to 200 lines to save tokens
      fileContents.set(relPath, content.split('\n').slice(0, 200).join('\n'))
    }
  }

  // Check past failures for this agent — don't repeat mistakes
  const pastFailures = getPastFailures(agent, 5).map((f) => ({
    action_taken: f.action_taken,
    failure_reason: f.failure_reason
  }))

  const result = await runUtilityPrompt(
    buildFixPrompt(diagnosis, agent, errorMessages, fileContents, pastFailures),
    { provider: 'primary', forceJson: true, maxTokens: 4000 }
  )

  const jsonMatch = result.text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('No JSON in fix response')

  const parsed = JSON.parse(jsonMatch[0])
  if (!Array.isArray(parsed.fixes) || parsed.fixes.length === 0) {
    throw new Error('No fixes generated')
  }

  return { fixes: parsed.fixes, explanation: parsed.explanation || '' }
}

// ─── File Operations ────────────────────────────────────────────────────────

function applyFixes(
  root: string,
  fixes: FixInstruction[]
): { backups: Map<string, string>; applied: string[] } {
  const backups = new Map<string, string>()
  const applied: string[] = []

  for (const fix of fixes) {
    if (!isPathAllowed(fix.file_path)) {
      throw new Error(`Path not allowed: ${fix.file_path}`)
    }

    const absPath = resolve(root, fix.file_path)
    if (!existsSync(absPath)) {
      throw new Error(`File not found: ${fix.file_path}`)
    }

    const content = readFileSync(absPath, 'utf-8')
    if (!content.includes(fix.old_code)) {
      throw new Error(`old_code not found in ${fix.file_path}`)
    }

    backups.set(absPath, content)
    writeFileSync(absPath, content.replace(fix.old_code, fix.new_code), 'utf-8')
    applied.push(fix.file_path)
  }

  return { backups, applied }
}

function rollback(backups: Map<string, string>): void {
  for (const [filePath, content] of backups) {
    try {
      writeFileSync(filePath, content, 'utf-8')
    } catch (err) {
      log.error(`[Evolution] CRITICAL: rollback failed for ${filePath}:`, err)
    }
  }
}

// ─── Validation ─────────────────────────────────────────────────────────────

function runTypecheck(root: string): { passed: boolean; output: string } {
  try {
    const out = execSync('npx tsc --noEmit -p tsconfig.node.json', {
      cwd: root,
      timeout: 60_000,
      stdio: 'pipe'
    })
    void out
    return { passed: true, output: '' }
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer }
    const stdout = e.stdout ? e.stdout.toString() : ''
    const stderr = e.stderr ? e.stderr.toString() : ''
    return { passed: false, output: (stdout + stderr).slice(0, 800) }
  }
}

function runTests(root: string): { passed: boolean; output: string } {
  try {
    const out = execSync('npx vitest run', {
      cwd: root,
      timeout: 120_000,
      stdio: 'pipe'
    })
    void out
    return { passed: true, output: '' }
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer }
    const stdout = e.stdout ? e.stdout.toString() : ''
    const stderr = e.stderr ? e.stderr.toString() : ''
    return { passed: false, output: (stdout + stderr).slice(0, 800) }
  }
}

// ─── Main Orchestrator ──────────────────────────────────────────────────────

export async function executeL2Repair(
  proposalId: string,
  diagnosis: string,
  agent: string,
  errorMessages: string[],
  errorIds: number[]
): Promise<RemediationResult> {
  const startMs = Date.now()
  const errorPattern = errorMessages[0]?.slice(0, 120) || 'unknown'
  const result: RemediationResult = {
    success: false,
    fix_applied: false,
    typecheck_passed: null,
    test_passed: null,
    files_changed: [],
    explanation: ''
  }

  // Guard: skip in packaged app — source not modifiable
  if (app.isPackaged) {
    result.error = 'packaged_app'
    return result
  }

  const root = getProjectRoot()

  // Step 1: Generate fix via AI
  let fixes: FixInstruction[]
  try {
    const generated = await generateFix(diagnosis, agent, errorMessages)
    fixes = generated.fixes
    result.explanation = generated.explanation
  } catch (err) {
    result.error = `Fix generation failed: ${err}`
    log.warn(`[Evolution] L2 fix generation failed for ${proposalId}:`, err)
    updateProposalStatus(proposalId, 'rejected')
    logExecution({
      proposal_id: proposalId,
      agent,
      error_pattern: errorPattern,
      action_taken: diagnosis,
      files_changed: null,
      outcome: 'generation_fail',
      failure_reason: String(err),
      duration_ms: Date.now() - startMs
    })
    return result
  }

  // Step 2: Validate all paths before touching anything
  for (const fix of fixes) {
    if (!isPathAllowed(fix.file_path)) {
      result.error = `Blocked path: ${fix.file_path}`
      log.warn(`[Evolution] L2 blocked path ${fix.file_path} in ${proposalId}`)
      updateProposalStatus(proposalId, 'needs_human')
      logExecution({
        proposal_id: proposalId,
        agent,
        error_pattern: errorPattern,
        action_taken: `${result.explanation} → ${fix.file_path}`,
        files_changed: null,
        outcome: 'apply_fail',
        failure_reason: `Blocked path: ${fix.file_path}`,
        duration_ms: Date.now() - startMs
      })
      return result
    }
  }

  // Step 3: Apply with backup
  let backups: Map<string, string>
  try {
    const applied = applyFixes(root, fixes)
    backups = applied.backups
    result.files_changed = applied.applied
    result.fix_applied = true
  } catch (err) {
    result.error = `Apply failed: ${err}`
    log.warn(`[Evolution] L2 apply failed for ${proposalId}:`, err)
    updateProposalStatus(proposalId, 'rejected')
    logExecution({
      proposal_id: proposalId,
      agent,
      error_pattern: errorPattern,
      action_taken: result.explanation,
      files_changed: null,
      outcome: 'apply_fail',
      failure_reason: String(err),
      duration_ms: Date.now() - startMs
    })
    return result
  }

  const diff = fixes
    .map(
      (f) =>
        `--- ${f.file_path}\n${f.old_code
          .split('\n')
          .map((l) => `- ${l}`)
          .join('\n')}\n${f.new_code
          .split('\n')
          .map((l) => `+ ${l}`)
          .join('\n')}`
    )
    .join('\n\n')

  const filesStr = JSON.stringify(result.files_changed)

  // Step 4: Typecheck
  const tc = runTypecheck(root)
  result.typecheck_passed = tc.passed
  if (!tc.passed) {
    log.warn(`[Evolution] L2 typecheck failed for ${proposalId}, rolling back`)
    rollback(backups)
    result.fix_applied = false
    result.error = `Typecheck failed: ${tc.output}`
    updateProposalFix(proposalId, { diff, files: result.files_changed, riskLevel: 'low' })
    updateProposalStatus(proposalId, 'rejected')
    logExecution({
      proposal_id: proposalId,
      agent,
      error_pattern: errorPattern,
      action_taken: result.explanation,
      files_changed: filesStr,
      outcome: 'typecheck_fail',
      failure_reason: tc.output.slice(0, 500),
      duration_ms: Date.now() - startMs
    })
    return result
  }

  // Step 5: Run tests
  const tr = runTests(root)
  result.test_passed = tr.passed
  if (!tr.passed) {
    log.warn(`[Evolution] L2 tests failed for ${proposalId}, rolling back`)
    rollback(backups)
    result.fix_applied = false
    result.error = `Tests failed: ${tr.output}`
    updateProposalFix(proposalId, { diff, files: result.files_changed, riskLevel: 'low' })
    updateProposalStatus(proposalId, 'rejected')
    logExecution({
      proposal_id: proposalId,
      agent,
      error_pattern: errorPattern,
      action_taken: result.explanation,
      files_changed: filesStr,
      outcome: 'test_fail',
      failure_reason: tr.output.slice(0, 500),
      duration_ms: Date.now() - startMs
    })
    return result
  }

  // Step 6: Success — mark applied + resolve errors
  updateProposalFix(proposalId, { diff, files: result.files_changed, riskLevel: 'low' })
  updateProposalStatus(proposalId, 'applied', { applied_at: new Date().toISOString() })
  logExecution({
    proposal_id: proposalId,
    agent,
    error_pattern: errorPattern,
    action_taken: result.explanation,
    files_changed: filesStr,
    outcome: 'success',
    failure_reason: null,
    duration_ms: Date.now() - startMs
  })

  // Resolve the original errors
  const { getDB } = await import('../db')
  const db = getDB()
  const stmt = db.prepare('UPDATE error_log SET resolved = 1, resolution = ? WHERE id = ?')
  const resolution = `[L2 auto-fix] ${result.explanation}`
  const tx = db.transaction(() => {
    for (const id of errorIds) stmt.run(resolution, id)
  })
  tx()

  result.success = true
  log.info(
    `[Evolution] L2 repair SUCCESS: ${proposalId} — ${result.explanation} (${result.files_changed.join(', ')})`
  )
  return result
}
