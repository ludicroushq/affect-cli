import { getSync } from "@dotenvx/dotenvx";
import { Array, Config, Effect, FileSystem, Path, Record, Schema } from "effect";

import { CliError } from "effect/cli";
import { CommandLine } from "effect/process";

const Environment = Schema.Literals(["development", "preview", "production", "ci"]);

const ShellEnvironment = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u)),
  Schema.String,
);

const options = {
  no1Password: true,
  noArmor: true,
  noBitwarden: true,
  noNative: true,
  strict: true,
};

export const read = Effect.fn("Environment.read")(function* read(file: string) {
  return yield* Effect.try({
    catch: () =>
      new CliError.UserError({
        cause: `Cannot load ${file}; check the file and its DOTENV_PRIVATE_KEY.`,
      }),
    try: () => getSync(undefined, { ...options, overload: true, path: file }),
  });
});

export const load = Effect.fn("Environment.load")(function* load() {
  const ci = yield* Config.String("CI").pipe(Config.withDefault(""));
  const actions = yield* Config.String("GITHUB_ACTIONS").pipe(Config.withDefault(""));

  const requested = yield* Config.String("VERCEL_ENV").pipe(Config.withDefault(""));

  const target = yield* Schema.decodeUnknownEffect(Environment)(
    requested || (ci === "true" || actions === "true" ? "ci" : "development"),
  ).pipe(
    Effect.mapError(
      () =>
        new CliError.UserError({
          cause: "Unsupported VERCEL_ENV. Use development, preview, production, or ci.",
        }),
    ),
  );

  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const file = path.resolve("env", target, ".env");
  const exists = yield* fs.exists(file);
  const key = yield* Config.String("DOTENV_PRIVATE_KEY").pipe(Config.withDefault(""));

  if (!exists && key) {
    return yield* new CliError.UserError({ cause: `Missing encrypted project file: ${file}` });
  }

  if (exists && !key) {
    return yield* new CliError.UserError({ cause: `Set DOTENV_PRIVATE_KEY for ${file}` });
  }

  const values = exists ? yield* read(file) : {};
  const inherited = yield* Config.String("CONVEX_DEPLOY_KEY").pipe(Config.withDefault(""));

  if (exists && inherited && inherited !== values["CONVEX_DEPLOY_KEY"]) {
    return yield* new CliError.UserError({
      cause: "CONVEX_DEPLOY_KEY conflicts with the selected encrypted project file.",
    });
  }

  return { exists, file, target, values };
});

export const exports = Effect.fn("Environment.exports")(function* exports() {
  const { values } = yield* load();

  const variables = yield* Schema.decodeEffect(ShellEnvironment, { onExcessProperty: "error" })(
    values,
  ).pipe(
    Effect.mapError(
      () =>
        new CliError.UserError({ cause: "Environment contains an invalid shell variable name." }),
    ),
  );

  const lines = yield* Effect.forEach(Record.toEntries(variables), ([key, value]) =>
    Effect.fromResult(CommandLine.quote(`${key}=${value}`, { format: "posix" })).pipe(
      Effect.map((assignment) => `export ${assignment}`),
    ),
  );

  return Array.join(lines, "\n");
});
