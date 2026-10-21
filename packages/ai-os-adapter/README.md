# AI OS adapter

## Live driver

The driver records one intake, launches it on a local T3 server, prints progress, and publishes the task to that server's `/api/ai-os/board`. `/operations` reads the same hub.

The server prints a pairing URL at startup. Use the token from that URL.

List project ids:

```sh
vp run --filter @t3tools/ai-os-adapter live-driver -- \
  --list-projects \
  --pairing-token "$T3_PAIRING_TOKEN"
```

Launch one task. `--origin` defaults to `http://127.0.0.1:13773`. `--model` defaults to `gpt-5.4`. `T3_PAIRING_TOKEN` is used when `--pairing-token` is omitted. Omit `--project-id` to print the same list and stop.

```sh
vp run --filter @t3tools/ai-os-adapter live-driver -- \
  --origin http://127.0.0.1:13773 \
  --pairing-token "$T3_PAIRING_TOKEN" \
  --project-id <id> \
  --model gpt-5.4 \
  --title "Tournament page" \
  --prompt "Update the tournament page schedule."
```

The commit recorded in the context package is `git rev-parse HEAD` in that project's workspace root. Publishing replaces the board snapshot with this task. Open `/operations` on the same server to see it.
