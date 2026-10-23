import {
  AuthSettingsWriteScope,
  EnvironmentHttpApi,
  ProjectId,
  type ProjectDriveSettings,
  type ProjectDriveUpdate,
  type ResolvedProjectDriveUpdate,
  resolveProjectDriveUpdate,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import { FetchHttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  DRIVE_CREDENTIALS_SECRET_NAME,
  decodeCredentials,
  encodeCredentials,
  parseClientJson,
  revokeToken,
  runLoopbackLogin,
  type DriveClient,
} from "../drive/GoogleDriveAuth.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import {
  clearPersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
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

const readCredentials = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const stored = yield* store.get(DRIVE_CREDENTIALS_SECRET_NAME);
  return Option.isSome(stored) ? decodeCredentials(stored.value) : null;
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
        let client: DriveClient;
        if (Option.isSome(flags.clientJson)) {
          const path = flags.clientJson.value;
          const clientText = yield* fileSystem
            .readFileString(path)
            .pipe(Effect.catch(() => fail(`Cannot read ${path}.`)));
          client = yield* Effect.try({
            try: () => parseClientJson(clientText),
            catch: (error) => userError((error as Error).message),
          });
        } else {
          const stored = yield* readCredentials;
          if (stored === null) {
            return yield* fail(
              "No Google OAuth client yet. Run: drive login --client-json <path to downloaded client JSON>",
            );
          }
          client = stored.client;
        }
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
        // Stored only after a successful sign-in, as one record, so a bad file
        // never sticks and client and token can never be mismatched.
        yield* store.set(DRIVE_CREDENTIALS_SECRET_NAME, encodeCredentials({ client, token }));
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
        const token = (yield* readCredentials)?.token ?? null;
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
        const stored = yield* readCredentials;
        const token = stored?.token ?? null;
        const revoked =
          token === null ? false : yield* Effect.promise(() => revokeToken(token.refreshToken));
        // Keep the client so the next login needs no file; drop only the token.
        if (stored !== null && token !== null) {
          yield* store.set(
            DRIVE_CREDENTIALS_SECRET_NAME,
            encodeCredentials({ client: stored.client, token: null }),
          );
        }
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

const LIVE_SERVER_TIMEOUT = Duration.seconds(5);

const describeDrive = (projectId: string, drive: ProjectDriveSettings, via: string) =>
  `Drive for ${projectId}: ${drive.enabled ? "on" : "off"}; output ${drive.outputFolderId ?? "not set"}; input ${drive.inputFolderId ?? "any (whole Drive)"} (${via}).`;

/** Sends the change to the running server, which applies it under its settings lock. */
const updateViaServer = (origin: string, update: ProjectDriveUpdate) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* Effect.acquireUseRelease(
      auth.issueSession({ scopes: [AuthSettingsWriteScope], label: "ai_os drive cli" }),
      (issued) =>
        Effect.gen(function* () {
          const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
          return yield* client.projects.updateDrive({
            headers: { authorization: `Bearer ${issued.token}` },
            payload: update,
          });
        }).pipe(Effect.timeout(LIVE_SERVER_TIMEOUT)),
      (issued) => auth.revokeSession(issued.sessionId).pipe(Effect.ignore),
    );
  });

/**
 * Takes `lock` first and only then builds the settings layer, so settings are
 * read inside the lock and no other writer can change them in between.
 * Exported for the ordering test.
 */
export const updateUnderLock = <E, R, LE, LR>(
  lock: Effect.Effect<void, E, R>,
  settingsLayer: Layer.Layer<ServerSettings.ServerSettingsService, LE, LR>,
  projectId: ProjectId,
  resolved: ResolvedProjectDriveUpdate,
) =>
  Effect.gen(function* () {
    yield* lock;
    return yield* Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      return yield* settings.updateProjectDrive(projectId, resolved);
    }).pipe(Effect.provide(settingsLayer));
  }).pipe(Effect.scoped);

/**
 * With no server reachable, take the same exclusive ownership lock a server
 * takes at start, so no server can write settings while this one does.
 */
const updateOffline = (
  config: ServerConfig.ServerConfig["Service"],
  projectId: ProjectId,
  resolved: ResolvedProjectDriveUpdate,
) =>
  updateUnderLock(
    ServerOwnership.acquireServerOwnership(config.serverRuntimeStatePath).pipe(
      Effect.provide(ProcessRunner.layer),
      Effect.mapError((error) =>
        error._tag === "ServerAlreadyRunningError"
          ? userError(
              "The ai_os server is running but did not answer. Nothing was changed; try again in a moment.",
            )
          : userError(error.message),
      ),
      Effect.andThen(clearPersistedServerRuntimeState(config.serverRuntimeStatePath)),
    ),
    ServerSettings.layer.pipe(
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(SqlitePersistence.layerConfig),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
    ),
    projectId,
    resolved,
  );

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
  clearOutput: Flag.Boolean("clear-output").pipe(
    Flag.withDescription("Remove the output folder."),
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
        const update: ProjectDriveUpdate = {
          projectId,
          ...(Option.isSome(flags.output) ? { output: flags.output.value } : {}),
          ...(Option.isSome(flags.input) ? { input: flags.input.value } : {}),
          clearInput: flags.clearInput,
          clearOutput: flags.clearOutput,
          disable: flags.disable,
        };
        const { projectId: _, ...change } = update;
        const resolved = resolveProjectDriveUpdate(change);
        if ("invalidLink" in resolved) {
          return yield* fail(`Not a Google Drive folder link or id: ${resolved.invalidLink}`);
        }
        const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
        if (Option.isSome(runtime)) {
          const live = yield* Effect.result(
            updateViaServer(runtime.value.origin, update).pipe(
              Effect.provide(
                EnvironmentAuth.layerRuntime.pipe(
                  Layer.provideMerge(FetchHttpClient.layer),
                  Layer.provide(ServerConfig.layer(config)),
                  Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
                ),
              ),
            ),
          );
          if (live._tag === "Success") {
            yield* Console.log(
              describeDrive(projectId, live.success, "saved by the running server"),
            );
            return;
          }
        }
        const drive = yield* updateOffline(config, projectId, resolved);
        yield* Console.log(
          describeDrive(projectId, drive, "server not running; saved to settings"),
        );
      }),
    ),
  ),
);

export const driveCommand = Command.make("drive").pipe(
  Command.withDescription("Google Drive sign-in and project folders."),
  Command.withSubcommands([loginCommand, statusCommand, logoutCommand, projectCommand]),
);
