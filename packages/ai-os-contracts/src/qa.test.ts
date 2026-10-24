import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  qaAcceptExample,
  qaReworkExample,
  qaWaitingExample,
  revisionOne,
  revisionTwo,
} from "./examples.ts";
import { decodeQaVerdictV1 } from "./qa.ts";

it.effect("decodes waiting, rework, and acceptance verdicts", () =>
  Effect.gen(function* () {
    const waiting = yield* decodeQaVerdictV1(qaWaitingExample);
    const rework = yield* decodeQaVerdictV1(qaReworkExample);
    const accepted = yield* decodeQaVerdictV1(qaAcceptExample);
    assert.strictEqual(waiting.availability, "unavailable");
    assert.strictEqual(rework.availability === "available" && rework.verdict, "rework");
    assert.deepStrictEqual(
      accepted.availability === "available" && accepted.verdict === "accept"
        ? accepted.acceptedRevision
        : null,
      revisionTwo,
    );
  }),
);

it.effect("accepts Astra reviewing Sol and rejects two Argon efforts", () =>
  Effect.gen(function* () {
    const independent = yield* decodeQaVerdictV1({
      ...qaReworkExample,
      qaModel: "gpt-6-astra",
      implementerModel: "gpt-6-sol",
    });
    assert.strictEqual(independent.availability, "available");

    const sameBase = yield* Effect.exit(
      decodeQaVerdictV1({
        ...qaReworkExample,
        qaModel: "gemini-4-argon-medium",
        implementerModel: "gemini-4-argon-high",
      }),
    );
    assert.strictEqual(Exit.isFailure(sameBase), true);
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

it.effect("treats model identity as case-insensitive, including a provider prefix", () =>
  Effect.gen(function* () {
    const cased = yield* Effect.exit(
      decodeQaVerdictV1({
        ...qaAcceptExample,
        qaModel: "GPT-5.4",
        implementerModel: "gpt-5.4",
      }),
    );
    const prefixed = yield* Effect.exit(
      decodeQaVerdictV1({
        ...qaAcceptExample,
        qaModel: "OpenAI/GPT-5.4",
        implementerModel: "openai:gpt-5.4",
      }),
    );
    const canonical = yield* decodeQaVerdictV1({
      ...qaAcceptExample,
      qaModel: " Claude-Sonnet-5 ",
      implementerModel: "GPT-5.4",
    });
    const crossProvider = yield* Effect.exit(
      decodeQaVerdictV1({
        ...qaAcceptExample,
        qaModel: "azure/gpt-5.4",
        implementerModel: "openai/gpt-5.4",
      }),
    );
    const bareAndPrefixed = yield* Effect.exit(
      decodeQaVerdictV1({
        ...qaAcceptExample,
        qaModel: "openai/gpt-5.4",
        implementerModel: "gpt-5.4",
      }),
    );
    assert.strictEqual(Exit.isFailure(cased), true);
    assert.strictEqual(Exit.isFailure(prefixed), true);
    assert.strictEqual(Exit.isFailure(crossProvider), true);
    assert.strictEqual(Exit.isFailure(bareAndPrefixed), true);
    assert.deepStrictEqual(canonical.availability === "available" ? canonical.qaModel : null, {
      model: "claude-sonnet-5",
    });
    assert.deepStrictEqual(
      canonical.availability === "available" ? canonical.implementerModel : null,
      { model: "gpt-5.4" },
    );
  }),
);

it.effect(
  "rejects acceptance of a different revision and a waiting payload that also accepts",
  () =>
    Effect.gen(function* () {
      const otherRevision = yield* Effect.exit(
        decodeQaVerdictV1({
          ...qaAcceptExample,
          artifactRevision: revisionTwo,
          acceptedRevision: revisionOne,
        }),
      );
      const waitingAndAccept = yield* Effect.exit(
        decodeQaVerdictV1({
          ...qaWaitingExample,
          availability: "unavailable",
          verdict: "accept",
          qaModel: "claude-sonnet-5",
          implementerModel: "gpt-5.4",
          artifactRevision: revisionTwo,
          acceptedRevision: revisionTwo,
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
