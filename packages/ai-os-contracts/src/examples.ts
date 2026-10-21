import * as Schema from "effect/Schema";

import { AssignmentV1 } from "./assignment.ts";
import { strictParse } from "./common.ts";
import { CompletionSubmissionV1 } from "./completion.ts";
import { IntakeAcknowledgmentV1, IntakeV1 } from "./intake.ts";
import { QaVerdictV1 } from "./qa.ts";
import type { SequenceEvent } from "./sequence.ts";

const decodeIntake = Schema.decodeUnknownSync(IntakeV1, strictParse);
const decodeAcknowledgment = Schema.decodeUnknownSync(IntakeAcknowledgmentV1, strictParse);
const decodeAssignment = Schema.decodeUnknownSync(AssignmentV1, strictParse);
const decodeCompletion = Schema.decodeUnknownSync(CompletionSubmissionV1, strictParse);
const decodeQa = Schema.decodeUnknownSync(QaVerdictV1, strictParse);

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
    repoCommit: "abc123",
    authorizationScope: "usba-web",
    createdAt: "2026-10-21T14:01:00Z",
  },
});

export const completionExample = decodeCompletion({
  version: "v1",
  taskId: "task-usba-page",
  attemptId: "attempt-1",
  claimedOutcome: "Updated the tournament page.",
  artifactRevision: "rev-1",
  evidence: [{ kind: "diff", ref: "rev-1" }],
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
  artifactRevision: "rev-1",
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
  claimedOutcome: "Added the final round to the tournament page.",
  artifactRevision: "rev-2",
  evidence: [
    { kind: "diff", ref: "rev-2" },
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
  artifactRevision: "rev-2",
  acceptedRevision: "rev-2",
  findings: [],
});

export const happyPathEvents: ReadonlyArray<SequenceEvent> = [
  { type: "intake", intake: intakeExample },
  { type: "acknowledge", acknowledgment: acknowledgmentExample },
  { type: "assign", assignment: assignmentExample },
  { type: "start_execution" },
  { type: "submit_completion", completion: completionExample },
  { type: "qa", qa: qaWaitingExample },
  { type: "qa", qa: qaReworkExample },
  { type: "start_execution" },
  { type: "submit_completion", completion: completionAfterReworkExample },
  { type: "qa", qa: qaAcceptExample },
];
