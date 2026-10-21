import * as NodeChildProcess from "node:child_process";

import { runLiveDriverCli } from "../src/liveDriver.ts";

const readRepoCommit = (workspaceRoot: string): Promise<string> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "git",
      ["-C", workspaceRoot, "rev-parse", "HEAD"],
      { encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          reject(new Error(`Could not read git HEAD in ${workspaceRoot}.`));
          return;
        }
        const sha = stdout.trim();
        if (!/^[0-9a-f]{40}$/.test(sha)) {
          reject(new Error(`git HEAD in ${workspaceRoot} is not a commit sha.`));
          return;
        }
        resolve(sha);
      },
    );
  });

const code = await runLiveDriverCli(process.argv.slice(2), process.env, readRepoCommit);
process.exit(code);
