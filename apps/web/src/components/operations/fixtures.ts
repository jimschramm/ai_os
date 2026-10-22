import {
  leaseIdFor,
  type ArtifactRevisionV1,
  type AssignmentV1,
  type CompletionSubmissionV1,
  type ContextPackageSnapshotV1,
  type IntakeV2,
  type MemoryCandidateV1,
  type ProgressReportV1,
  type QaVerdictV1,
  type SequencePhase,
  type UsageMeasurementV1,
} from "@t3tools/ai-os-contracts";

export type OperationsProjectId = "personal" | "usba" | "ai_os";

export interface OperationsAgent {
  readonly id: string;
  readonly name: string;
  readonly surface: string;
  readonly mode: "active" | "update-only";
  readonly assignment: string;
}

export interface OperationsFact {
  readonly factId: string;
  readonly body: string;
}

export interface NeedsYouItem {
  readonly id: string;
  readonly kind: "blocker" | "decision";
  readonly summary: string;
  readonly nextAction: string;
  readonly actionLabel: string;
}

export interface OperationsProject {
  readonly id: OperationsProjectId;
  readonly label: string;
  readonly detail: string;
  readonly agents: readonly OperationsAgent[];
}

export interface OperationsTask {
  readonly id: string;
  readonly projectId: string;
  readonly phase: SequencePhase;
  readonly title: string;
  readonly agent: string;
  readonly surface: string;
  readonly updatedAt: string;
  readonly intake: IntakeV2;
  readonly assignment: AssignmentV1 | null;
  readonly progress: readonly ProgressReportV1[];
  readonly completion: CompletionSubmissionV1 | null;
  readonly qa: QaVerdictV1 | null;
  readonly revision: ArtifactRevisionV1 | null;
  readonly facts: readonly OperationsFact[];
  readonly candidates: readonly MemoryCandidateV1[];
  readonly usage: readonly UsageMeasurementV1[];
  readonly needsYou: NeedsYouItem | null;
  readonly result: string | null;
}

const git = (sha: string): ArtifactRevisionV1 => ({ type: "git", sha });

const context = (
  requirements: string,
  memoryVersions: readonly string[],
  repoCommit: string,
  authorizationScope: string,
  createdAt: string,
): ContextPackageSnapshotV1 => ({
  requirements,
  memoryVersions,
  repoCommit,
  authorizationScope,
  createdAt,
});

const intake = (
  task: Pick<OperationsTask, "id" | "projectId">,
  request: string,
  acceptanceCriteria: readonly [string, ...string[]],
  authorizationScope: string,
): IntakeV2 => ({
  version: "v1",
  workspaceId: task.projectId,
  projectId: task.projectId,
  request,
  constraints: [],
  acceptanceCriteria,
  authorization: { kind: "standing", scope: authorizationScope },
  originatingConversationId: `Thread-${task.id}`,
});

const attribution = (
  task: Pick<OperationsTask, "id" | "projectId">,
  agentId: string,
  platform: UsageMeasurementV1["attribution"]["platform"],
  model: string,
): UsageMeasurementV1["attribution"] => ({
  projectId: task.projectId,
  taskId: task.id,
  attemptId: `${task.id}-attempt-1`,
  agentId,
  platform,
  provider: "openai",
  model: { model },
});

export const OPERATIONS_PROJECTS = [
  {
    id: "personal",
    label: "Personal",
    detail: "Notes and the inbox",
    agents: [
      {
        id: "grok-bot",
        name: "Grok Bot",
        surface: "Conversation",
        mode: "active",
        assignment: "Inbox triage",
      },
      {
        id: "vault",
        name: "Vault",
        surface: "External",
        mode: "update-only",
        assignment: "Update only",
      },
      {
        id: "web",
        name: "Web",
        surface: "External",
        mode: "update-only",
        assignment: "Update only",
      },
      {
        id: "marketing",
        name: "Marketing",
        surface: "External",
        mode: "update-only",
        assignment: "Update only",
      },
    ],
  },
  {
    id: "usba",
    label: "USBA",
    detail: "Public site and Saturday schedule",
    agents: [
      {
        id: "grok-bot",
        name: "Grok Bot",
        surface: "Conversation",
        mode: "active",
        assignment: "Member questions",
      },
      {
        id: "codex-t3",
        name: "Codex via T3",
        surface: "T3",
        mode: "active",
        assignment: "Homepage hero",
      },
      {
        id: "codex-vscode",
        name: "Codex in VS Code",
        surface: "VS Code",
        mode: "active",
        assignment: "Bracket sync",
      },
      {
        id: "qa-reviewer",
        name: "QA reviewer",
        surface: "Review",
        mode: "active",
        assignment: "Announcement draft",
      },
      {
        id: "vault",
        name: "Vault",
        surface: "External",
        mode: "update-only",
        assignment: "Update only",
      },
      {
        id: "web",
        name: "Web",
        surface: "External",
        mode: "update-only",
        assignment: "Update only",
      },
      {
        id: "marketing",
        name: "Marketing",
        surface: "External",
        mode: "update-only",
        assignment: "Update only",
      },
    ],
  },
  {
    id: "ai_os",
    label: "ai_os",
    detail: "Local agent work",
    agents: [
      {
        id: "codex-vscode",
        name: "Codex in VS Code",
        surface: "VS Code",
        mode: "active",
        assignment: "Local contract check",
      },
      {
        id: "qa-reviewer",
        name: "QA reviewer",
        surface: "Review",
        mode: "active",
        assignment: "Mockup review",
      },
      {
        id: "vault",
        name: "Vault",
        surface: "External",
        mode: "update-only",
        assignment: "Update only",
      },
      {
        id: "web",
        name: "Web",
        surface: "External",
        mode: "update-only",
        assignment: "Update only",
      },
      {
        id: "marketing",
        name: "Marketing",
        surface: "External",
        mode: "update-only",
        assignment: "Update only",
      },
    ],
  },
] as const satisfies readonly OperationsProject[];

const repo = "c4e1b0a9d8f7465e3b2a1908c7d6e5f4a3b2c1d0";

export const OPERATIONS_TASKS: readonly OperationsTask[] = [
  {
    id: "inbox-triage",
    projectId: "personal",
    phase: "assigned",
    title: "Inbox triage",
    agent: "Grok Bot",
    surface: "Conversation",
    updatedAt: "2026-10-21T13:05:00Z",
    intake: intake(
      { id: "inbox-triage", projectId: "personal" },
      "Sort this morning's mail and leave the three that need a reply at the top.",
      ["Three messages are marked for a reply.", "Newsletters stay unread and unsent."],
      "personal-mail",
    ),
    assignment: {
      version: "v1",
      taskId: "inbox-triage",
      attemptId: "inbox-triage-attempt-1",
      assignmentId: "inbox-triage-assignment-1",
      workerId: "grok-bot",
      implementerModel: { model: "grok-4" },
      scope: "Read mail. Do not send replies.",
      contextPackage: context(
        "Reply to people, leave newsletters alone.",
        ["fact-personal-replies"],
        repo,
        "personal-mail",
        "2026-10-21T13:04:00Z",
      ),
    },
    progress: [],
    completion: null,
    qa: null,
    revision: null,
    facts: [
      {
        factId: "fact-personal-replies",
        body: "Replies go out only after you confirm the draft.",
      },
    ],
    candidates: [
      {
        nodeId: "chroma-old-newsletter-rule",
        score: 0.41,
        source: "chroma",
      },
    ],
    usage: [
      {
        kind: "unknown",
        reason: "The conversation client did not report tokens.",
        attribution: attribution(
          { id: "inbox-triage", projectId: "personal" },
          "grok-bot",
          "conversation",
          "grok-4",
        ),
      },
    ],
    needsYou: null,
    result: null,
  },
  {
    id: "trip-notes",
    projectId: "personal",
    phase: "accepted",
    title: "Trip notes",
    agent: "Grok Bot",
    surface: "Conversation",
    updatedAt: "2026-10-20T18:12:00Z",
    intake: intake(
      { id: "trip-notes", projectId: "personal" },
      "Turn the voice memo into a short trip note.",
      ["The note names the city, the date, and the one thing to remember."],
      "personal-notes",
    ),
    assignment: {
      version: "v1",
      taskId: "trip-notes",
      attemptId: "trip-notes-attempt-1",
      assignmentId: "trip-notes-assignment-1",
      workerId: "grok-bot",
      implementerModel: { model: "grok-4" },
      scope: "Write the note. Do not book anything.",
      contextPackage: context(
        "Keep the note under a page.",
        ["fact-personal-notes"],
        repo,
        "personal-notes",
        "2026-10-20T17:40:00Z",
      ),
    },
    progress: [],
    completion: {
      version: "v1",
      taskId: "trip-notes",
      attemptId: "trip-notes-attempt-1",
      generation: 1,
      leaseId: leaseIdFor(1),
      claimedOutcome: "Wrote the Portland note.",
      artifactRevision: git("9b1e4c2d0a6f8e7b5c3d1a9f0e8b7c6d5a4f3e21"),
      evidence: [{ kind: "readback", ref: "note:trip:portland" }],
    },
    qa: {
      version: "v1",
      taskId: "trip-notes",
      attemptId: "trip-notes-attempt-1",
      availability: "available",
      qaModel: { model: "claude-sonnet-5" },
      implementerModel: { model: "grok-4" },
      verdict: "accept",
      artifactRevision: git("9b1e4c2d0a6f8e7b5c3d1a9f0e8b7c6d5a4f3e21"),
      acceptedRevision: git("9b1e4c2d0a6f8e7b5c3d1a9f0e8b7c6d5a4f3e21"),
      findings: [],
    },
    revision: git("9b1e4c2d0a6f8e7b5c3d1a9f0e8b7c6d5a4f3e21"),
    facts: [
      {
        factId: "fact-personal-notes",
        body: "Trip notes stay in the personal vault.",
      },
    ],
    candidates: [],
    usage: [
      {
        kind: "subscription_allocation",
        shareBps: 250,
        attribution: attribution(
          { id: "trip-notes", projectId: "personal" },
          "grok-bot",
          "conversation",
          "grok-4",
        ),
      },
    ],
    needsYou: null,
    result: "Portland note is saved.",
  },
  {
    id: "member-questions",
    projectId: "usba",
    phase: "assigned",
    title: "Member questions",
    agent: "Grok Bot",
    surface: "Conversation",
    updatedAt: "2026-10-21T15:10:00Z",
    intake: intake(
      { id: "member-questions", projectId: "usba" },
      "Answer the two member questions about Saturday's start time. Do not change the public page.",
      ["Both answers use 9:00 a.m.", "The public page is unchanged."],
      "usba-conversation",
    ),
    assignment: {
      version: "v1",
      taskId: "member-questions",
      attemptId: "member-questions-attempt-1",
      assignmentId: "member-questions-assignment-1",
      workerId: "grok-bot",
      implementerModel: { model: "grok-4" },
      scope: "Draft answers. Do not publish.",
      contextPackage: context(
        "Saturday starts at 9:00 a.m. local time.",
        ["fact-governing-copy", "fact-saturday-start"],
        repo,
        "usba-conversation",
        "2026-10-21T15:08:00Z",
      ),
    },
    progress: [],
    completion: null,
    qa: null,
    revision: null,
    facts: [
      {
        factId: "fact-saturday-start",
        body: "Saturday's public start time is 9:00 a.m.",
      },
    ],
    candidates: [
      {
        nodeId: "chroma-friday-start",
        score: 0.58,
        source: "chroma",
      },
    ],
    usage: [
      {
        kind: "reported_tokens",
        inputTokens: 820,
        outputTokens: 140,
        attribution: attribution(
          { id: "member-questions", projectId: "usba" },
          "grok-bot",
          "conversation",
          "grok-4",
        ),
      },
    ],
    needsYou: null,
    result: null,
  },
  {
    id: "saturday-copy",
    projectId: "usba",
    phase: "rework",
    title: "Saturday schedule copy",
    agent: "Codex via T3",
    surface: "T3",
    updatedAt: "2026-10-21T16:02:00Z",
    intake: intake(
      { id: "saturday-copy", projectId: "usba" },
      "Update the Saturday schedule copy so the start time matches the accepted fact.",
      ["The page says 9:00 a.m.", "No other section changes."],
      "usba-web",
    ),
    assignment: {
      version: "v1",
      taskId: "saturday-copy",
      attemptId: "saturday-copy-attempt-1",
      assignmentId: "saturday-copy-assignment-1",
      workerId: "codex-t3",
      implementerModel: { model: "gpt-5.4" },
      scope: "Edit the schedule section only.",
      contextPackage: context(
        "Replace the old start time. Leave the rest of the page.",
        ["fact-governing-copy", "fact-saturday-start", "fact-gym"],
        repo,
        "usba-web",
        "2026-10-21T15:40:00Z",
      ),
    },
    progress: [
      {
        version: "v1",
        taskId: "saturday-copy",
        attemptId: "saturday-copy-attempt-1",
        generation: 1,
        leaseId: leaseIdFor(1),
        status: "working",
        blockers: [],
        partialArtifacts: [],
      },
    ],
    completion: {
      version: "v1",
      taskId: "saturday-copy",
      attemptId: "saturday-copy-attempt-1",
      generation: 1,
      leaseId: leaseIdFor(1),
      claimedOutcome: "Updated the schedule heading.",
      artifactRevision: git("11aa22bb33cc44dd55ee66ff77889900aabbccdd"),
      evidence: [{ kind: "diff", ref: "diff:usba:schedule:attempt-1" }],
    },
    qa: {
      version: "v1",
      taskId: "saturday-copy",
      attemptId: "saturday-copy-attempt-1",
      availability: "available",
      qaModel: { model: "claude-sonnet-5" },
      implementerModel: { model: "gpt-5.4" },
      verdict: "rework",
      artifactRevision: git("11aa22bb33cc44dd55ee66ff77889900aabbccdd"),
      findings: [
        {
          defect: "The body still says 8:30 a.m.",
          evidence: "The schedule paragraph was not updated.",
          expectedBehavior: "Every visible start time says 9:00 a.m.",
        },
      ],
    },
    revision: git("11aa22bb33cc44dd55ee66ff77889900aabbccdd"),
    facts: [
      {
        factId: "fact-saturday-start",
        body: "Saturday's public start time is 9:00 a.m.",
      },
    ],
    candidates: [
      {
        nodeId: "chroma-old-830-copy",
        score: 0.77,
        source: "chroma",
      },
    ],
    usage: [
      {
        kind: "reported_tokens",
        inputTokens: 4100,
        outputTokens: 960,
        attribution: attribution(
          { id: "saturday-copy", projectId: "usba" },
          "codex-t3",
          "t3",
          "gpt-5.4",
        ),
      },
      {
        kind: "estimated_cost",
        amountMinor: 18,
        currency: "USD",
        attribution: attribution(
          { id: "saturday-copy", projectId: "usba" },
          "codex-t3",
          "t3",
          "gpt-5.4",
        ),
      },
    ],
    needsYou: {
      id: "saturday-copy-decision",
      kind: "decision",
      summary: "QA sent the schedule copy back. The heading is right and the body is not.",
      nextAction: "Approve a second pass that changes only the body time.",
      actionLabel: "Approve the pass",
    },
    result: null,
  },
  {
    id: "homepage-hero",
    projectId: "usba",
    phase: "executing",
    title: "Homepage hero",
    agent: "Codex via T3",
    surface: "T3",
    updatedAt: "2026-10-21T16:40:00Z",
    intake: intake(
      { id: "homepage-hero", projectId: "usba" },
      "Replace the homepage hero with the Saturday tournament photo and a one-line caption.",
      ["The hero uses the approved photo.", "The caption names Saturday and the location."],
      "usba-web",
    ),
    assignment: {
      version: "v1",
      taskId: "homepage-hero",
      attemptId: "homepage-hero-attempt-1",
      assignmentId: "homepage-hero-assignment-1",
      workerId: "codex-t3",
      implementerModel: { model: "gpt-5.4" },
      scope: "Hero only.",
      contextPackage: context(
        "Use the approved photo. Do not rewrite navigation.",
        ["fact-governing-copy", "fact-hero-photo"],
        repo,
        "usba-web",
        "2026-10-21T16:12:00Z",
      ),
    },
    progress: [
      {
        version: "v1",
        taskId: "homepage-hero",
        attemptId: "homepage-hero-attempt-1",
        generation: 1,
        leaseId: leaseIdFor(1),
        status: "working",
        blockers: [],
        partialArtifacts: [
          {
            artifactId: "hero",
            revision: git("22bb33cc44dd55ee66ff77889900aabbccddeeff"),
            note: "Photo is in place. Caption is still a placeholder.",
          },
        ],
      },
    ],
    completion: null,
    qa: null,
    revision: git("22bb33cc44dd55ee66ff77889900aabbccddeeff"),
    facts: [
      {
        factId: "fact-hero-photo",
        body: "The approved hero photo is the Saturday court shot.",
      },
    ],
    candidates: [
      {
        nodeId: "chroma-last-year-banner",
        score: 0.49,
        source: "chroma",
      },
    ],
    usage: [
      {
        kind: "reported_tokens",
        inputTokens: 6200,
        outputTokens: 1500,
        attribution: attribution(
          { id: "homepage-hero", projectId: "usba" },
          "codex-t3",
          "t3",
          "gpt-5.4",
        ),
      },
    ],
    needsYou: null,
    result: null,
  },
  {
    id: "bracket-sync",
    projectId: "usba",
    phase: "recovery_pending",
    title: "Bracket sync",
    agent: "Codex in VS Code",
    surface: "VS Code",
    updatedAt: "2026-10-21T16:18:00Z",
    intake: intake(
      { id: "bracket-sync", projectId: "usba" },
      "Sync the public bracket with the latest scores.",
      ["Every finished game shows the recorded winner.", "Unplayed games stay blank."],
      "usba-web",
    ),
    assignment: {
      version: "v1",
      taskId: "bracket-sync",
      attemptId: "bracket-sync-attempt-1",
      assignmentId: "bracket-sync-assignment-1",
      workerId: "codex-vscode",
      implementerModel: { model: "gpt-5.4" },
      scope: "Bracket data only.",
      contextPackage: context(
        "Scores come from the accepted score sheet.",
        ["fact-score-sheet"],
        repo,
        "usba-web",
        "2026-10-21T15:50:00Z",
      ),
    },
    progress: [
      {
        version: "v1",
        taskId: "bracket-sync",
        attemptId: "bracket-sync-attempt-1",
        generation: 1,
        leaseId: leaseIdFor(1),
        status: "blocked",
        blockers: [
          {
            summary: "The editor stopped answering before the last score was written.",
            ownerId: "you",
            nextAction: "Check the last heartbeat, then retry or take over the edit.",
          },
        ],
        partialArtifacts: [],
      },
    ],
    completion: null,
    qa: null,
    revision: git("33cc44dd55ee66ff77889900aabbccddeeff0011"),
    facts: [
      {
        factId: "fact-score-sheet",
        body: "The score sheet in the vault is the source for public results.",
      },
    ],
    candidates: [],
    usage: [
      {
        kind: "unknown",
        reason: "VS Code did not report this session.",
        attribution: attribution(
          { id: "bracket-sync", projectId: "usba" },
          "codex-vscode",
          "vscode",
          "gpt-5.4",
        ),
      },
    ],
    needsYou: {
      id: "bracket-sync-blocker",
      kind: "blocker",
      summary: "Execution status unknown. The last heartbeat was missed.",
      nextAction: "Check the last heartbeat, then retry or take over the edit.",
      actionLabel: "I'll take it",
    },
    result: null,
  },
  {
    id: "announcement-draft",
    projectId: "usba",
    phase: "awaiting_qa",
    title: "Announcement draft",
    agent: "QA reviewer",
    surface: "Review",
    updatedAt: "2026-10-21T16:28:00Z",
    intake: intake(
      { id: "announcement-draft", projectId: "usba" },
      "Draft the Saturday announcement for the homepage.",
      ["It names 9:00 a.m. and the gym.", "It does not mention last year's date."],
      "usba-web",
    ),
    assignment: {
      version: "v1",
      taskId: "announcement-draft",
      attemptId: "announcement-draft-attempt-1",
      assignmentId: "announcement-draft-assignment-1",
      workerId: "codex-t3",
      implementerModel: { model: "gpt-5.4" },
      scope: "Announcement copy only.",
      contextPackage: context(
        "Use the accepted start time and location.",
        ["fact-governing-copy", "fact-saturday-start", "fact-gym"],
        repo,
        "usba-web",
        "2026-10-21T14:20:00Z",
      ),
    },
    progress: [
      {
        version: "v1",
        taskId: "announcement-draft",
        attemptId: "announcement-draft-attempt-1",
        generation: 1,
        leaseId: leaseIdFor(1),
        status: "working",
        blockers: [],
        partialArtifacts: [],
      },
    ],
    completion: {
      version: "v1",
      taskId: "announcement-draft",
      attemptId: "announcement-draft-attempt-1",
      generation: 1,
      leaseId: leaseIdFor(1),
      claimedOutcome: "Drafted the announcement.",
      artifactRevision: git("44dd55ee66ff77889900aabbccddeeff00112233"),
      evidence: [
        { kind: "diff", ref: "diff:usba:announcement" },
        { kind: "preview", ref: "preview:usba:home" },
      ],
    },
    qa: {
      version: "v1",
      taskId: "announcement-draft",
      attemptId: "announcement-draft-attempt-1",
      availability: "unavailable",
    },
    revision: git("44dd55ee66ff77889900aabbccddeeff00112233"),
    facts: [
      {
        factId: "fact-saturday-start",
        body: "Saturday's public start time is 9:00 a.m.",
      },
      {
        factId: "fact-gym",
        body: "The public location is the downtown gym.",
      },
    ],
    candidates: [
      {
        nodeId: "chroma-last-year-announcement",
        score: 0.66,
        source: "chroma",
      },
    ],
    usage: [
      {
        kind: "subscription_allocation",
        shareBps: 400,
        attribution: attribution(
          { id: "announcement-draft", projectId: "usba" },
          "codex-t3",
          "t3",
          "gpt-5.4",
        ),
      },
    ],
    needsYou: {
      id: "announcement-qa",
      kind: "blocker",
      summary: "The draft is waiting and QA has no model available.",
      nextAction: "Pick a reviewer model, or read the draft yourself.",
      actionLabel: "I'll review it",
    },
    result: null,
  },
  {
    id: "tournament-page",
    projectId: "usba",
    phase: "accepted",
    title: "Tournament page",
    agent: "Codex via T3",
    surface: "T3",
    updatedAt: "2026-10-21T12:16:00Z",
    intake: intake(
      { id: "tournament-page", projectId: "usba" },
      "Publish the tournament page with the accepted schedule.",
      ["The page is live.", "The schedule matches the accepted fact."],
      "usba-web",
    ),
    assignment: {
      version: "v1",
      taskId: "tournament-page",
      attemptId: "tournament-page-attempt-1",
      assignmentId: "tournament-page-assignment-1",
      workerId: "codex-t3",
      implementerModel: { model: "gpt-5.4" },
      scope: "Tournament page.",
      contextPackage: context(
        "Publish only after QA accepts the revision.",
        ["fact-governing-copy", "fact-saturday-start"],
        repo,
        "usba-web",
        "2026-10-21T11:02:00Z",
      ),
    },
    progress: [],
    completion: {
      version: "v1",
      taskId: "tournament-page",
      attemptId: "tournament-page-attempt-1",
      generation: 1,
      leaseId: leaseIdFor(1),
      claimedOutcome: "Published the tournament page.",
      artifactRevision: git("55ee66ff77889900aabbccddeeff001122334455"),
      evidence: [
        { kind: "deployment", ref: "deploy:usba:tournament" },
        { kind: "browser", ref: "browser:usba:tournament" },
      ],
    },
    qa: {
      version: "v1",
      taskId: "tournament-page",
      attemptId: "tournament-page-attempt-1",
      availability: "available",
      qaModel: { model: "claude-sonnet-5" },
      implementerModel: { model: "gpt-5.4" },
      verdict: "accept",
      artifactRevision: git("55ee66ff77889900aabbccddeeff001122334455"),
      acceptedRevision: git("55ee66ff77889900aabbccddeeff001122334455"),
      findings: [],
    },
    revision: git("55ee66ff77889900aabbccddeeff001122334455"),
    facts: [
      {
        factId: "fact-saturday-start",
        body: "Saturday's public start time is 9:00 a.m.",
      },
    ],
    candidates: [],
    usage: [
      {
        kind: "estimated_cost",
        amountMinor: 7,
        currency: "USD",
        attribution: attribution(
          { id: "tournament-page", projectId: "usba" },
          "codex-t3",
          "t3",
          "gpt-5.4",
        ),
      },
    ],
    needsYou: null,
    result: "Tournament page is live.",
  },
  {
    id: "contract-check",
    projectId: "ai_os",
    phase: "executing",
    title: "Local contract check",
    agent: "Codex in VS Code",
    surface: "VS Code",
    updatedAt: "2026-10-21T16:44:00Z",
    intake: intake(
      { id: "contract-check", projectId: "ai_os" },
      "Check the local contract fixtures against the v1 shapes.",
      ["Each fixture decodes.", "No candidate is stored as context."],
      "ai-os-local",
    ),
    assignment: {
      version: "v1",
      taskId: "contract-check",
      attemptId: "contract-check-attempt-1",
      assignmentId: "contract-check-assignment-1",
      workerId: "codex-vscode",
      implementerModel: { model: "gpt-5.4" },
      scope: "Read the contracts. Do not change them.",
      contextPackage: context(
        "Candidates stay suggestions.",
        ["fact-candidates-are-not-context"],
        repo,
        "ai-os-local",
        "2026-10-21T16:30:00Z",
      ),
    },
    progress: [
      {
        version: "v1",
        taskId: "contract-check",
        attemptId: "contract-check-attempt-1",
        generation: 1,
        leaseId: leaseIdFor(1),
        status: "working",
        blockers: [],
        partialArtifacts: [],
      },
    ],
    completion: null,
    qa: null,
    revision: git("66ff77889900aabbccddeeff0011223344556677"),
    facts: [
      {
        factId: "fact-candidates-are-not-context",
        body: "A vector candidate is a suggestion until someone accepts it.",
      },
    ],
    candidates: [
      {
        nodeId: "chroma-stale-schema",
        score: 0.52,
        source: "chroma",
      },
    ],
    usage: [
      {
        kind: "unknown",
        reason: "The local editor has no usage report.",
        attribution: attribution(
          { id: "contract-check", projectId: "ai_os" },
          "codex-vscode",
          "vscode",
          "gpt-5.4",
        ),
      },
    ],
    needsYou: null,
    result: null,
  },
  {
    id: "mockup-review",
    projectId: "ai_os",
    phase: "awaiting_qa",
    title: "Mockup review",
    agent: "QA reviewer",
    surface: "Review",
    updatedAt: "2026-10-21T16:48:00Z",
    intake: intake(
      { id: "mockup-review", projectId: "ai_os" },
      "Review the operations mockup against the screen list.",
      ["Every panel on the list is on the screen.", "The drawer opens from a card."],
      "ai-os-local",
    ),
    assignment: {
      version: "v1",
      taskId: "mockup-review",
      attemptId: "mockup-review-attempt-1",
      assignmentId: "mockup-review-assignment-1",
      workerId: "qa-reviewer",
      implementerModel: { model: "gpt-5.4" },
      scope: "Review the mockup.",
      contextPackage: context(
        "Judge the screen, not a live backend.",
        ["fact-mockup-is-static"],
        repo,
        "ai-os-local",
        "2026-10-21T16:46:00Z",
      ),
    },
    progress: [],
    completion: {
      version: "v1",
      taskId: "mockup-review",
      attemptId: "mockup-review-attempt-1",
      generation: 1,
      leaseId: leaseIdFor(1),
      claimedOutcome: "The mockup is ready for a look.",
      artifactRevision: git("77889900aabbccddeeff00112233445566778899"),
      evidence: [{ kind: "browser", ref: "browser:operations" }],
    },
    qa: {
      version: "v1",
      taskId: "mockup-review",
      attemptId: "mockup-review-attempt-1",
      availability: "unavailable",
    },
    revision: git("77889900aabbccddeeff00112233445566778899"),
    facts: [
      {
        factId: "fact-mockup-is-static",
        body: "This screen is a mockup. Actions are not sent anywhere.",
      },
    ],
    candidates: [],
    usage: [],
    needsYou: null,
    result: null,
  },
];
