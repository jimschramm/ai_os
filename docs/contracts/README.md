# Contracts (v1)

These are the ai_os v1 contracts from [the architecture](../architecture.md). They define payloads, the legal sequence, and the errors for that sequence. They do not start workers, write to total-agent-memory, or render the dashboard.

The package is `@t3tools/ai-os-contracts` (`packages/ai-os-contracts`). Schemas are Effect Schema. Decode with `onExcessProperty: "error"` (`strictParse`) so an undeclared field is rejected. Examples for the first sequence live in `packages/ai-os-contracts/src/examples.ts`. Contract tests live next to the schemas.

`applySequenceEvent` and `applyMemoryEvent` decode the current value and the event, apply the transition, then decode the result. A payload that fails its schema is `invalid_payload`. It is not stored. `buildRetrieval` decodes the graph, the request, and the candidates the same way.

## Sequence

Request, assignment, execution, independent QA, rework, accepted result. Progress, usage, control, and delivery extend that sequence. Shared memory is a separate graph.

| Phase            | Kanban  | Legal events                                                                                                                   |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| idle             |         | intake                                                                                                                         |
| requested        |         | acknowledge                                                                                                                    |
| acknowledged     | Ready   | assign                                                                                                                         |
| assigned         | Ready   | start_execution, cancel, transfer_ownership                                                                                    |
| executing        | Running | submit_completion, lease_expired, report_progress, heartbeat, heartbeat_lapsed, report_usage, cancel, fail, transfer_ownership |
| awaiting_qa      | Review  | qa, cancel                                                                                                                     |
| rework           | Ready   | start_execution, cancel                                                                                                        |
| accepted         | Done    | start_execution, deliver                                                                                                       |
| recovery_pending | Blocked | resolve_recovery                                                                                                               |
| failed           |         | retry                                                                                                                          |
| cancelled        |         | continue                                                                                                                       |

`requested` is the durable receipt of the intake. It is not confirmed, and it is not on the board yet. Acknowledge is the confirmation, and it carries the task link. A later `start_execution` from `accepted` drops the previous acceptance, so a new revision has to be submitted and reviewed again. `failed` and `cancelled` are off the board.

`SequenceState` is a discriminated union on `phase`. A phase only decodes with the records that phase requires. `accepted` requires the assignment, the completion, an available accept verdict, and the delivery acks. `awaiting_qa` can carry only an unavailable verdict. `recovery_pending` requires the label `Execution status unknown`. A payload that is only `{ phase: "accepted" }` does not decode.

An open attempt has a generation. The first `start_execution` uses generation 1. A new start, a retry, and an ownership transfer while executing each move to the next generation and clear the lease and partial progress. Writes that name an older generation are `stale_generation`.

## Intake

`IntakeV1` carries the workspace, project, request, constraints, acceptance criteria, and authorization (`standing` or `explicit`).

`IntakeAcknowledgmentV1` is a separate payload. `durable` is the literal `true`. `taskLink` must be exactly `ai-os://tasks/{taskId}`: that scheme, that path, and no extra segment, query, or fragment. A string that only contains the task id is not a link. A `false` durable flag, a missing link, or an acknowledgment before the intake fails. The failure before any intake is `confirmation_before_durable_receipt`.

## Assignment

`AssignmentV1` names the worker, the attempt, the implementer model, and a `ContextPackageSnapshotV1`: requirements, memory versions, repo commit, authorization scope, and created time. The snapshot has no vector field and no candidates field. Decode and assignment both deep-copy that snapshot and freeze the copy, so later mutation of the caller's object does not change the recorded context, and mutation of the stored snapshot throws. The repo commit is a full git object id, 40 or 64 lowercase hex characters.

## Completion submission

`CompletionSubmissionV1` carries the claimed outcome, the exact `artifactRevision`, and at least one evidence item (`diff`, `commit`, `test`, `browser`, `preview`, `deployment`, or `readback`). An artifact revision is a git object id, a Drive file id plus version, or a named page, preview, deployment, or document id. A git object id is exactly 40 hex characters (SHA-1) or 64 (SHA-256), stored lowercase. Abbreviated ids are rejected. Drive file ids stay case-sensitive. Submitting a completion moves `executing` to `awaiting_qa`. It does not accept the work. Repeating the revision that QA sent back for rework, including the same full git id in a different case, is `revision_mismatch`. A completion has a claimed outcome. It does not carry an idempotency key.

## QA verdict and rework

`QaVerdictV1` is one of:

| Variant                     | Result                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `availability: unavailable` | Stays `awaiting_qa`. No verdict and no acceptance.                                                                                     |
| `verdict: rework`           | Moves to `rework`. Findings are required. The reviewed revision is recorded.                                                           |
| `verdict: accept`           | Moves to `accepted`. `acceptedRevision` must equal `artifactRevision`, and that revision must be the one in the completion submission. |

QA's model name must differ from the assignment's implementer model name. A model is `{ provider?, model }`. Provider is attribution (`openai/gpt-5.4` and `azure/gpt-5.4` are the same model, and so is a bare `gpt-5.4`). The schema check and the transition both compare those canonical model names. The transition rejects a QA model name equal to the assigned implementer (`qa_same_model`) and a payload that names some other implementer model (`implementer_mismatch`). Acceptance compares canonical revisions, so a full git id matches regardless of case. An unavailable verdict cannot also carry an acceptance. There is no event that skips QA.

## Progress

`ProgressReportV1` is a generation-scoped snapshot: `working` or `blocked`, blockers, and partial artifacts. A blocked report needs at least one blocker. A blocker names the summary, the owner, and a concrete next action. A working report cannot carry blockers. Partial artifacts use the same revision types as completion, so an abbreviated git id is rejected. The stored report is frozen.

`HeartbeatV1` names the generation, the lease, and when that lease expires. The expiry has to be later than the observation. A matching heartbeat refreshes `leaseExpiresAt` on the open run. `heartbeat_lapsed` for that same generation moves `executing` to `recovery_pending`. A lapse for an older generation is `stale_generation` and leaves the run executing. `lease_expired` does the same as a matching lapse. Neither one returns the attempt to Ready.

## Shared memory

Node kinds and relationship types are the ones in [the memory schema](../memory-schema.md). `MemoryGraphV1` stores facts and relationships. A fact is `proposed`, `accepted`, or `superseded`. A relationship is `proposed` or `accepted`. Both carry provenance (who, when) and a validity window. Proposed is not knowledge. `accept_fact` is the explicit acceptance. `supersede` records an accepted `SUPERSEDES` relationship from the newer accepted fact to the older accepted fact. The older fact stays in the graph. `historyFacts` returns both. `packageFacts` returns only accepted facts whose window covers `asOf` and that have not been superseded.

`buildRetrieval` turns that set into a `ContextPackageSnapshotV1` plus a separate `candidates` list. Candidates are vector hits (`source: chroma`). A candidate id is removed from the package even when the fact is otherwise eligible. A response whose package contains a candidate id does not decode. The package schema itself has no candidates field. This contract does not write total-agent-memory.

## Usage

`UsageMeasurementV1` is one of `reported_tokens`, `estimated_cost` (USD minor units), `subscription_allocation` (basis points), or `unknown`. Each measurement carries attribution: project, task, attempt, agent, platform, provider, and model. A payload that mixes those kinds is rejected. `UsageLedgerV1` is the list of measurements. It has no total field. `usageTotals` adds values only inside a kind. Unknown increments a count. It does not become tokens or cost. `report_usage` appends one measurement to the open run. The project, task, and attempt have to match the intake and the assignment. Cancel, continue, retry, and an executing ownership transfer keep the measurements with the attempt.

## Control and recovery

Control commands carry an idempotency key. That key is not a completion claim. The same key and the same command replay the current state. The same key and a different command is `idempotency_conflict`.

| Command              | From                                     | Result                                                                              |
| -------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `cancel`             | assigned, executing, awaiting_qa, rework | `cancelled`. Off the board.                                                         |
| `continue`           | cancelled                                | `assigned` (Ready). This is the only way back from cancelled.                       |
| `fail`               | executing                                | `failed`, with a blocker. Off the board.                                            |
| `retry`              | failed                                   | `executing` at the next generation, until `retryCount` reaches `retryLimit` (3).    |
| `transfer_ownership` | assigned, executing                      | The worker changes. An executing transfer also advances the generation.             |
| `resolve_recovery`   | recovery_pending                         | `continue` returns to Ready, `cancel` leaves the board, `fail` records the blocker. |

`recovery_pending` accepts no other event. An expired lease or a lapsed heartbeat does not become Ready on its own. A retry past the limit is `retry_limit_reached` and stays `failed`.

## Result delivery

`deliver` is legal only from `accepted`, and only for the exact accepted revision. The destination is `dashboard` or `conversation`. A conversation delivery names the originating conversation. The state stores one ack per destination. The same idempotency key replays that ack. A second key for a destination that already has an ack does not add another. The same key used for the other destination is `idempotency_conflict`. A different revision is `delivery_revision_mismatch`.

## Errors

Invalid payloads fail schema decode. These transition errors are `ContractTransitionError`:

| Reason                                | When                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `confirmation_before_durable_receipt` | Acknowledge before the intake is recorded.                                                                    |
| `illegal_transition`                  | The event is not legal for the phase.                                                                         |
| `task_mismatch`                       | The payload task or usage project is not the acknowledged work.                                               |
| `attempt_mismatch`                    | The payload attempt is not the open assignment.                                                               |
| `implementer_mismatch`                | QA names a different implementer than the assignment.                                                         |
| `qa_same_model`                       | QA uses the implementer's model.                                                                              |
| `revision_mismatch`                   | Rework submits the same artifact revision again.                                                              |
| `acceptance_revision_mismatch`        | QA or acceptance names a revision other than the submitted one, or the revision already sent back for rework. |
| `recovery_pending_not_ready`          | Any event other than `resolve_recovery` while recovery is pending.                                            |
| `invalid_payload`                     | The state, event, or result does not match its schema.                                                        |
| `stale_generation`                    | Progress, a heartbeat, or a lapse names a generation other than the open run.                                 |
| `retry_limit_reached`                 | Retry was asked at the retry limit.                                                                           |
| `idempotency_conflict`                | The idempotency key was already used for a different command or delivery.                                     |
| `delivery_revision_mismatch`          | Delivery names a revision other than the accepted one.                                                        |
| `memory_not_eligible`                 | The memory event is not an acceptance of a proposed fact, or not a supersession of two accepted facts.        |

## Tests

From the repo root, after install:

```sh
vp run --filter @t3tools/ai-os-contracts test
vp run --filter @t3tools/ai-os-contracts typecheck
```

The tests cover valid and invalid payloads, the happy path, illegal transitions, canonical model and revision checks, the exact task URI, frozen snapshots, phase invariants, generation fences, usage kinds, memory acceptance and supersession, candidate exclusion, bounded retry, explicit recovery, idempotency, and delivery acks.
