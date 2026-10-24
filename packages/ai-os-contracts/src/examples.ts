import * as Schema from "effect/Schema";

import { AssignmentV1 } from "./assignment.ts";
import { SubmissionV1 } from "./submission.ts";
import { leaseIdFor } from "./canonical.ts";
import { strictParse } from "./common.ts";
import { CompletionSubmissionV1 } from "./completion.ts";
import { IntakeAcknowledgmentV1, IntakeV1, IntakeV2 } from "./intake.ts";
import { QaVerdictV1 } from "./qa.ts";
import type { SequenceEvent } from "./sequence.ts";

const decodeIntake = Schema.decodeUnknownSync(IntakeV1, strictParse);
const decodeIntakeV2 = Schema.decodeUnknownSync(IntakeV2, strictParse);
const decodeAcknowledgment = Schema.decodeUnknownSync(IntakeAcknowledgmentV1, strictParse);
const decodeAssignment = Schema.decodeUnknownSync(AssignmentV1, strictParse);
const decodeCompletion = Schema.decodeUnknownSync(CompletionSubmissionV1, strictParse);
const decodeQa = Schema.decodeUnknownSync(QaVerdictV1, strictParse);
const decodeSubmission = Schema.decodeUnknownSync(SubmissionV1, strictParse);

export const exampleRepoCommit = "c".repeat(40);
export const revisionOne = { type: "git" as const, sha: "a".repeat(40) };
export const revisionTwo = { type: "git" as const, sha: "b".repeat(40) };

export const intakeExample = decodeIntake({
  version: "v1",
  workspaceId: "personal",
  projectId: "usba",
  request:
    "Update the USBA tournament page, verify it, and have Marketing prepare the announcement.",
  constraints: ["Keep the public page available during the update."],
  acceptanceCriteria: ["The tournament page shows the new schedule."],
  authorization: { kind: "standing", scope: "usba-web" },
});

export const intakeV2Example = decodeIntakeV2({
  version: "v1",
  workspaceId: "personal",
  projectId: "usba",
  request:
    "Update the USBA tournament page, verify it, and have Marketing prepare the announcement.",
  constraints: ["Keep the public page available during the update."],
  acceptanceCriteria: ["The tournament page shows the new schedule."],
  authorization: { kind: "standing", scope: "usba-web" },
  originatingConversationId: "Grok-Thread-1",
});

export const acknowledgmentExample = decodeAcknowledgment({
  version: "v1",
  taskId: "task-usba-page",
  taskLink: "ai-os://tasks/task-usba-page",
  durable: true,
  receivedAt: "2026-10-21T14:00:00Z",
});

export const assignmentExample = decodeAssignment({
  version: "v1",
  taskId: "task-usba-page",
  attemptId: "attempt-1",
  assignmentId: "assignment-1",
  workerId: "t3-codex",
  implementerModel: "gpt-5.4",
  scope: "Update the USBA tournament page.",
  contextPackage: {
    requirements: "The tournament page shows the new schedule.",
    memoryVersions: ["decision-12"],
    repoCommit: exampleRepoCommit,
    authorizationScope: "usba-web",
    createdAt: "2026-10-21T14:01:00Z",
  },
});

export const completionExample = decodeCompletion({
  version: "v1",
  taskId: "task-usba-page",
  attemptId: "attempt-1",
  generation: 1,
  leaseId: leaseIdFor(1),
  claimedOutcome: "Updated the tournament page.",
  artifactRevision: revisionOne,
  evidence: [{ kind: "diff", ref: "diff-rev-1" }],
});

export const qaWaitingExample = decodeQa({
  version: "v1",
  taskId: "task-usba-page",
  attemptId: "attempt-1",
  availability: "unavailable",
});

export const qaReworkExample = decodeQa({
  version: "v1",
  taskId: "task-usba-page",
  attemptId: "attempt-1",
  availability: "available",
  qaModel: "claude-sonnet-5",
  implementerModel: "gpt-5.4",
  verdict: "rework",
  artifactRevision: revisionOne,
  findings: [
    {
      defect: "The schedule omits the final round.",
      evidence: "The preview still lists Saturday only.",
      expectedBehavior: "The page lists Saturday and Sunday.",
    },
  ],
});

export const completionAfterReworkExample = decodeCompletion({
  version: "v1",
  taskId: "task-usba-page",
  attemptId: "attempt-1",
  generation: 2,
  leaseId: leaseIdFor(2),
  claimedOutcome: "Added the final round to the tournament page.",
  artifactRevision: revisionTwo,
  evidence: [
    { kind: "diff", ref: "diff-rev-2" },
    { kind: "browser", ref: "preview-rev-2" },
  ],
});

export const qaAcceptExample = decodeQa({
  version: "v1",
  taskId: "task-usba-page",
  attemptId: "attempt-1",
  availability: "available",
  qaModel: "claude-sonnet-5",
  implementerModel: "gpt-5.4",
  verdict: "accept",
  artifactRevision: revisionTwo,
  acceptedRevision: revisionTwo,
  findings: [],
});

export const submissionExample = decodeSubmission({
  version: "v1",
  submissionId: "submission-saturday-start",
  idempotencyKey: "key-saturday-start",
  projectId: "usba",
  authorId: "codex-t3",
  taskId: "task-usba-page",
  attemptId: "attempt-1",
  evidence: [
    { evidenceId: "evidence-schedule", note: "The schedule file says Saturday starts at 7:00." },
  ],
  expectedVersions: [],
  intent: "propose",
  facts: [
    {
      identity: "tournament-start",
      fact: {
        acceptance: "proposed",
        factId: "fact-saturday-start",
        projectId: "usba",
        kind: "Decision",
        body: "Saturday games start at 7:00.",
        provenance: { actorId: "codex-t3", at: "2026-10-21T15:00:00Z" },
        validity: { from: "2026-10-21T15:00:00Z", until: null },
      },
    },
  ],
  relationships: [],
});

export const happyPathEvents: ReadonlyArray<SequenceEvent> = [
  { type: "intake", intake: intakeExample },
  { type: "acknowledge", acknowledgment: acknowledgmentExample },
  { type: "assign", assignment: assignmentExample },
  { type: "start_execution" },
  {
    type: "record_runtime_models",
    taskId: "task-usba-page",
    attemptId: "attempt-1",
    generation: 1,
    leaseId: leaseIdFor(1),
    role: "implementer",
    requested: { model: "gpt-5.4" },
    actual: { model: "gpt-5.4" },
  },
  { type: "submit_completion", completion: completionExample },
  { type: "qa", threadId: "thread-qa", qa: qaWaitingExample },
  {
    type: "record_runtime_models",
    taskId: "task-usba-page",
    attemptId: "attempt-1",
    generation: 1,
    leaseId: leaseIdFor(1),
    role: "reviewer",
    requested: { model: "claude-sonnet-5" },
    actual: { model: "claude-sonnet-5" },
  },
  { type: "qa", threadId: "thread-qa", qa: qaReworkExample },
  { type: "start_execution" },
  {
    type: "record_runtime_models",
    taskId: "task-usba-page",
    attemptId: "attempt-1",
    generation: 2,
    leaseId: leaseIdFor(2),
    role: "implementer",
    requested: { model: "gpt-5.4" },
    actual: { model: "gpt-5.4" },
  },
  { type: "submit_completion", completion: completionAfterReworkExample },
  {
    type: "record_runtime_models",
    taskId: "task-usba-page",
    attemptId: "attempt-1",
    generation: 2,
    leaseId: leaseIdFor(2),
    role: "reviewer",
    requested: { model: "claude-sonnet-5" },
    actual: { model: "claude-sonnet-5" },
  },
  { type: "qa", threadId: "thread-qa", qa: qaAcceptExample },
];
