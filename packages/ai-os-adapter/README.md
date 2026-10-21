# AI OS adapter

## Live driver

The driver records one intake, launches it on a local T3 server, prints progress, and publishes the task to that server's `/api/ai-os/board`. `/operations` reads the same hub.

The server prints a pairing URL at startup. Export that token as `T3_PAIRING_TOKEN` before running the driver. The token is not accepted as an argument.

List project ids:

```sh
T3_PAIRING_TOKEN="<token>" vp run --filter @t3tools/ai-os-adapter live-driver -- \
  --list-projects
```

Launch one task. `--origin` defaults to `http://127.0.0.1:13773`. `--model` defaults to `gpt-5.4`. Omit `--project-id` to print the same list and stop.

```sh
T3_PAIRING_TOKEN="<token>" vp run --filter @t3tools/ai-os-adapter live-driver -- \
  --origin http://127.0.0.1:13773 \
  --project-id <id> \
  --model gpt-5.4 \
  --title "Tournament page" \
  --prompt "Update the tournament page schedule."
```

The commit recorded in the context package is `git rev-parse HEAD` in that project's workspace root. Publishing replaces the board snapshot with this task. Open `/operations` on the same server to see it.
