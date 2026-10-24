# Architecture (ai_os)

This is the governing architecture for ai_os. The product is one AI operations console. This fork of T3 Code is the engine and the UI base. The dashboard is new views inside T3.

Grok Bot is the only conversational intake. T3 plus Codex is the fully controlled worker. Codex is the binary bundled with the VS Code Codex extension, pinned to `26.917.62051` by `~/.local/bin/codex` in WSL, and it never auto-updates.

The logical graph in total-agent-memory (TAM) is the only source of truth for work and knowledge relationships. Node kinds and relationship types are in `docs/memory-schema.md`. TAM's Chroma index is candidate discovery only.

Already in place: the T3 fork base, TAM, and the memory schema. The console, contracts, and orchestration below are what gets built on that base.

## Experience

A request such as "Update the USBA tournament page, verify it, and have Marketing prepare the announcement" runs without Jim translating cards, relaying context, or preparing a handoff.

1. Identify the workspace and project.
2. Capture the request, constraints, acceptance criteria, and authorization.
3. Record the work durably, then confirm with a task link.
4. Plan, assign, and supply one shared context to every worker.
5. Execute, report progress, and collect artifacts.
6. Run independent QA and corrections.
7. Return the accepted result to the dashboard and to the originating conversation.
8. Preserve the knowledge so a fresh agent can continue.

Work can also start from the dashboard. Jim can keep using Codex in the VS Code sidebar for interactive engineering. That path reports into the same work record.

## Governing requirements

Jim retains product direction and acceptance authority. Standing authorization lets ordinary work proceed.

| Requirement                      | Rule                                                                    |
| -------------------------------- | ----------------------------------------------------------------------- |
| Conversation creates work        | Confirm only after a durable receipt.                                   |
| Agentic orchestration            | Planning, delegation, dependencies, QA, and rework are part of the run. |
| Independent verification         | Every code change is QA'd by a separate agent on a different model.     |
| Evidence establishes completion  | A claim or model agreement is not evidence.                             |
| Shared context survives sessions | Context is provider-independent and rebuildable.                        |
| One-screen visibility            | Projects, Kanban, activity, blockers, results, and usage.               |
| Failures are actionable          | A failure names the blocker, the owner, and the next action.            |
| Low maintenance                  | One operating path for ordinary work.                                   |
| Extensibility                    | New agents and providers enter through contracts and registries.        |
| Reproducibility                  | Each project has a repo and infrastructure-as-code.                     |
| Private execution                | Local-only stays local across execution, memory, logging, and QA.       |

## Workspace, projects, and ownership

A workspace contains projects. A project contains tasks, knowledge, and artifacts. Examples: Personal, USBA.

Core preferences are shared only when that sharing is deliberate. Project knowledge, tools, and permissions stay scoped to the project. Logical ownership is not access isolation. Permissions enforce the boundary.

| Owner            | Owns                                           |
| ---------------- | ---------------------------------------------- |
| Main Grok Bot    | Intake, and progress back to the conversation. |
| Vault            | Drive and OneDrive file custody.               |
| Web              | The website.                                   |
| Marketing        | Content.                                       |
| Codex in VS Code | Interactive engineering.                       |
| ai_os maintainer | Platform health and upkeep.                    |

## Contracts

Every contract has a versioned schema, valid transitions, error behavior, examples, and executable contract tests. The first sequence is request, assignment, execution, independent QA, rework, accepted result. A task declares its type. An implementation still requires independent QA by a different base model than the model that ran, on the exact submitted revision. An advisory review finishes as Review delivered, with that revision and its findings. It does not enter QA, approve a change, or satisfy mandatory QA. A finding that asks for a change is a new implementation, and that implementation goes through the same QA.

Build order starts here. Stage 1 begins with Intake, Assignment, Completion submission, and QA verdict/rework.

| Contract              | Carries                                                                    |
| --------------------- | -------------------------------------------------------------------------- |
| Intake                | Request, constraints, acceptance criteria, authorization, durable receipt. |
| Assignment            | Worker, scope, immutable ContextPackage snapshot.                          |
| Progress              | Status, heartbeat, blockers, partial artifacts.                            |
| Completion submission | Claimed outcome, exact artifact revision, evidence.                        |
| QA and rework         | Verdict, findings, required corrections, accepted revision.                |
| Shared memory         | Retrieval, contributions, provenance, acceptance, supersession.            |
| Usage                 | Provider and model attribution, measurements, estimates, unknowns.         |
| Control and recovery  | Cancel, continue, retries, ownership, failure.                             |
| Result delivery       | Accepted result back to the dashboard and the originating conversation.    |

The work record is Task, Attempt, and Handoff, with leases and generation fencing, stored as nodes and relationships in TAM. A T3 thread is one Attempt. The thread's diff and log are Artifacts.

An assignment carries an immutable ContextPackage snapshot: requirements, memory versions, the repo commit, the authorization scope, and the created time.

## Orchestration

The model interprets the request, plans, selects capabilities, assesses findings, and explains blockers. The application persists state, enforces permissions and limits, tracks exact revisions and QA outcomes, and handles ownership, deduplication, and recovery.

Simple work stays simple. The orchestrator owns the overall outcome. It detects repeated ineffective fixes, changes the approach or the agent, and escalates a concrete blocker after bounded recovery.

Workers run in isolated workspaces and worktrees. Agent-to-agent exchanges are task-linked handoffs.

## Verification

Code, including infrastructure-as-code, adapters, and ai_os itself, follows implement, verify, correct, reverify, accept.

QA runs on a different base model from the model that actually ran. It receives the requirements and the actual artifacts, and it runs the checks. A finding is a defect, the evidence, and the expected behavior. Acceptance binds to the exact final revision. A later change reruns the affected checks. Unavailable QA is a visible wait. There is no bypass. Which adapter ran the task does not decide whether QA is required.

Evidence is diffs, commits, tests, browser checks, previews, deployment identities, and readbacks. A completion claim does not establish that the work happened. Agreement between models is not sufficient. Non-code deliverables get the verification that fits them.

Completion and acceptance stay separate. A finished Attempt is not accepted knowledge.

## Memory

Memory has three levels: current-task context, project and workspace memory, and durable personal or reusable knowledge.

Entities and relationships distinguish proposed from accepted. A proposed relationship is not knowledge until it is explicitly accepted. `SUPERSEDES` keeps the older fact queryable. See `docs/memory-schema.md`.

The context service answers:

- What governs this task?
- Which decisions are current?
- What changed since the last attempt?
- What evidence supports the current state?
- What does the next agent need?

Context is readable and linked to its evidence. A new session is rebuilt from memory. Agents retrieve a context package. They do not interpret the raw graph ad hoc.

ContextPackages are built only from exact graph queries over accepted, current, non-superseded facts. TAM's Chroma index may suggest nodes to a human or to the orchestrator. Those suggestions never enter a ContextPackage, never establish acceptance, and are never authoritative. Vector retrieval is only partially accurate for context.

TAM stores the graph now. A dedicated store such as Postgres remains a later candidate, and only when real queries justify it. It would be a rebuildable projection of the graph, or it would have clear ownership of the records it holds. The graph stays the source of truth.

## Storage

| Store                 | Authority                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Drive (~5 TB)  | Primary file store. Authoritative for USBA knowledge files, references, media, handoffs, and deliverables. A reference is a file ID plus a version. |
| TAM                   | Accepted relationships, provenance, status, versions, and coordination.                                                                             |
| GitHub                | Code and pull requests.                                                                                                                             |
| Local private storage | Restricted content.                                                                                                                                 |

A project folder uses `PROJECT.md`, `INSTRUCTIONS.md`, `DECISIONS.md`, `CURRENT_STATE.md`, `KNOWLEDGE.md`, `Sources/`, `Handoffs/`, and `Artifacts/`.

TAM coordinates agent writes and reconciles Jim's edits. Each record has one owner. Agents use the common tools. They do not rewrite shared files on their own. Drive content is referenced by file ID and version, and a write goes through the shared Drive tool.

No vector store is an authority.

## Agents, providers, and integrations

| Kind               | Examples                                             | Role                                                                                                                                                                  |
| ------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intake             | Grok Bot                                             | Only conversational intake. Records the task and returns progress.                                                                                                    |
| Interactive worker | Codex in VS Code                                     | Update-only. Jim drives it, and it reports status and artifacts.                                                                                                      |
| Controlled worker  | Independent Codex via T3                             | Fully controlled. T3 starts, cancels, resumes, and reads it.                                                                                                          |
| Advisory worker    | Antigravity CLI (`agy`)                              | Advisory review only. It starts, cancels, returns findings, and reports token usage. It does not resume or heartbeat. A restart leaves the run in `recovery_pending`. |
| Optional worker    | Hermes                                               | Not installed. The console does not depend on it.                                                                                                                     |
| Custom worker      | OpenAI, xAI, Anthropic, DeepSeek, local Ollama       | Provider registry: model, auth reference, limits.                                                                                                                     |
| Integrations       | GitHub, Drive, OneDrive, email, calendar, AWS, media | Connections with explicit capabilities.                                                                                                                               |

Other Grok bots are external update-only workers, the same class as the VS Code Codex sidebar.

An adapter declares the capabilities it implements: start, retrieve assignments, report status, cancel, resume, return artifacts, report usage, receive context, heartbeat, and idempotency. The console calls only capabilities the adapter declares. Antigravity declares start, cancel, report status, return artifacts, report usage, receive context, and idempotency.

Three paths have to be verified before a worker is trusted: Grok intake and automatic return, Codex interactive versus the independent T3 worker, and subscription versus API auth and billing.

## Dashboard

The dashboard is views inside T3.

- Workspace and project selection.
- Kanban: Ready, Running, Blocked, Review, Done. Blocked is `recovery_pending`.
- Agent activity, with assignments that expand.
- Blockers and decisions that need Jim.
- Recent results.
- Usage.

A task drawer shows the request, acceptance criteria, context, progress, evidence, QA, and artifacts. Project dashboards are configurable. An automation card shows its source, freshness, and failures. The UI is clear and dark. A radial conflict-lens is a later visualization.

## Integrations, workflows, and artifacts

An integration directory lists each connection's capabilities, auth health, ownership, and last success. Workflows live in a versioned library.

Hooks sit at boundaries: format, tests, evidence capture, and memory updates. An artifact workspace covers docs, sheets, slides, images, audio, and video, using established components. Voice and mobile come later, through these same contracts.

## Project repositories and environments

Each project has a repo with code, lockfiles, infrastructure-as-code, tests, a dev setup, agent instructions, and procedures. It runs locally in VS Code, on AWS, or on another host.

Track environment, account, region, stack, status, and deployed revision. The reusable AWS account lifecycle is: preserve data, destroy the stack, verify removal, deploy the next stack, verify it, and update the registry. Account IDs and ownership are configuration.

Forensic Dev/Test through DigiForce stays out of scope.

## Hosting

The shape is AWS for coordination, a browser console, and a local companion. Exact AWS resources stay open until a contract needs them.

The workstation is a 7800X3D, an RTX 5070 Ti with 16 GB, 32 GB of RAM, and two 4 TB NVMe drives. Quantized, slow, or overnight local runs are acceptable.

Local-only keeps execution, memory, logging, and QA on the machine. There is no cloud fallback and no Drive sync. Only permitted metadata goes to AWS.

## Creative

Creative work follows import, transcribe, select, plan, edit, preview, revise, export, and optional publish. The tool set covers crop and reframe, captions, branding, audio, thumbnails, copy, and variants. Review is timestamped. Tools are pluggable.

## Usage, reliability, and upkeep

Attribute usage by project, task, attempt, agent, platform, provider, and model. Reported tokens, estimates, subscription use, and unknown stay distinct.

Reliability rules:

- Atomic claims.
- Generation fencing.
- Immutable context snapshots.
- Idempotent operations.
- Live authorization checks.
- Bounded retries.
- `recovery_pending`: an expired lease becomes Blocked, labeled "Execution status unknown", and never returns to Ready on its own.

A maintainer agent handles platform health, with independent QA and an external recovery path for when the maintainer itself is down. Operations cover backups, restore, updates, diagnostics, and docs.

## Build sequence

| Stage                      | Delivers                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Contracts and design    | Versioned schemas, transitions, errors, examples, and contract tests. Begins with Intake, Assignment, Completion submission, and QA verdict/rework. |
| 2. Foundation              | Infrastructure-as-code, persistence, projects, Drive references, the TAM graph, Kanban, activity, and usage.                                        |
| 3. Complete workflow       | One Grok request through execution, different-model QA, rework, and delivery.                                                                       |
| 4. Continuity and recovery | Leases, fencing, `recovery_pending`, and resume by a fresh agent.                                                                                   |
| 5. Engineering expansion   | VS Code Codex, more workers, GitHub, and the AWS lifecycle.                                                                                         |
| 6. Private execution       | Local companion, Ollama, a sandbox, and local memory and QA.                                                                                        |
| 7. Creative and automation | The creative pipeline, the workflow library, and automation cards.                                                                                  |
| 8. Product operation       | Maintainer agent, backups, diagnostics, and docs.                                                                                                   |

The first acceptance demo is a disposable project. One Grok request completes with independent QA, returns evidence to the conversation and the dashboard, and a fresh agent continues without a rebriefing.

## Exclusions

No vector store is an authority. Notion, NotebookLM, Granola, a CRM, payments, and named media products stay optional and off the core path.
