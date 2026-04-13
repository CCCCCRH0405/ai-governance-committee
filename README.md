# AI Independent Self-Governance Committee

> **Your AI agent doesn't need more guardrails from humans.
> It needs its own compliance department.**

**A multi-model architecture for autonomous AI self-improvement with built-in checks and balances.**

---

## The Problem

Most AI agents today operate in one of two modes:

1. **Fully supervised** -- every action needs human approval. Safe, but doesn't scale. Your AI assistant becomes a notification machine.
2. **Fully autonomous** -- the AI does whatever it thinks is best. Fast, but terrifying. One bad judgment call and your system is broken.

Neither is what you actually want. What you want is what every functioning organization has: **delegation with oversight**. A system that can handle routine maintenance on its own, escalate when it's unsure, and be audited after the fact.

We built that.

---

## How It Works

The minimum setup is **one model, three roles**:

- **Reviewer A** (Function): "Find technical problems with this proposal"
- **Reviewer B** (Utility): "Find reasons this is unnecessary or harmful to the user"
- **Reviewer C** (Compliance): "Find compliance, privacy, or permission issues"

Each reviewer gets an **adversarial prompt** -- their job is to find problems, not to approve. Passing means they couldn't find issues, not that they endorse it.

Reviewers never see each other's output. No groupthink.

```
Proposal enters review
        |
   Reviewer A: Function Review
        |  "Is this technically sound?"
        |
   Reviewer B: Utility Review (isolated context)
        |  "Is this actually useful to the user?"
        |
   Reviewer C: Compliance Review
        |  "Does this violate privacy, permissions, or user rules?"
        |
   Cross-Validation
        |  "Do the reviewers' findings contradict each other?"
        |
   ┌────┴────┐
   |         |
All pass   Conflict detected
   |         |
Approved   → needs_human (escalate to user)
```

The cross-validation layer checks for **semantic contradictions** across reviewers. It maintains a keyword watchlist (`network`, `exec`, `spawn`, `credential`, `token`, `eval`, `require`, etc.) and flags when a passing review mentions something a security-tier review should have caught.

### For external code, there's a final gatekeeper

External code from the internet gets an additional **malware audit** by the strongest model you have access to, specifically checking for:
- Network exfiltration patterns
- File system manipulation beyond declared scope
- Process spawning / privilege escalation
- Obfuscated code / encoded payloads
- Dependency chain attacks
- Backdoor patterns

This role is **non-negotiable** -- don't use a cheap model for malware review.

---

## Scaling Up

For higher security, use **different models or providers** per role. A vulnerability in one model's reasoning is less likely to exist in another's.

Models are configurable. The framework works with any combination -- including a single model with role separation. The default setup uses three different providers to maximize independence between reviewers.

---

## Five Safety Tiers, Not Just One

Most AI safety discussions focus on alignment -- getting the AI to want the right things. We focus on **mechanical safety** -- making it structurally impossible for the AI to cause certain categories of harm, regardless of what it "wants."

### Tier 1: Resource Circuit Breakers

```
Token budget:      $2/day/provider (hard cap)
Daily proposals:   3 max
Daily repairs:     2 max
Daily prompt edits: 1 max
Prompt change size: 30% max deviation
```

These aren't suggestions. They're hard limits enforced in code before any AI is consulted. Even if all three reviewers approve an action, it won't execute if the daily budget is exhausted.

### Tier 2: Blast Radius Containment

**Core file protection.** Five files can never be auto-modified, period:
```
db.ts, ai.ts, index.ts, ipc.ts, safeStore.ts
```

If a repair suggestion mentions any of these files, it's automatically escalated to `needs_human` regardless of what the AI committee thinks. These files control the database, the AI engine, the main process, the IPC layer, and the credential store. No autonomous system should touch them.

**Change level classification:**
| Level | Scope | Authorization |
|-------|-------|--------------|
| L1 | No side effects (mark error as resolved) | Auto-execute |
| L2 | Small code/config changes (add try/catch, fix parameter) | AI review + auto-apply with typecheck/test gate |
| L3 | Core logic / architecture changes | Human only |

### Tier 3: Verification Gate

Every L2 repair goes through a **typecheck + test pipeline** before being committed:

```
Generate fix
    → Apply to files
    → Run TypeScript compiler (tsc --noEmit)
    → Run test suite
    → If either fails: rollback all changes
    → If both pass: commit
```

The AI doesn't get to decide whether its fix is correct. The compiler and test suite do.

### Tier 3.5: Post-Execution Sanity Check

Passing pre-commit verification isn't enough. The fix might interact badly with the running system in ways that static analysis can't catch.

After every L2 fix is applied, the system immediately:
- Re-runs typecheck and test suite against the live codebase
- Monitors `error_log` for 5 minutes for new errors from the patched agent
- If anything fails: automatic rollback, no second attempt, escalate to `needs_human`

This is distinct from Tier 4 (quality tracking). Tier 3.5 catches **immediate breakage**. Tier 4 catches **slow degradation** over 24 hours.

### Tier 4: Post-Fix Quality Tracking

Passing typecheck and tests doesn't mean the fix is actually good. A fix might compile fine but degrade the agent's output quality over time.

So we take **quality snapshots**:
- Before the fix: record the agent's scores across multiple dimensions
- 24 hours later: take a new snapshot
- Compare: if the net quality delta is negative, flag the fix as potentially harmful

This catches the category of fixes that are syntactically correct but semantically wrong.

### Tier 5: Loop Detection

If the same error has been repaired twice and keeps coming back, the system stops trying and escalates to human. This prevents the AI from entering a repair-break-repair cycle.

---

## The L1.5 Layer: Learning from Failures

Here's where it gets interesting.

Most self-healing systems are stateless -- they diagnose from scratch every time. Ours learns.

```
Error occurs
    |
L1: Hardcoded pattern matching (zero cost)
    |  "ECONNREFUSED on port 11434 → local model server isn't running"
    |  "SQLITE_BUSY → WAL checkpoint conflict, self-resolves"
    |
L1.5: Learned pattern matching (zero cost, DB lookup)
    |  "Last time this agent had this error signature,
    |   the fix was to add a null check in file X"
    |
L2: Full AI diagnosis (costs tokens)
    |  "Analyze these errors, categorize, suggest fix"
    |
L3: Human intervention
```

**How patterns are learned:**

1. When an L2 repair succeeds, the system extracts a **repair pattern**: the error signature (agent + error type + key tokens from the message) paired with the fix (what files changed, what the fix did).

2. The error message is **normalized** -- timestamps, file paths, hex addresses, and stack traces are stripped, leaving only the semantically meaningful tokens. This makes the signature stable across different runs.

3. The pattern starts with **confidence 50/100**.

4. Next time a similar error occurs, the system checks the `learned_repairs` table before calling the AI. If a pattern matches (>50% token overlap, >40 confidence), it's injected as context into the diagnosis prompt -- making the diagnosis faster and more accurate.

5. If the matched pattern's fix works again: **+10 confidence**.
   If it fails: **-20 confidence** (asymmetric -- we're more cautious about false positives).
   Below 30 confidence: pattern is no longer matched.

**But learned patterns are never blindly trusted.**

Two additional safeguards prevent stale or compromised patterns from causing harm:

- **Time decay.** Patterns that haven't been re-validated in 30+ days lose confidence automatically (5 points per month). A pattern nobody has confirmed in six months effectively deactivates itself. No "grandfather fixes" living on reputation alone.

- **Security sniffing.** Every matched pattern's fix action is scanned for security-sensitive keywords (`npm install`, `exec`, `spawn`, `eval`, `credential`, `fetch`, `process.env`, etc.). If any are found, the AI diagnosis is never skipped, and the pattern is injected with an explicit warning: "this historical fix touches sensitive operations -- re-evaluate independently." This exists because of supply-chain attacks: even a fix that worked perfectly six months ago might reference a package that's been compromised since.

Over time, the system builds up a **library of proven fixes** specific to its own codebase and failure modes. The repair cost for recurring issues drops from ~$0.02 (AI diagnosis) to ~$0 (DB lookup).

---

## The Four Autonomous Chains

The governance committee oversees four continuous improvement chains:

### Chain 1: Prompt Auto-Modification
Reads prompt improvement suggestions generated by the quality system, generates the actual file modification, validates the change (not empty, <30% deviation), writes it with snapshot backup. Rollback on any error. One change per day max. 7-day cooldown after a rollback.

### Chain 2: Proposal Auto-Execution
Polls approved proposals, classifies risk, routes low-risk repairs through the L2 pipeline. Never auto-executes external skills. Never auto-executes high-risk changes. Two executions per day max.

### Chain 3: Post-Fix Quality Tracking
Takes quality snapshots before and after repairs. Compares scores 24 hours later. Flags degradation. This is the feedback loop that prevents "fixes" from making things worse.

### Chain 4: Proactive Self-Audit
Scans agent performance trends (recent 5 vs previous 10 scores). Checks conversation signal negativity rates. Monitors pipeline health -- are all agents running on schedule? Is discovery producing useful output? Generates improvement proposals for declining agents.

All four chains log every action to a unified activity log, which feeds into a weekly audit report the user can review.

---

## Pipeline Health Monitoring

The system doesn't just fix errors -- it monitors whether the fixing system itself is healthy.

Every 6 hours, the proactive audit checks:
- Has each agent run within its expected interval?
- Did any agent's last run fail?
- Is the discovery pipeline producing useful output, or returning empty results?

If a pipeline hasn't run in 2x its expected interval, or its last run failed, an error-level issue is created and a repair proposal is auto-generated.

This is **meta-monitoring**: the self-healing system monitoring itself.

---

## Cost

The entire self-governance system runs on approximately **$0.30/day** (~$9/month) using a mix of fast/cheap models for routine review and a stronger model for the malware gatekeeper.

The L1 and L1.5 layers cost nothing -- pure local computation and DB lookups.

Costs scale with the number of proposals and repairs per day, not with usage volume. The hard caps (3 proposals/day, 2 repairs/day, 1 prompt edit/day) keep spending predictable.

---

## Failure Modes This Framework Addresses

- **False positive repair** -- Diagnosing a non-issue as broken, then "fixing" working code into broken code. Caught by: Tier 3 (typecheck/test gate), Tier 3.5 (post-execution sanity check)

- **Recursive self-modification loops** -- Fix introduces new error, triggers another fix, which introduces another error. Caught by: Tier 5 (loop detection -- two failed repairs = escalate to human)

- **Silent quality degradation** -- Fix compiles and passes tests but makes the agent's outputs subtly worse over time. Caught by: Tier 4 (24-hour quality snapshot comparison)

- **Cross-model blind spots** -- All reviewers share the same vulnerability and approve something they shouldn't. Mitigated by: multi-provider diversity + cross-validation contradiction detection

- **Stale pattern reuse** -- A learned repair pattern worked six months ago, but the environment has changed (e.g. a dependency was compromised). Caught by: L1.5 time decay + security sniffing (patterns touching `exec`, `npm install`, `credentials` etc. are never blindly trusted)

- **Cost runaway** -- Self-improvement loops burning through API budget without meaningful results. Caught by: Tier 1 (hard daily caps per provider, budget exhaustion = full stop)

---

## What This Is Not

- **Not AGI.** This is a governance framework for narrow autonomous tasks (error repair, prompt tuning, quality monitoring). It doesn't "think" in any meaningful sense.
- **Not unsupervised.** There's a weekly human audit cycle, core files are protected, and high-risk changes always escalate to human approval.
- **Not a replacement for human judgment.** The user always has final say. Every approved proposal is presented to the user before execution. This is pre-screening, not auto-piloting.
- **Not theoretical.** This is running in production in a desktop AI assistant. The code is open source.

---

## Key Insight

The fundamental insight is: **use AI role separation the same way democracies use separation of powers.** No single role should be trusted to both propose and approve its own changes. The proposer, the reviewers, and the executor operate under different instructions, with cross-validation catching contradictions.

Using multiple models from different providers strengthens this further -- but the core principle works with a single model too. The architecture is what matters, not the model count.

This doesn't guarantee safety. Nothing does. But it makes failure modes independent rather than correlated, which is a meaningful improvement over single-model autonomy.

---

## Design Principles

1. **Separation of Duties** -- No single agent can propose, approve, and execute.
2. **Adversarial Review** -- Reviewers are incentivized to find faults, not confirm.
3. **Multi-Stage Validation** -- Before execution, immediately after, and over time.
4. **Bounded Autonomy** -- Hard limits on scope, cost, and frequency.
5. **Fail-Safe Defaults** -- Uncertainty or conflict always escalates to human.
6. **Memory with Skepticism** -- Learned patterns are useful but never blindly trusted.
7. **Independent Failure Modes** -- Components fail independently, not simultaneously.

---

## Scope and Limitations

This framework is a **technical control layer**, not a complete AI governance program.

It handles the mechanics of safe autonomous self-improvement: who can propose, who reviews, how changes are verified, and what happens when things go wrong. It does not handle organizational governance (policies, decision rights, compliance programs, incident response playbooks) -- that's a separate layer that wraps around it.

Things this framework **does not currently address**:

- **Agent identity and privilege boundaries.** There is no per-agent permission system. Compliance checks use keyword scanning, not a policy engine. A production deployment at scale would need enforceable least-privilege controls per agent and per tool.
- **Memory poisoning via error injection.** Learned patterns and repair history are stored in a local database. An attacker doesn't need write access to the DB -- they can trigger a carefully crafted error (e.g. via a malicious API response or poisoned dependency), let the L2 repair succeed once, and the fix gets learned as a pattern. On subsequent replay of a similar error signature, the learned pattern is injected into the diagnosis prompt, potentially steering the AI toward attacker-controlled repair logic. The security sniffing layer catches patterns containing obvious keywords (`exec`, `eval`, `npm install`), but a fix that silently removes a security check or alters a logic branch would pass undetected.
- **Cross-validation keyword scanning is a trip wire, not a security boundary.** The keyword watchlist (`network`, `exec`, `spawn`, etc.) is a manually maintained blocklist with inherent bypass potential -- `child_process` vs `spawn`, string concatenation (`globalThis['ev'+'al']`), or encoded payloads would evade it. Treat this layer as an early warning signal, not a reliable security control.
- **Quality tracking circularity.** Tier 4 quality snapshots compare agent scores before and after a fix. If those scores are produced by LLM self-evaluation (which they often are), you have a circular dependency -- AI evaluating whether AI's fix made AI worse. LLMs are known to systematically overestimate their own output quality. Where possible, ground quality metrics in deterministic signals (user feedback, error rates, task completion) rather than model self-assessment.
- **Multi-model review is not infallible.** Research shows multi-agent debate is conditionally effective and not uniformly superior to strong single-agent baselines. In some settings, collaborative refinement can even increase vulnerability. The deterministic controls (typecheck, test gates, budget caps, core file protection) are the primary safety net -- the AI review committee is a secondary layer, not the foundation.

If you're evaluating this for enterprise use, treat it as a kernel that needs an organizational wrapper (ISO/IEC 42001-style management system, runtime policy enforcement, centralized identity and inventory). For personal projects and internal tooling with bounded blast radius, it works as-is.

---

## Reference Implementation

The `src/` directory contains the TypeScript implementation from Greyson, a local-first AI desktop assistant.

| File | Role |
|------|------|
| `proposalReview.ts` | Multi-layer review committee |
| `selfRepair.ts` | Error detection + L1/L1.5/L2 repair routing |
| `learnedPatterns.ts` | L1.5 pattern learning + time decay + security sniffing |
| `remediation.ts` | L2 pipeline (generate fix → apply → typecheck → test → rollback) |
| `promptAutoApply.ts` | Chain 1: autonomous prompt modification |
| `proposalExecutor.ts` | Chain 2: approved proposal execution |
| `qualityTracker.ts` | Chain 3: pre/post fix quality comparison |
| `proactiveAudit.ts` | Chain 4: trend analysis + pipeline health |
| `discovery.ts` | Interest-based content discovery |
| `weeklyReport.ts` | Structured audit report for human review |
| `activityLog.ts` | Unified action logging across all chains |
| `scheduler.ts` | Six independent scheduling loops |
| `userSummary.ts` | Human-readable proposal briefings |
| `interestVector.ts` | Zero-cost user interest profiling from existing data |
| `relevanceCheck.ts` | Local relevance scoring (no API cost) |

These files import from the parent application's modules (`../ai`, `../db`, `../logger`, etc.). They are **reference code** showing how the governance patterns are implemented, not a standalone package.

### External dependencies the framework assumes

- **An AI wrapper** (`../ai`) that can call different providers with a unified interface
- **A database** (`../db`) -- SQLite in this implementation, but any SQL store works
- **A logger** (`../logger`)
- **A token budget tracker** (`../tokenBudget`) for enforcing daily spend caps
- **Optional: notification channel** (`../telegram/bridge`) for pushing human-escalation alerts

---

## License

MIT -- see [LICENSE](LICENSE).

---

*Built as part of Greyson, a local-first AI desktop assistant with full data sovereignty.*
