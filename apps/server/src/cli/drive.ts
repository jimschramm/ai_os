import { ProjectId, parseDriveFolderId, type ProjectDriveSettings } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  DRIVE_CLIENT_SECRET_NAME,
  DRIVE_TOKEN_SECRET_NAME,
  decodeToken,
  encodeToken,
  parseClientJson,
  revokeToken,
  runLoopbackLogin,
} from "../drive/GoogleDriveAuth.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

class DriveCliError extends CliError.UserError {
  override get message() {
    return String(this.cause);
  }
}

const userError = (detail: string) => new DriveCliError({ cause: detail });
const fail = (detail: string) => Effect.fail(userError(detail));

const withConfig = <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (config: ServerConfig.ServerConfig["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    return yield* run(config);
  });

const secretStoreLayer = (config: ServerConfig.ServerConfig["Service"]) =>
  ServerSecretStore.layer.pipe(
    Layer.provide(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
  );

const readSecret = (name: string) =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    return yield* store.get(name);
  });

const loginCommand = Command.make("login", {
  ...authLocationFlags,
  clientJson: Flag.String("client-json").pipe(
    Flag.withDescription(
      "Path to the Desktop OAuth client JSON downloaded from Google Cloud. Only needed the first time.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Sign in to Google Drive in the browser and store the token locally."),
  Command.withHandler((flags) =>
    withConfig(flags, (config) =>
      Effect.gen(function* () {
        const store = yield* ServerSecretStore.ServerSecretStore;
        const fileSystem = yield* FileSystem.FileSystem;
        let clientText: string;
        if (Option.isSome(flags.clientJson)) {
          clientText = yield* fileSystem
            .readFileString(flags.clientJson.value)
            .pipe(
              Effect.catch(() => fail(`Cannot read ${flags.clientJson.pipe(Option.getOrThrow)}.`)),
            );
        } else {
          const stored = yield* store.get(DRIVE_CLIENT_SECRET_NAME);
          if (Option.isNone(stored)) {
            return yield* fail(
              "No Google OAuth client yet. Run: drive login --client-json <path to downloaded client JSON>",
            );
          }
          clientText = new TextDecoder().decode(stored.value);
        }
        const client = yield* Effect.try({
          try: () => parseClientJson(clientText),
          catch: (error) => userError((error as Error).message),
        });
        const token = yield* Effect.tryPromise({
          try: () =>
            runLoopbackLogin({
              client,
              showUrl: (url) =>
                // @effect-diagnostics-next-line globalConsole:off - called from the Node callback server, outside the Effect runtime.
                console.log(
                  `Open this link in your browser to sign in to Google Drive (waits 5 minutes):\n\n${url}\n`,
                ),
            }),
          catch: (error) => userError((error as Error).message),
        });
        // Client is stored only after a successful sign-in, so a bad file never sticks.
        yield* store.set(DRIVE_CLIENT_SECRET_NAME, new TextEncoder().encode(clientText));
        yield* store.set(DRIVE_TOKEN_SECRET_NAME, encodeToken(token));
        yield* Console.log(
          `Signed in to Google Drive. Token stored in ${config.secretsDir} (owner-only).`,
        );
      }).pipe(Effect.provide(secretStoreLayer(config))),
    ),
  ),
);

const statusCommand = Command.make("status", { ...authLocationFlags }).pipe(
  Command.withDescription("Show whether Google Drive is signed in. Never prints the token."),
  Command.withHandler((flags) =>
    withConfig(flags, (config) =>
      Effect.gen(function* () {
        const stored = yield* readSecret(DRIVE_TOKEN_SECRET_NAME);
        const token = Option.isSome(stored) ? decodeToken(stored.value) : null;
        if (token === null) {
          yield* Console.log("Google Drive: not signed in.");
          return;
        }
        yield* Console.log(
          `Google Drive: signed in since ${token.obtainedAt}.\nScopes: ${token.scopes.join(", ")}`,
        );
      }).pipe(Effect.provide(secretStoreLayer(config))),
    ),
  ),
);

const logoutCommand = Command.make("logout", { ...authLocationFlags }).pipe(
  Command.withDescription("Revoke the Google Drive grant and delete the local token."),
  Command.withHandler((flags) =>
    withConfig(flags, (config) =>
      Effect.gen(function* () {
        const store = yield* ServerSecretStore.ServerSecretStore;
        const stored = yield* store.get(DRIVE_TOKEN_SECRET_NAME);
        const token = Option.isSome(stored) ? decodeToken(stored.value) : null;
        const revoked =
          token === null ? false : yield* Effect.promise(() => revokeToken(token.refreshToken));
        yield* store.remove(DRIVE_TOKEN_SECRET_NAME);
        yield* Console.log(
          token === null
            ? "Google Drive: no token stored."
            : revoked
              ? "Signed out: grant revoked at Google and local token deleted."
              : "Local token deleted. Google could not be reached to revoke it; remove ai_os at myaccount.google.com/permissions.",
        );
      }).pipe(Effect.provide(secretStoreLayer(config))),
    ),
  ),
);

const folderFlag = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional);

/** Pure so it can be tested: applies the CLI flags to a project's current drive setting. */
export const nextProjectDriveSettings = (
  current: ProjectDriveSettings | undefined,
  input: {
    readonly output: Option.Option<string>;
    readonly input: Option.Option<string>;
    readonly clearInput: boolean;
    readonly disable: boolean;
  },
): ProjectDriveSettings | string => {
  const next: { -readonly [K in keyof ProjectDriveSettings]: ProjectDriveSettings[K] } = {
    ...current,
    enabled: !input.disable,
  };
  for (const [key, raw] of [
    ["outputFolderId", input.output],
    ["inputFolderId", input.input],
  ] as const) {
    if (Option.isNone(raw)) continue;
    const id = parseDriveFolderId(raw.value);
    if (id === null) return `Not a Google Drive folder link or id: ${raw.value}`;
    next[key] = id;
  }
  if (input.clearInput) delete next.inputFolderId;
  return next;
};

const projectCommand = Command.make("project", {
  ...authLocationFlags,
  projectId: Argument.String("project-id").pipe(
    Argument.withDescription("Project id (see `project list`)."),
  ),
  output: folderFlag("output", "Drive folder link or id where ai_os saves new files."),
  input: folderFlag("input", "Optional default Drive folder link or id to read from."),
  clearInput: Flag.Boolean("clear-input").pipe(
    Flag.withDescription("Remove the default input folder."),
    Flag.withDefault(false),
  ),
  disable: Flag.Boolean("disable").pipe(
    Flag.withDescription("Turn Drive off for this project (keeps the folders)."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Set a project's Google Drive folders by pasting folder links."),
  Command.withHandler((flags) =>
    withConfig(flags, (config) =>
      Effect.gen(function* () {
        const projectId = ProjectId.make(flags.projectId);
        const settings = yield* ServerSettings.ServerSettingsService;
        const current = yield* settings.getSettings;
        const entry = current.projectSettingsOverrides[projectId] ?? {};
        const drive = nextProjectDriveSettings(entry.drive, flags);
        if (typeof drive === "string") return yield* fail(drive);
        yield* settings.updateSettings({
          projectSettingsOverrides: { [projectId]: { ...entry, drive } },
        });
        yield* Console.log(
          `Drive for ${projectId}: ${drive.enabled ? "on" : "off"}; output ${drive.outputFolderId ?? "not set"}; input ${drive.inputFolderId ?? "any (whole Drive)"}.`,
        );
      }).pipe(
        Effect.provide(
          ServerSettings.layer.pipe(
            Layer.provide(ServerSecretStore.layer),
            Layer.provide(SqlitePersistence.layerConfig),
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
          ),
        ),
      ),
    ),
  ),
);

export const driveCommand = Command.make("drive").pipe(
  Command.withDescription("Google Drive sign-in and project folders."),
  Command.withSubcommands([loginCommand, statusCommand, logoutCommand, projectCommand]),
);
