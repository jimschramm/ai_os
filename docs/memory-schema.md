# Memory Schema (ai_os conventions)

Agents writing to total-agent-memory must follow these node kinds and relationship types. Free-form facts are allowed for notes, but relationships that participate in retrieval, handoff, or acceptance must use the types below.

## Node kinds

- Project, Repository, Environment
- Requirement, Instruction, Decision
- Task, Attempt, Handoff
- Artifact, Source, Verification
- Agent, User, Procedure

## Allowed relationships

- BELONGS_TO, DEPLOYED_IN
- APPLIES_TO, CONSTRAINS, SUPERSEDES
- DEPENDS_ON, IMPLEMENTS, CONTINUES
- PRODUCED_BY, SUPPORTED_BY, VERIFIED_BY
- ASSIGNED_TO, ACCEPTED_BY, USES

## Rules

- Every relationship carries provenance (who asserted it, when) and a validity window.
- A proposed relationship is not accepted knowledge until explicitly accepted.
- SUPERSEDES marks a newer fact or decision that replaces an older one; both remain queryable.
- Agents retrieve a context package of current (non-superseded, accepted) facts relevant to the task; they do not interpret the raw graph ad-hoc.
- A Task carries `taskType`: `implementation` or `advisory`. QA follows that declaration.
- Review delivered records the exact revision reviewed and the linked findings. It is not `ACCEPTED_BY` and does not satisfy independent QA.
- An implementation is `VERIFIED_BY` only after QA by a different base model than the implementer's actual model from the runtime, on the exact submitted revision. Unknown actuals are not acceptance. A rework verdict still applies when an actual is unknown. A finding that asks for a change is a new implementation task, and that implementation goes through the same QA.
