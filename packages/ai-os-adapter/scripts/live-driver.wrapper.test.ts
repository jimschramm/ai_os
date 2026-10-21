import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { LIVE_DRIVER_COMMAND } from "../src/liveDriver.ts";

const repoRoot = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
const secret = "pair-secret-not-for-logs";

const runDocumented = (args: readonly string[]) =>
  new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const [binary, ...entry] = LIVE_DRIVER_COMMAND.split(" ");
    if (binary !== "node" || entry.length === 0) {
      reject(new Error(`Unexpected driver command ${LIVE_DRIVER_COMMAND}`));
      return;
    }
    const env = { ...process.env };
    delete env.T3_PAIRING_TOKEN;
    const child = NodeChildProcess.spawn(process.execPath, [...entry, ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("documented driver invocation timed out"));
    }, 15_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });

describe("live driver entry", () => {
  it("does not print a rejected pairing token argument", async () => {
    const separate = await runDocumented(["--pairing-token", secret, "--list-projects"]);
    const inline = await runDocumented([`--pairing-token=${secret}`, "--list-projects"]);

    expect(separate.code).toBe(1);
    expect(inline.code).toBe(1);
    expect(separate.output).not.toContain(secret);
    expect(inline.output).not.toContain(secret);
    expect(separate.output).toContain("not accepted as an argument");
    expect(inline.output).toContain("not accepted as an argument");
    expect(separate.output).not.toContain("vp run");
    expect(separate.output).toContain(LIVE_DRIVER_COMMAND);
  });
});
