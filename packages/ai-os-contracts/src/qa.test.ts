import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { qaAcceptExample, qaReworkExample, qaWaitingExample } from "./examples.ts";
import { decodeQaVerdictV1 } from "./qa.ts";

it.effect("decodes waiting, rework, and acceptance verdicts", () =>
  Effect.gen(function* () {
    const waiting = yield* decodeQaVerdictV1(qaWaitingExample);
    const rework = yield* decodeQaVerdictV1(qaReworkExample);
    const accepted = yield* decodeQaVerdictV1(qaAcceptExample);
    assert.strictEqual(waiting.availability, "unavailable");
    assert.strictEqual(rework.availability === "available" && rework.verdict, "rework");
    assert.strictEqual(
      accepted.availability === "available" && accepted.verdict === "accept"
        ? accepted.acceptedRevision
        : null,
      "rev-2",
    );
  }),
);

it.effect("rejects QA by the implementer's model", () =>
  Effect.gen(function* () {
    const sameModel = yield* Effect.exit(
      decodeQaVerdictV1({
        ...qaAcceptExample,
        qaModel: "gpt-5.4",
        implementerModel: "gpt-5.4",
      }),
    );
    assert.strictEqual(Exit.isFailure(sameModel), true);
  }),
);

it.effect(
  "rejects acceptance of a different revision and a waiting payload that also accepts",
  () =>
    Effect.gen(function* () {
      const otherRevision = yield* Effect.exit(
        decodeQaVerdictV1({
          ...qaAcceptExample,
          artifactRevision: "rev-2",
          acceptedRevision: "rev-1",
        }),
      );
      const waitingAndAccept = yield* Effect.exit(
        decodeQaVerdictV1({
          ...qaWaitingExample,
          availability: "unavailable",
          verdict: "accept",
          qaModel: "claude-sonnet-5",
          implementerModel: "gpt-5.4",
          artifactRevision: "rev-2",
          acceptedRevision: "rev-2",
          findings: [],
        }),
      );
      const reworkWithoutFindings = yield* Effect.exit(
        decodeQaVerdictV1({ ...qaReworkExample, findings: [] }),
      );
      assert.strictEqual(Exit.isFailure(otherRevision), true);
      assert.strictEqual(Exit.isFailure(waitingAndAccept), true);
      assert.strictEqual(Exit.isFailure(reworkWithoutFindings), true);
    }),
);
