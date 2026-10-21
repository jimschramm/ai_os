# Stage 1 contracts (v1)

These are the first ai_os contracts from [the architecture](../architecture.md). They define payloads, the legal sequence, and the errors for that sequence. They do not start workers, write to total-agent-memory, or render the dashboard.

The package is `@t3tools/ai-os-contracts` (`packages/ai-os-contracts`). Schemas are Effect Schema. Decode with `onExcessProperty: "error"` (`strictParse`) so an undeclared field, including vector hits, is rejected. Examples live in `packages/ai-os-contracts/src/examples.ts`. Contract tests live next to the schemas.

Node kinds and relationship types stay in [the memory schema](../memory-schema.md). These contracts name task, attempt, and revision identities. They do not write the graph.

## Sequence

Request, assignment, execution, independent QA, rework, accepted result.

| Phase            | Kanban  | Legal events                     |
| ---------------- | ------- | -------------------------------- |
| idle             |         | intake                           |
| requested        |         | acknowledge                      |
| acknowledged     | Ready   | assign                           |
| assigned         | Ready   | start_execution                  |
| executing        | Running | submit_completion, lease_expired |
| awaiting_qa      | Review  | qa                               |
| rework           | Ready   | start_execution                  |
| accepted         | Done    | start_execution                  |
| recovery_pending | Blocked | none                             |

`requested` is the durable receipt of the intake. It is not confirmed, and it is not on the board yet. Acknowledge is the confirmation, and it carries the task link. A later `start_execution` from `accepted` drops the previous acceptance, so a new revision has to be submitted and reviewed again.

`SequenceState` is a discriminated union on `phase`. A phase only decodes with the records that phase requires. `accepted` requires the assignment, the completion, and an available accept verdict whose revision matches that completion exactly and whose model is independent of the implementer. `awaiting_qa` can carry only an unavailable verdict. `recovery_pending` requires the label `Execution status unknown`. `kanbanColumn` still maps `accepted` to Done, and a payload that is only `{ phase: "accepted" }` does not decode.

## Intake

`IntakeV1` carries the workspace, project, request, constraints, acceptance criteria, and authorization (`standing` or `explicit`).

`IntakeAcknowledgmentV1` is a separate payload. `durable` is the literal `true`. `taskLink` must be exactly `ai-os://tasks/{taskId}`: that scheme, that path, and no extra segment, query, or fragment. A string that only contains the task id is not a link. A `false` durable flag, a missing link, or an acknowledgment before the intake fails. The failure before any intake is `confirmation_before_durable_receipt`.

## Assignment

`AssignmentV1` names the worker, the attempt, the implementer model, and a `ContextPackageSnapshotV1`: requirements, memory versions, repo commit, authorization scope, and created time. The snapshot has no vector field. Decode and assignment both deep-copy that snapshot and freeze the copy, so later mutation of the caller's object does not change the recorded context, and mutation of the stored snapshot throws. The repo commit is a git SHA, stored as lowercase hex.

## Completion submission

`CompletionSubmissionV1` carries the claimed outcome, the exact `artifactRevision`, and at least one evidence item (`diff`, `commit`, `test`, `browser`, `preview`, `deployment`, or `readback`). An artifact revision is a git SHA, a Drive file id plus version, or a named page, preview, deployment, or document id. Git SHAs compare as lowercase hex. Drive file ids stay case-sensitive. Submitting a completion moves `executing` to `awaiting_qa`. It does not accept the work. Repeating the revision that QA sent back for rework, including the same git SHA in a different case, is `revision_mismatch`.

## QA verdict and rework

`QaVerdictV1` is one of:

| Variant                     | Result                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `availability: unavailable` | Stays `awaiting_qa`. No verdict and no acceptance.                                                                                     |
| `verdict: rework`           | Moves to `rework`. Findings are required. The reviewed revision is recorded.                                                           |
| `verdict: accept`           | Moves to `accepted`. `acceptedRevision` must equal `artifactRevision`, and that revision must be the one in the completion submission. |

QA's model must differ from the assignment's implementer model. Model identity is trimmed, lowercased, and a provider prefix is normalized (`OpenAI:GPT-5.4` and `openai/gpt-5.4` are the same model; a bare `gpt-5.4` is not). The schema check and the transition both compare those canonical ids. The transition rejects a QA model equal to the assigned implementer (`qa_same_model`) and a payload that names some other implementer (`implementer_mismatch`). Acceptance compares canonical revisions, so a git SHA matches regardless of case. An unavailable verdict cannot also carry an acceptance. There is no event that skips QA.

## Errors

Invalid payloads fail schema decode. These transition errors are `ContractTransitionError`:

| Reason                                | When                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `confirmation_before_durable_receipt` | Acknowledge before the intake is recorded.                                                                    |
| `illegal_transition`                  | The event is not legal for the phase, including any attempt to leave `awaiting_qa` without a QA verdict.      |
| `task_mismatch`                       | The payload task is not the acknowledged task.                                                                |
| `attempt_mismatch`                    | The payload attempt is not the open assignment.                                                               |
| `implementer_mismatch`                | QA names a different implementer than the assignment.                                                         |
| `qa_same_model`                       | QA uses the implementer's model.                                                                              |
| `revision_mismatch`                   | Rework submits the same artifact revision again.                                                              |
| `acceptance_revision_mismatch`        | QA or acceptance names a revision other than the submitted one, or the revision already sent back for rework. |
| `recovery_pending_not_ready`          | Any event while the lease is expired.                                                                         |

`lease_expired` is legal only from `executing`. The phase becomes `recovery_pending`, the label is `Execution status unknown`, and the kanban column is Blocked. No event leaves that phase. Returning to Ready is a later contract.

## Tests

From the repo root, after install:

```sh
vp run --filter @t3tools/ai-os-contracts test
vp run --filter @t3tools/ai-os-contracts typecheck
```

The tests cover valid and invalid payloads for each contract, the happy path, illegal transitions, canonical model and revision checks, the exact task URI, frozen assignment snapshots, phase invariants, unavailable QA, exact-revision acceptance, and `recovery_pending`.
