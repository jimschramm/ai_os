# AI OS adapter

## Live driver

The driver records one intake, launches it on a local T3 server, prints progress, and publishes the task to that server's `/api/ai-os/board`. `/operations` reads the same hub.

The server prints a pairing URL at startup. Export that token as `T3_PAIRING_TOKEN` in the environment before running the driver. Run the commands below from the repository root. A package-manager runner prints its child command, so this Node entry is the only invocation.

List project ids:

```sh
T3_PAIRING_TOKEN="<token>" node --experimental-strip-types packages/ai-os-adapter/scripts/live-driver.ts \
  --list-projects
```

Launch one task. `--origin` defaults to `http://127.0.0.1:13773`. `--model` defaults to `gpt-5.4`. Omit `--project-id` to print the same list and stop.

```sh
T3_PAIRING_TOKEN="<token>" node --experimental-strip-types packages/ai-os-adapter/scripts/live-driver.ts \
  --origin http://127.0.0.1:13773 \
  --project-id <id> \
  --model gpt-5.4 \
  --title "Tournament page" \
  --prompt "Update the tournament page schedule."
```

The commit recorded in the context package is `git rev-parse HEAD` in that project's workspace root. Publishing replaces the board snapshot with this task. Open `/operations` on the same server to see it.
