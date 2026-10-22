import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { driverSessionPath, openDriverSession } from "./driverSession.ts";

it.effect("stores the bearer under the T3 home with mode 0600", () =>
  Effect.gen(function* () {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-driver-session-"));
    try {
      const session = openDriverSession({ T3CODE_HOME: home });
      const bearer = "access-not-for-stdout";
      yield* session.save(bearer);
      const path = driverSessionPath({ T3CODE_HOME: home });
      assert.equal(path.startsWith(home), true);
      assert.strictEqual(NodeFS.readFileSync(path, "utf8"), bearer);
      assert.strictEqual(NodeFS.statSync(path).mode & 0o777, 0o600);
      assert.strictEqual(yield* session.load, bearer);
      yield* session.clear;
      assert.strictEqual(NodeFS.existsSync(path), false);
      assert.equal(
        driverSessionPath({}).endsWith(`${NodePath.sep}.t3${NodePath.sep}ai-os-driver-session`),
        true,
      );
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  }),
);
