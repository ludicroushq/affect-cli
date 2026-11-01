import { Config, Console, Effect, FileSystem } from "effect";
import { ChildProcess } from "effect/process";

import { decrypt } from "./dotenv";
import { load } from "./environment";
import { CliError } from "effect/cli";
import { convex, run } from "./process";

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

  if (!(values["CONVEX_DEPLOY_KEY"] ?? "").startsWith(prefix)) {
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
    const contents = yield* decrypt(file);
    yield* convex(
      ["env", "set", "--force", ...(target === "preview" ? ["--preview-name", branch] : [])],
      values,
      contents,
    );

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
