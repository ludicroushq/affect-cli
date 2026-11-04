import { Array, Config, Console, Effect, FileSystem, Record } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess } from "effect/process";

import { load } from "./environment";
import { CliError } from "effect/cli";
import { convex, run } from "./process";

// Keep in sync with Convex's managed environment names:
// https://github.com/get-convex/convex-js/blob/main/src/cli/lib/env.ts
const convexManagedEnvironmentNames = [
  "CONVEX_DEPLOY_KEY",
  "CONVEX_DEPLOYMENT_TOKEN",
  "CONVEX_DEPLOYMENT",
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
  "CONVEX_URL",
  "PUBLIC_CONVEX_URL",
  "NEXT_PUBLIC_CONVEX_URL",
  "VITE_CONVEX_URL",
  "REACT_APP_CONVEX_URL",
  "EXPO_PUBLIC_CONVEX_URL",
  "CONVEX_SITE_URL",
  "PUBLIC_CONVEX_SITE_URL",
  "NEXT_PUBLIC_CONVEX_SITE_URL",
  "VITE_CONVEX_SITE_URL",
  "REACT_APP_CONVEX_SITE_URL",
  "EXPO_PUBLIC_CONVEX_SITE_URL",
] as const;

export const deploy = Effect.fn("Deploy.run")(function* deploy(build: boolean) {
  const environment = yield* load();
  const { target, values, file } = environment;

  if (target !== "preview" && target !== "production") {
    return yield* new CliError.UserError({
      cause: "Deploy requires VERCEL_ENV=preview or production.",
    });
  }

  const branch = yield* Config.String("VERCEL_GIT_COMMIT_REF").pipe(Config.withDefault(""));

  if (target === "preview" && !branch) {
    return yield* new CliError.UserError({ cause: "Preview deployment requires a branch name." });
  }

  const prefix = target === "preview" ? "preview:" : "prod:";

  const deployKey = values["CONVEX_DEPLOY_KEY"] ?? "";

  if (!deployKey.startsWith(prefix)) {
    return yield* new CliError.UserError({
      cause: "Encrypted project file must contain a Convex deploy key matching VERCEL_ENV.",
    });
  }

  yield* Console.error(
    `Convex target: ${target}${target === "preview" ? ` (${branch})` : ""}; selected by env/${target}/.env.`,
  );

  if (build) {
    const cloud = yield* Config.NonEmptyString("NEXT_PUBLIC_CONVEX_URL");
    const site = yield* Config.NonEmptyString("NEXT_PUBLIC_CONVEX_SITE_URL");

    const changes = Array.map(
      Array.filter(
        Record.toEntries(values),
        ([name]) => !Array.contains(name)(convexManagedEnvironmentNames),
      ),
      ([name, value]) => ({ name, value }),
    );

    if (changes.length > 0) {
      yield* Effect.gen(function* syncEnvironmentVariables() {
        const client = yield* HttpClient.HttpClient;

        const request = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.setHeader(
            HttpClientRequest.post(`${cloud}/api/v1/update_environment_variables`),
            "Authorization",
            `Convex ${deployKey}`,
          ),
          { changes },
        );

        yield* HttpClient.filterStatusOk(client).execute(request).pipe(Effect.asVoid);
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.mapError(
          () =>
            new CliError.UserError({
              cause: "Could not synchronize Convex environment variables.",
            }),
        ),
      );
    }

    return yield* run(
      ChildProcess.make("bun", ["run", "build"], {
        env: { ...values, NEXT_PUBLIC_CONVEX_SITE_URL: site, NEXT_PUBLIC_CONVEX_URL: cloud },
        extendEnv: true,
        stderr: "inherit",
        stdout: "inherit",
      }),
    ).pipe(Effect.asVoid);
  }

  const fs = yield* FileSystem.FileSystem;
  yield* fs.copyFile(file, "apps/web/.env.production");

  return yield* convex(
    [
      "deploy",
      ...(target === "preview" ? ["--preview-name", branch] : []),
      "--cmd",
      "bunx --no-install affect deploy --build",
    ],
    values,
  ).pipe(Effect.asVoid);
});
