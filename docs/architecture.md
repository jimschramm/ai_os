# Architecture (ai_os)

ai_os is one AI operations console. Grok Bot is Jim's only conversational interface. This fork of T3 Code is the engine and the UI base.

Grok records work, starts attempts, and reads results. T3 runs the attempts and shows the console. total-agent-memory stores the work record. Acceptance is evidence, not a model claim.

## Console

The console is new views inside T3.

- A project selector.
- A Kanban with Ready, Running, Blocked, Review, and Done. Blocked is the `recovery_pending` state.
- An agent activity strip.
- A usage summary.
- A blockers panel and a results panel.
- A drawer for the selected card's ContextPackage.

## Work records

The work record layer is Task, Attempt, and Handoff, with leases and generation fencing.

- An expired lease moves the card to Blocked, status `recovery_pending`, labeled "Execution status unknown". It never returns to Ready automatically.
- Completion is separate from acceptance. Finishing an Attempt does not accept it.
- Records are stored as nodes and relationships in total-agent-memory, following `docs/memory-schema.md`.
- A T3 thread is one Attempt. The thread's diff and log are Artifacts.

## Grok front door

Grok Bot is the only conversational interface.

- Grok records the Task under the right project. It confirms the Task only after the write is durable.
- Grok starts an Attempt through T3's local server. The start payload is an immutable ContextPackage snapshot: requirements, memory versions, repo commit, authorization scope, and created time.
- Grok reads the result back from that Attempt.
- Grok routes the result to QA on a different model.
- Evidence from that review establishes acceptance.

## Adapters and registries

The agent registry declares each worker's capabilities:

- start
- retrieve
- report
- cancel
- resume
- artifacts
- usage

Worker classes:

- T3 with Codex is a fully controlled worker. The console can start it, stop it, and read its artifacts.
- The VS Code Codex sidebar, and other Grok bots, are external update-only workers. They report progress. The console does not drive them.

The provider registry lists models, auth references, and limits.

## Codex

Codex uses the binary bundled with the VS Code Codex extension. In WSL, `~/.local/bin/codex` wraps that binary and pins it to `26.917.62051`. The pin never auto-updates.

## Retrieval

A ContextPackage is built only from exact graph queries. Those queries select accepted, current, non-superseded facts.

Vector search is total-agent-memory's Chroma index. It is a candidate-discovery aid and nothing more.

- It may suggest nodes to a human or to an orchestrator.
- Its results never enter a ContextPackage.
- Its results never establish acceptance.
- Its results are never treated as authoritative.

Vector retrieval is only partially accurate for context. That is why it stays outside the package.

## Files

Google Drive remains authoritative for file content. A reference is a Drive file ID plus a version. Reads are read-only.

## Staging

1. Grok to T3 adapter: create a thread, send a prompt, and read the result.
2. Task, Attempt, and Handoff records, plus a ContextPackage builder.
3. Kanban and context views in T3.
4. Different-model QA, and GitHub artifacts.
5. Later: AWS lifecycle, more providers, a maintainer agent, and a radial conflict-lens visualization.
