import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import { GrokT3Error } from "../src/errors.ts";
import type { T3SessionStore } from "../src/t3Client.ts";

/** Bearer file under the T3 home. Mode 0600, never printed. */
export const DRIVER_SESSION_FILE = "ai-os-driver-session";

export const driverSessionPath = (env: Readonly<Record<string, string | undefined>>): string => {
  const configured = env.T3CODE_HOME?.trim() ?? "";
  const home = configured.length > 0 ? configured : NodePath.join(NodeOS.homedir(), ".t3");
  return NodePath.join(home, DRIVER_SESSION_FILE);
};

export const openDriverSession = (
  env: Readonly<Record<string, string | undefined>>,
): T3SessionStore => {
  const path = driverSessionPath(env);
  return {
    load: Effect.sync(() => {
      try {
        const text = NodeFS.readFileSync(path, "utf8").trim();
        return text.length > 0 ? text : undefined;
      } catch {
        return undefined;
      }
    }),
    save: (bearer) =>
      Effect.try({
        try: () => {
          NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
          NodeFS.writeFileSync(path, bearer, { encoding: "utf8", mode: 0o600 });
          NodeFS.chmodSync(path, 0o600);
        },
        catch: () =>
          new GrokT3Error({
            reason: "t3_rejected",
            detail: "Could not save the T3 session.",
          }),
      }),
    clear: Effect.sync(() => {
      try {
        NodeFS.rmSync(path, { force: true });
      } catch {
        // Already gone.
      }
    }),
  };
};
