import type {
  AcceptedRelationshipV1,
  MemoryFactV1,
  MemoryGraphV1,
  MemoryNodeKindV1,
  ProvenanceV1,
  ValidityWindowV1,
} from "@t3tools/ai-os-contracts";

import type { OperationsProjectId } from "./fixtures";

export type MemoryScope = "personal" | "workspace" | "project" | "task";

export interface MemoryRecordMeta {
  readonly factId: string;
  readonly scope: MemoryScope;
  readonly taskId: string | null;
  readonly sources: readonly string[];
  readonly evidence: readonly string[];
}

export interface MemoryConflict {
  readonly id: string;
  readonly projectId: OperationsProjectId;
  readonly summary: string;
  readonly factIds: readonly [string, string];
}

const open = (from: string): ValidityWindowV1 => ({ from, until: null });
const by = (actorId: string, at: string): ProvenanceV1 => ({ actorId, at });

function accepted(input: {
  readonly factId: string;
  readonly projectId: OperationsProjectId;
  readonly kind: MemoryNodeKindV1;
  readonly body: string;
  readonly actorId: string;
  readonly at: string;
}): MemoryFactV1 {
  return {
    acceptance: "accepted",
    factId: input.factId,
    projectId: input.projectId,
    kind: input.kind,
    body: input.body,
    provenance: by(input.actorId, input.at),
    validity: open(input.at),
    acceptedBy: input.actorId,
    acceptedAt: input.at,
  };
}

function proposed(input: {
  readonly factId: string;
  readonly projectId: OperationsProjectId;
  readonly kind: MemoryNodeKindV1;
  readonly body: string;
  readonly actorId: string;
  readonly at: string;
}): MemoryFactV1 {
  return {
    acceptance: "proposed",
    factId: input.factId,
    projectId: input.projectId,
    kind: input.kind,
    body: input.body,
    provenance: by(input.actorId, input.at),
    validity: open(input.at),
  };
}

const edge = (input: {
  readonly relationshipId: string;
  readonly projectId: OperationsProjectId;
  readonly relationshipType: AcceptedRelationshipV1["relationshipType"];
  readonly fromId: string;
  readonly toId: string;
  readonly actorId: string;
  readonly at: string;
}): AcceptedRelationshipV1 => ({
  acceptance: "accepted",
  relationshipId: input.relationshipId,
  projectId: input.projectId,
  relationshipType: input.relationshipType,
  fromId: input.fromId,
  toId: input.toId,
  provenance: by(input.actorId, input.at),
  validity: open(input.at),
  acceptedBy: input.actorId,
  acceptedAt: input.at,
});

const saturdayOld: MemoryFactV1 = {
  acceptance: "superseded",
  factId: "fact-saturday-830",
  projectId: "usba",
  kind: "Decision",
  body: "Saturday's public start time is 8:30 a.m.",
  provenance: by("usba-editor", "2026-09-01T15:00:00Z"),
  validity: { from: "2026-09-01T15:00:00Z", until: "2026-10-18T15:00:00Z" },
  acceptedBy: "usba-editor",
  acceptedAt: "2026-09-01T15:00:00Z",
  supersededBy: "fact-saturday-start",
};

export const MEMORY_GRAPH: MemoryGraphV1 = {
  facts: [
    accepted({
      factId: "fact-personal-replies",
      projectId: "personal",
      kind: "Instruction",
      body: "Replies go out only after you confirm the draft.",
      actorId: "you",
      at: "2026-10-02T12:00:00Z",
    }),
    accepted({
      factId: "fact-personal-notes",
      projectId: "personal",
      kind: "Decision",
      body: "Trip notes stay in the personal vault.",
      actorId: "you",
      at: "2026-10-11T18:00:00Z",
    }),
    accepted({
      factId: "fact-personal-pref",
      projectId: "personal",
      kind: "User",
      body: "Keep personal notes under a page.",
      actorId: "you",
      at: "2026-10-11T18:05:00Z",
    }),
    accepted({
      factId: "fact-usba-project",
      projectId: "usba",
      kind: "Project",
      body: "USBA is the public club site.",
      actorId: "usba-editor",
      at: "2026-08-01T12:00:00Z",
    }),
    accepted({
      factId: "fact-workspace-voice",
      projectId: "usba",
      kind: "Instruction",
      body: "Write for members, not for staff.",
      actorId: "usba-editor",
      at: "2026-08-02T12:00:00Z",
    }),
    accepted({
      factId: "fact-governing-copy",
      projectId: "usba",
      kind: "Instruction",
      body: "Publish only an accepted start time. Do not invent one.",
      actorId: "usba-editor",
      at: "2026-10-01T12:00:00Z",
    }),
    accepted({
      factId: "fact-saturday-start",
      projectId: "usba",
      kind: "Decision",
      body: "Saturday's public start time is 9:00 a.m.",
      actorId: "usba-editor",
      at: "2026-10-18T15:00:00Z",
    }),
    saturdayOld,
    accepted({
      factId: "fact-friday-7",
      projectId: "usba",
      kind: "Decision",
      body: "Friday night starts at 7:00 p.m.",
      actorId: "usba-editor",
      at: "2026-10-19T18:00:00Z",
    }),
    accepted({
      factId: "fact-friday-6",
      projectId: "usba",
      kind: "Decision",
      body: "Friday night starts at 6:00 p.m.",
      actorId: "qa-reviewer",
      at: "2026-10-19T18:10:00Z",
    }),
    accepted({
      factId: "fact-gym",
      projectId: "usba",
      kind: "Requirement",
      body: "The public location is the downtown gym.",
      actorId: "usba-editor",
      at: "2026-10-04T12:00:00Z",
    }),
    accepted({
      factId: "fact-hero-photo",
      projectId: "usba",
      kind: "Requirement",
      body: "The approved hero photo is the Saturday court shot.",
      actorId: "usba-editor",
      at: "2026-10-12T12:00:00Z",
    }),
    accepted({
      factId: "fact-score-sheet",
      projectId: "usba",
      kind: "Source",
      body: "The score sheet in the vault is the source for public results.",
      actorId: "usba-editor",
      at: "2026-10-10T12:00:00Z",
    }),
    accepted({
      factId: "fact-verify-schedule",
      projectId: "usba",
      kind: "Verification",
      body: "The schedule heading was read back as 9:00 a.m.",
      actorId: "qa-reviewer",
      at: "2026-10-18T16:00:00Z",
    }),
    accepted({
      factId: "fact-procedure-publish",
      projectId: "usba",
      kind: "Procedure",
      body: "Publish a page only after QA accepts that revision.",
      actorId: "codex-t3",
      at: "2026-10-08T12:00:00Z",
    }),
    accepted({
      factId: "fact-preference-photo",
      projectId: "usba",
      kind: "User",
      body: "Prefer the Saturday court shot over last year's banner.",
      actorId: "you",
      at: "2026-10-12T13:00:00Z",
    }),
    accepted({
      factId: "fact-handoff-schedule",
      projectId: "usba",
      kind: "Handoff",
      body: "Codex via T3 hands the schedule copy to the QA reviewer.",
      actorId: "codex-t3",
      at: "2026-10-21T15:42:00Z",
    }),
    accepted({
      factId: "fact-task-saturday",
      projectId: "usba",
      kind: "Task",
      body: "Saturday schedule copy.",
      actorId: "you",
      at: "2026-10-21T15:20:00Z",
    }),
    accepted({
      factId: "fact-attempt-saturday",
      projectId: "usba",
      kind: "Attempt",
      body: "Second pass on the schedule body.",
      actorId: "codex-t3",
      at: "2026-10-21T15:40:00Z",
    }),
    accepted({
      factId: "fact-artifact-schedule",
      projectId: "usba",
      kind: "Artifact",
      body: "Schedule diff 11aa22b.",
      actorId: "codex-t3",
      at: "2026-10-21T16:02:00Z",
    }),
    proposed({
      factId: "fact-banner-proposed",
      projectId: "usba",
      kind: "User",
      body: "Put last year's banner back on the homepage.",
      actorId: "grok-bot",
      at: "2026-10-20T11:00:00Z",
    }),
    accepted({
      factId: "fact-candidates-are-not-context",
      projectId: "ai_os",
      kind: "Instruction",
      body: "A vector candidate is a suggestion until someone accepts it.",
      actorId: "you",
      at: "2026-10-21T16:00:00Z",
    }),
    accepted({
      factId: "fact-mockup-is-static",
      projectId: "ai_os",
      kind: "Decision",
      body: "This screen is a mockup. Actions are not sent anywhere.",
      actorId: "you",
      at: "2026-10-21T16:20:00Z",
    }),
    accepted({
      factId: "fact-ai-procedure",
      projectId: "ai_os",
      kind: "Procedure",
      body: "Read the contract, then the fixture, before changing either.",
      actorId: "codex-t3",
      at: "2026-10-21T16:10:00Z",
    }),
    accepted({
      factId: "fact-ai-task",
      projectId: "ai_os",
      kind: "Task",
      body: "Mockup review.",
      actorId: "qa-reviewer",
      at: "2026-10-21T16:40:00Z",
    }),
  ],
  relationships: [
    edge({
      relationshipId: "rel-saturday-supersede",
      projectId: "usba",
      relationshipType: "SUPERSEDES",
      fromId: "fact-saturday-start",
      toId: "fact-saturday-830",
      actorId: "usba-editor",
      at: "2026-10-18T15:00:00Z",
    }),
    edge({
      relationshipId: "rel-saturday-support",
      projectId: "usba",
      relationshipType: "SUPPORTED_BY",
      fromId: "fact-saturday-start",
      toId: "fact-score-sheet",
      actorId: "usba-editor",
      at: "2026-10-18T15:05:00Z",
    }),
    edge({
      relationshipId: "rel-saturday-verify",
      projectId: "usba",
      relationshipType: "VERIFIED_BY",
      fromId: "fact-saturday-start",
      toId: "fact-verify-schedule",
      actorId: "qa-reviewer",
      at: "2026-10-18T16:00:00Z",
    }),
    edge({
      relationshipId: "rel-governing-applies",
      projectId: "usba",
      relationshipType: "APPLIES_TO",
      fromId: "fact-governing-copy",
      toId: "fact-task-saturday",
      actorId: "usba-editor",
      at: "2026-10-21T15:20:00Z",
    }),
    edge({
      relationshipId: "rel-task-belongs",
      projectId: "usba",
      relationshipType: "BELONGS_TO",
      fromId: "fact-task-saturday",
      toId: "fact-usba-project",
      actorId: "you",
      at: "2026-10-21T15:20:00Z",
    }),
    edge({
      relationshipId: "rel-attempt-continues",
      projectId: "usba",
      relationshipType: "CONTINUES",
      fromId: "fact-attempt-saturday",
      toId: "fact-task-saturday",
      actorId: "codex-t3",
      at: "2026-10-21T15:40:00Z",
    }),
    edge({
      relationshipId: "rel-artifact-produced",
      projectId: "usba",
      relationshipType: "PRODUCED_BY",
      fromId: "fact-artifact-schedule",
      toId: "fact-attempt-saturday",
      actorId: "codex-t3",
      at: "2026-10-21T16:02:00Z",
    }),
  ],
};

export const MEMORY_META: readonly MemoryRecordMeta[] = [
  {
    factId: "fact-personal-replies",
    scope: "personal",
    taskId: "inbox-triage",
    sources: ["Your mail rule"],
    evidence: ["No reply leaves without a confirmation."],
  },
  {
    factId: "fact-personal-notes",
    scope: "personal",
    taskId: "trip-notes",
    sources: ["Personal vault"],
    evidence: ["note://trip/portland"],
  },
  {
    factId: "fact-personal-pref",
    scope: "personal",
    taskId: null,
    sources: ["You"],
    evidence: ["The Portland note fits on one page."],
  },
  {
    factId: "fact-usba-project",
    scope: "project",
    taskId: null,
    sources: ["Club charter"],
    evidence: ["The public site is the member-facing surface."],
  },
  {
    factId: "fact-workspace-voice",
    scope: "workspace",
    taskId: null,
    sources: ["Editorial guide"],
    evidence: ["Staff notes stay out of the public page."],
  },
  {
    factId: "fact-governing-copy",
    scope: "project",
    taskId: null,
    sources: ["Editorial guide"],
    evidence: ["A start time is published only after acceptance."],
  },
  {
    factId: "fact-saturday-start",
    scope: "project",
    taskId: "saturday-copy",
    sources: ["Saturday meeting notes", "Vault score sheet"],
    evidence: ["The heading was read back as 9:00 a.m."],
  },
  {
    factId: "fact-saturday-830",
    scope: "project",
    taskId: "saturday-copy",
    sources: ["Old schedule draft"],
    evidence: ["The September page said 8:30 a.m."],
  },
  {
    factId: "fact-friday-7",
    scope: "project",
    taskId: null,
    sources: ["Saturday meeting notes"],
    evidence: ["The chair said seven."],
  },
  {
    factId: "fact-friday-6",
    scope: "project",
    taskId: null,
    sources: ["Coach email"],
    evidence: ["The email says six."],
  },
  {
    factId: "fact-gym",
    scope: "project",
    taskId: null,
    sources: ["Club charter"],
    evidence: ["The public page names the downtown gym."],
  },
  {
    factId: "fact-hero-photo",
    scope: "project",
    taskId: "homepage-hero",
    sources: ["Photo library"],
    evidence: ["The court shot is the approved file."],
  },
  {
    factId: "fact-score-sheet",
    scope: "project",
    taskId: "bracket-sync",
    sources: ["Vault"],
    evidence: ["vault://usba/scores"],
  },
  {
    factId: "fact-verify-schedule",
    scope: "project",
    taskId: "saturday-copy",
    sources: ["QA readback"],
    evidence: ["preview://usba/schedule"],
  },
  {
    factId: "fact-procedure-publish",
    scope: "workspace",
    taskId: null,
    sources: ["Publishing checklist"],
    evidence: ["The tournament page waited for QA."],
  },
  {
    factId: "fact-preference-photo",
    scope: "project",
    taskId: "homepage-hero",
    sources: ["You"],
    evidence: ["You picked the court shot in the library."],
  },
  {
    factId: "fact-handoff-schedule",
    scope: "task",
    taskId: "saturday-copy",
    sources: ["Codex via T3"],
    evidence: ["The draft is waiting on QA."],
  },
  {
    factId: "fact-task-saturday",
    scope: "task",
    taskId: "saturday-copy",
    sources: ["Intake"],
    evidence: ["Thread-saturday-copy"],
  },
  {
    factId: "fact-attempt-saturday",
    scope: "task",
    taskId: "saturday-copy",
    sources: ["Codex via T3"],
    evidence: ["Attempt 2 is the current pass."],
  },
  {
    factId: "fact-artifact-schedule",
    scope: "task",
    taskId: "saturday-copy",
    sources: ["Git"],
    evidence: ["diff://usba/schedule/attempt-1"],
  },
  {
    factId: "fact-banner-proposed",
    scope: "project",
    taskId: "homepage-hero",
    sources: ["Grok Bot suggestion"],
    evidence: ["No one accepted the old banner."],
  },
  {
    factId: "fact-candidates-are-not-context",
    scope: "project",
    taskId: "contract-check",
    sources: ["Contract notes"],
    evidence: ["Candidates stay out of the context package."],
  },
  {
    factId: "fact-mockup-is-static",
    scope: "project",
    taskId: "mockup-review",
    sources: ["You"],
    evidence: ["Actions on this screen are not sent."],
  },
  {
    factId: "fact-ai-procedure",
    scope: "workspace",
    taskId: null,
    sources: ["Working notes"],
    evidence: ["The fixture is checked against the contract."],
  },
  {
    factId: "fact-ai-task",
    scope: "task",
    taskId: "mockup-review",
    sources: ["Intake"],
    evidence: ["Thread-mockup-review"],
  },
];

export const MEMORY_CONFLICTS: readonly MemoryConflict[] = [
  {
    id: "conflict-friday-start",
    projectId: "usba",
    summary: "Two accepted decisions name a different Friday night start.",
    factIds: ["fact-friday-7", "fact-friday-6"],
  },
];

export const SEEDED_REJECTIONS: readonly string[] = ["fact-banner-proposed"];

export const AUTHOR_LABELS: Readonly<Record<string, string>> = {
  you: "You",
  "usba-editor": "USBA editor",
  "qa-reviewer": "QA reviewer",
  "grok-bot": "Grok Bot",
  "codex-t3": "Codex via T3",
};
