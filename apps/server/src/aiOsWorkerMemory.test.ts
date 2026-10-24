// @effect-diagnostics nodeBuiltinImport:off - The test opens the same temp sqlite file the route uses.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  ADAPTER_MEMORY_ACCEPT_PATH,
  ADAPTER_MEMORY_CONTEXT_PATH,
  ADAPTER_MEMORY_POLICY_PATH,
  ADAPTER_MEMORY_PROPOSE_PATH,
  ADAPTER_MEMORY_WORKERS_PATH,
} from "@t3tools/ai-os-adapter/board";
import { exampleRepoCommit, historyFacts } from "@t3tools/ai-os-contracts";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest } from "effect/http";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as AiOsAntigravity from "./aiOsAntigravity.ts";
import * as AiOsBoard from "./aiOsBoard.ts";
import { openMemoryDatabase, readMemoryLedger, submitMemorySync } from "./aiOsMemory.ts";
import {
  localWorkerHttpAllowed,
  WORKER_LOCAL_DETAIL,
  WORKER_SCOPE_DETAIL,
  WORKER_TOKEN_DETAIL,
} from "./aiOsWorkerMemory.ts";
import * as ServerConfig from "./config.ts";

const at = "2026-10-24T06:00:00Z";

const allowRuns: AiOsBoard.BoardRuns["Service"] = {
  interrupt: () => Effect.succeed("requested"),
  confirmLaunch: () => Effect.succeed("active"),
  launch: () => Effect.die("A local worker does not launch a board run."),
  continueRun: () => Effect.die("A local worker does not launch a board run."),
  watchThread: () => Effect.succeed(null),
  readReviewerSession: () => Effect.succeed(null),
  followRuns: false,
};

const idleReviews: AiOsAntigravity.AntigravityReviews["Service"] = {
  listModels: () => Effect.succeed({ source: "unverified", models: [], detail: null }),
  start: () => Effect.die("Antigravity review was not expected."),
  watch: () => Effect.succeed(null),
  cancel: () => Effect.succeed("already_stopped"),
  recover: () => Effect.succeed({ status: "stopped" as const }),
  sweep: () => Effect.void,
};

const disposers: Array<() => Promise<void>> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const handlerFor = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aios-worker-memory-"));
  dirs.push(dir);
  const { handler, dispose } = HttpRouter.toWebHandler(
    AiOsBoard.layer.pipe(
      Layer.provide(Layer.succeed(AiOsBoard.BoardRuns, allowRuns)),
      Layer.provide(Layer.succeed(AiOsAntigravity.AntigravityReviews, idleReviews)),
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
          authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) => {
            const header = request.headers.authorization;
            if (header === `Bearer ${AuthOrchestrationOperateScope}`) {
              return Effect.succeed({
                scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
              });
            }
            if (header === `Bearer ${AuthOrchestrationReadScope}`) {
              return Effect.succeed({ scopes: [AuthOrchestrationReadScope] });
            }
            return Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}));
          },
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
      Layer.provide(
        Layer.succeed(ServerConfig.ServerConfig, {
          stateDir: dir,
        } as ServerConfig.ServerConfig["Service"]),
      ),
      Layer.provide(NodeServices.layer),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, stateDir: dir };
};

const localUrl = (path: string) => `http://127.0.0.1${path}`;

const ownerPost = (handler: (request: Request) => Promise<Response>, path: string, body: unknown) =>
  handler(
    new Request(localUrl(path), {
      method: "POST",
      headers: {
        authorization: `Bearer ${AuthOrchestrationOperateScope}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );

const workerFetch = (
  handler: (request: Request) => Promise<Response>,
  url: string,
  token: string,
  init?: {
    readonly method?: string;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
  },
) =>
  handler(
    new Request(url, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        ...init?.headers,
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );

const contextUrl = (projectId: string) => {
  const url = new URL(localUrl(ADAPTER_MEMORY_CONTEXT_PATH));
  url.searchParams.set("schemaVersion", "v1");
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("repoCommit", exampleRepoCommit);
  url.searchParams.set("requirements", "What does this project already know?");
  url.searchParams.set("authorizationScope", `project:${projectId}`);
  return url.toString();
};

const accepted = (
  projectId: string,
  factId: string,
  identity: string,
  kind: "Instruction" | "Decision",
  body: string,
  expected: ReadonlyArray<{ factId: string; revision: number }> = [],
) => ({
  version: "v1" as const,
  submissionId: `submission-${factId}`,
  idempotencyKey: `key-${factId}`,
  projectId,
  authorId: "jim",
  taskId: "task-seed",
  attemptId: `attempt-${factId}`,
  evidence: [{ evidenceId: `evidence-${factId}`, note: "Recorded from the source." }],
  expectedVersions: expected,
  intent: "accept" as const,
  facts: [
    {
      identity,
      fact: {
        acceptance: "proposed" as const,
        factId,
        projectId,
        kind,
        body,
        provenance: { actorId: "jim", at },
        validity: { from: at, until: null },
      },
    },
  ],
  relationships: [],
});

const proposal = (
  attemptId: string,
  identity: string,
  nodeKind: "Instruction" | "Decision",
  body: string,
  provenanceActorId?: string,
) => ({
  schemaVersion: "v1" as const,
  projectId: "wow-harness",
  workerId: "wow-harness",
  taskId: "wow-session",
  attemptId,
  ...(provenanceActorId === undefined ? {} : { provenanceActorId }),
  write: {
    kind: "fact" as const,
    identity,
    nodeKind,
    body,
    evidence: [{ evidenceId: `evidence-${attemptId}`, note: "Jim said so in chat." }],
  },
});

interface ContextBody {
  readonly schemaVersion: string;
  readonly projectId: string;
  readonly workerId: string;
  readonly runtime: string;
  readonly facts: ReadonlyArray<{
    readonly factId: string;
    readonly body: string;
    readonly acceptance: string;
    readonly projectId: string;
  }>;
  readonly contextPackage: { readonly memoryVersions: readonly string[] };
  readonly candidates?: unknown;
}

const register = async (
  handler: (request: Request) => Promise<Response>,
  workerId: string,
  projectId: string,
) => {
  const response = await ownerPost(handler, ADAPTER_MEMORY_WORKERS_PATH, {
    schemaVersion: "v1",
    workerId,
    projectId,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    readonly token: string;
    readonly runtime: string;
    readonly rotated: boolean;
  };
};

describe("local worker memory", () => {
  it("allows a loopback worker request and refuses a remote peer", () => {
    expect(
      localWorkerHttpAllowed({
        host: "127.0.0.1:13773",
        remoteAddress: undefined,
        forwardedFor: undefined,
      }),
    ).toBe(true);
    expect(
      localWorkerHttpAllowed({
        host: "localhost",
        remoteAddress: "::ffff:127.0.0.1",
        forwardedFor: "127.0.0.1",
      }),
    ).toBe(true);
    expect(
      localWorkerHttpAllowed({
        host: "evil.example",
        remoteAddress: undefined,
        forwardedFor: undefined,
      }),
    ).toBe(false);
    expect(
      localWorkerHttpAllowed({
        host: "127.0.0.1",
        remoteAddress: "203.0.113.5",
        forwardedFor: undefined,
      }),
    ).toBe(false);
    expect(
      localWorkerHttpAllowed({
        host: "127.0.0.1",
        remoteAddress: "127.0.0.1",
        forwardedFor: "203.0.113.5",
      }),
    ).toBe(false);
  });

  it("authenticates a project-scoped token only from localhost", async () => {
    const { handler } = handlerFor();
    const missing = await handler(
      new Request(localUrl(ADAPTER_MEMORY_WORKERS_PATH), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: "v1",
          workerId: "wow-harness",
          projectId: "wow-harness",
        }),
      }),
    );
    expect(missing.status).toBeGreaterThanOrEqual(400);

    const reader = await handler(
      new Request(localUrl(ADAPTER_MEMORY_WORKERS_PATH), {
        method: "POST",
        headers: {
          authorization: `Bearer ${AuthOrchestrationReadScope}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: "v1",
          workerId: "wow-harness",
          projectId: "wow-harness",
        }),
      }),
    );
    expect(reader.status).toBeGreaterThanOrEqual(400);

    const first = await register(handler, "wow-harness", "wow-harness");
    expect(first.runtime).toBe("local-worker");
    expect(first.rotated).toBe(false);
    expect(first.token.startsWith("lw-")).toBe(true);

    const taken = await ownerPost(handler, ADAPTER_MEMORY_WORKERS_PATH, {
      schemaVersion: "v1",
      workerId: "wow-harness",
      projectId: "usba",
    });
    expect(taken.status).toBe(409);

    const rotated = await register(handler, "wow-harness", "wow-harness");
    expect(rotated.rotated).toBe(true);
    expect(rotated.token).not.toBe(first.token);

    const stale = await workerFetch(handler, contextUrl("wow-harness"), first.token);
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({ detail: WORKER_TOKEN_DETAIL });

    const remote = await workerFetch(
      handler,
      contextUrl("wow-harness").replace("127.0.0.1", "evil.example"),
      rotated.token,
    );
    expect(remote.status).toBe(403);
    expect(await remote.json()).toMatchObject({ detail: WORKER_LOCAL_DETAIL });

    const forwarded = await workerFetch(handler, contextUrl("wow-harness"), rotated.token, {
      headers: { "x-forwarded-for": "203.0.113.5" },
    });
    expect(forwarded.status).toBe(403);

    const session = await workerFetch(
      handler,
      contextUrl("wow-harness"),
      AuthOrchestrationOperateScope,
    );
    expect(session.status).toBe(401);

    const otherProject = await workerFetch(handler, contextUrl("usba"), rotated.token);
    expect(otherProject.status).toBe(403);
    expect(await otherProject.json()).toMatchObject({ detail: WORKER_SCOPE_DETAIL });

    const unscoped = await workerFetch(
      handler,
      contextUrl("wow-harness").replace("schemaVersion=v1&", ""),
      rotated.token,
    );
    expect(unscoped.status).toBe(400);
  });

  it("reads only this project's accepted facts, and a proposal stays out until it is accepted", async () => {
    const { handler, stateDir } = handlerFor();
    const database = openMemoryDatabase(NodePath.join(stateDir, "memory.db"));
    submitMemorySync(
      database,
      accepted("wow-harness", "fact-thursday", "raid-night", "Decision", "Raid night is Thursday."),
      "jim",
    );
    submitMemorySync(
      database,
      accepted("wow-harness", "fact-friday", "raid-night", "Decision", "Raid night is Friday.", [
        { factId: "fact-thursday", revision: 1 },
      ]),
      "jim",
    );
    submitMemorySync(
      database,
      accepted("usba", "fact-start", "start", "Decision", "Saturday games start at 7:00."),
      "jim",
    );
    database.close();

    const wow = await register(handler, "wow-harness", "wow-harness");
    const usba = await register(handler, "usba-worker", "usba");
    const wowRead = await workerFetch(handler, contextUrl("wow-harness"), wow.token);
    expect(wowRead.status).toBe(200);
    expect(wowRead.headers.get("cache-control")).toBe("no-store");
    const wowBody = (await wowRead.json()) as ContextBody;
    expect(wowBody.schemaVersion).toBe("v1");
    expect(wowBody.runtime).toBe("local-worker");
    expect(wowBody.facts.map((fact) => fact.body)).toEqual(["Raid night is Friday."]);
    expect(wowBody.contextPackage.memoryVersions).toEqual(["fact-friday"]);
    expect(wowBody.candidates).toBeUndefined();
    expect(wowBody.facts.some((fact) => fact.projectId !== "wow-harness")).toBe(false);

    const usbaRead = (await (
      await workerFetch(handler, contextUrl("usba"), usba.token)
    ).json()) as ContextBody;
    expect(usbaRead.facts.map((fact) => fact.factId)).toEqual(["fact-start"]);

    const written = await workerFetch(handler, localUrl(ADAPTER_MEMORY_PROPOSE_PATH), wow.token, {
      method: "POST",
      body: proposal("wow-addons", "addons", "Instruction", "Track addon versions."),
    });
    expect(written.status).toBe(200);
    expect(await written.json()).toMatchObject({
      _tag: "Applied",
      outcome: "pending",
      autoAccepted: false,
      schemaVersion: "v1",
    });

    const hidden = (await (
      await workerFetch(handler, contextUrl("wow-harness"), wow.token)
    ).json()) as ContextBody;
    expect(hidden.facts.map((fact) => fact.body)).toEqual(["Raid night is Friday."]);
    expect(hidden.contextPackage.memoryVersions).toEqual(["fact-friday"]);
    expect(hidden.facts.some((fact) => fact.body === "Track addon versions.")).toBe(false);

    const cross = await workerFetch(handler, localUrl(ADAPTER_MEMORY_PROPOSE_PATH), wow.token, {
      method: "POST",
      body: {
        ...proposal("wow-cross", "cross", "Decision", "This is another project."),
        projectId: "usba",
      },
    });
    expect(cross.status).toBe(403);

    const workerAccept = await workerFetch(
      handler,
      localUrl(ADAPTER_MEMORY_ACCEPT_PATH),
      wow.token,
      {
        method: "POST",
        body: { schemaVersion: "v1", projectId: "wow-harness", factId: "fact-wow-addons-addons" },
      },
    );
    expect(workerAccept.status).toBeGreaterThanOrEqual(400);

    const acceptedProposal = await ownerPost(handler, ADAPTER_MEMORY_ACCEPT_PATH, {
      schemaVersion: "v1",
      projectId: "wow-harness",
      factId: "fact-wow-addons-addons",
    });
    expect(acceptedProposal.status).toBe(200);
    expect(await acceptedProposal.json()).toMatchObject({ outcome: "accepted" });

    const visible = (await (
      await workerFetch(handler, contextUrl("wow-harness"), wow.token)
    ).json()) as ContextBody;
    expect(visible.facts.map((fact) => fact.body).sort()).toEqual([
      "Raid night is Friday.",
      "Track addon versions.",
    ]);

    const saved = openMemoryDatabase(NodePath.join(stateDir, "memory.db"));
    const history = historyFacts(readMemoryLedger(saved).graph, "wow-harness");
    saved.close();
    expect(history.find((fact) => fact.factId === "fact-thursday")?.acceptance).toBe("superseded");
    expect(visible.facts.some((fact) => fact.factId === "fact-thursday")).toBe(false);
  });

  it("auto-accepts only facts the owner named, and never a conflicting proposal", async () => {
    const { handler, stateDir } = handlerFor();
    const database = openMemoryDatabase(NodePath.join(stateDir, "memory.db"));
    submitMemorySync(
      database,
      accepted(
        "wow-harness",
        "fact-thursday",
        "raid-night",
        "Instruction",
        "Raid night is Thursday.",
      ),
      "jim",
    );
    database.close();

    const wow = await register(handler, "wow-harness", "wow-harness");
    const before = await handler(
      new Request(`${localUrl(ADAPTER_MEMORY_POLICY_PATH)}?projectId=wow-harness`, {
        headers: { authorization: `Bearer ${AuthOrchestrationOperateScope}` },
      }),
    );
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({ enabled: false, rules: [] });

    const pending = await workerFetch(handler, localUrl(ADAPTER_MEMORY_PROPOSE_PATH), wow.token, {
      method: "POST",
      body: proposal("wow-addons", "addons", "Instruction", "Track addon versions.", "jim"),
    });
    expect(pending.status).toBe(200);
    expect(await pending.json()).toMatchObject({ outcome: "pending", autoAccepted: false });

    const saved = await ownerPost(handler, ADAPTER_MEMORY_POLICY_PATH, {
      schemaVersion: "v1",
      projectId: "wow-harness",
      enabled: true,
      rules: [{ kinds: ["Instruction"], actorIds: ["jim"] }],
    });
    expect(saved.status).toBe(200);

    const retry = await workerFetch(handler, localUrl(ADAPTER_MEMORY_PROPOSE_PATH), wow.token, {
      method: "POST",
      body: proposal("wow-addons", "addons", "Instruction", "Track addon versions.", "jim"),
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ outcome: "duplicate", autoAccepted: false });
    const stillHidden = (await (
      await workerFetch(handler, contextUrl("wow-harness"), wow.token)
    ).json()) as ContextBody;
    expect(stillHidden.facts.some((fact) => fact.body === "Track addon versions.")).toBe(false);

    const instruction = await workerFetch(
      handler,
      localUrl(ADAPTER_MEMORY_PROPOSE_PATH),
      wow.token,
      {
        method: "POST",
        body: proposal("wow-discord", "discord", "Instruction", "Be in Discord at 7.", "jim"),
      },
    );
    expect(instruction.status).toBe(200);
    expect(await instruction.json()).toMatchObject({
      outcome: "accepted",
      autoAccepted: true,
      detail: "Accepted by the project policy.",
    });

    const decision = await workerFetch(handler, localUrl(ADAPTER_MEMORY_PROPOSE_PATH), wow.token, {
      method: "POST",
      body: proposal("wow-loot", "loot", "Decision", "Master looter.", "jim"),
    });
    expect(decision.status).toBe(200);
    expect(await decision.json()).toMatchObject({ outcome: "pending", autoAccepted: false });

    const conflict = await workerFetch(handler, localUrl(ADAPTER_MEMORY_PROPOSE_PATH), wow.token, {
      method: "POST",
      body: proposal("wow-friday", "raid-night", "Instruction", "Raid night is Friday.", "jim"),
    });
    expect(conflict.status).toBe(200);
    const conflictBody = (await conflict.json()) as {
      readonly outcome: string;
      readonly autoAccepted: boolean;
      readonly factIds: readonly string[];
    };
    expect(conflictBody).toMatchObject({ outcome: "conflict", autoAccepted: false });

    const refused = await ownerPost(handler, ADAPTER_MEMORY_ACCEPT_PATH, {
      schemaVersion: "v1",
      projectId: "wow-harness",
      factId: conflictBody.factIds[0],
    });
    expect(refused.status).toBe(409);

    const packaged = (await (
      await workerFetch(handler, contextUrl("wow-harness"), wow.token)
    ).json()) as ContextBody;
    expect(packaged.facts.map((fact) => fact.body).sort()).toEqual([
      "Be in Discord at 7.",
      "Raid night is Thursday.",
    ]);
    expect(packaged.facts.some((fact) => fact.acceptance !== "accepted")).toBe(false);
  });
});
