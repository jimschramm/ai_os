# AI OS adapter

## Live driver

The driver records one intake, launches it on a local T3 server, prints progress, and publishes the task to that server's `/api/ai-os/board`. `/operations` reads the same hub.

The server prints a pairing URL at startup. Export that token as `T3_PAIRING_TOKEN` in the environment for the first run. The driver exchanges it for a session and stores the bearer in the T3 home (`T3CODE_HOME`, or `~/.t3`) as `ai-os-driver-session` with mode `0600`. Later runs reuse that file and do not need a new pairing token. `--list-projects` uses the same session, so listing projects does not burn the only credential. A package-manager runner prints its child command, so this Node entry is the only invocation, and the token is never an argument.

List project ids:

```sh
T3_PAIRING_TOKEN="<token>" node --experimental-strip-types packages/ai-os-adapter/scripts/live-driver.ts \
  --list-projects
```

Launch one task. `--origin` defaults to `http://127.0.0.1:13773`. Omit `--model` to use the project's configured model, then the server default. If the model is not one the provider offers, the error lists the valid models. The same command can list and launch when `--project-id`, `--title`, and `--prompt` are all present. After the first run, omit `T3_PAIRING_TOKEN`.

```sh
node --experimental-strip-types packages/ai-os-adapter/scripts/live-driver.ts \
  --origin http://127.0.0.1:13773 \
  --project-id <id> \
  --title "Tournament page" \
  --prompt "Update the tournament page schedule."
```

The commit recorded in the context package is `git rev-parse HEAD` in that project's workspace root. Publishing replaces the board snapshot with this task. Open `/operations` on the same server to see it.
