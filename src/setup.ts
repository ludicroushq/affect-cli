import { Config, Console, Effect, FileSystem } from "effect";
import { some } from "effect/Array";

import { decrypt } from "./dotenv";
import { load, read } from "./environment";
import { CliError } from "effect/cli";
import { convex } from "./process";

const credentials = [
  "CONVEX_DEPLOY_KEY",
  "CONVEX_DEPLOYMENT_TOKEN",
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
];

export const setup = Effect.fn("Setup.run")(function* setup() {
  const environment = yield* load();
  const fs = yield* FileSystem.FileSystem;

  for (const name of credentials) {
    const inherited = yield* Config.String(name).pipe(Config.withDefault(""));

    if (inherited || (environment.values[name] ?? "")) {
      return yield* Console.log("Existing Convex credentials preserved; no backend changes.");
    }
  }

  for (const file of [".env.local", ".env"]) {
    if (yield* fs.exists(file)) {
      const values = yield* read(file);

      if (some(credentials, (name) => (values[name] ?? "") !== "")) {
        return yield* Console.log("Existing Convex credentials preserved; no backend changes.");
      }
    }
  }

  let selection = yield* Config.String("CONVEX_DEPLOYMENT").pipe(
    Config.withDefault(environment.values["CONVEX_DEPLOYMENT"] ?? ""),
  );

  if (!selection && (yield* fs.exists(".env.local"))) {
    selection = (yield* read(".env.local"))["CONVEX_DEPLOYMENT"] ?? "";
  }

  if (!selection.startsWith("anonymous:")) {
    if (
      selection ||
      (yield* fs.exists(".env.local")) ||
      (yield* fs.exists(".env")) ||
      (yield* fs.exists(".convex"))
    ) {
      return yield* Console.log("Existing Convex configuration preserved; no backend changes.");
    }

    yield* convex(["init"], { ...environment.values, CONVEX_AGENT_MODE: "anonymous" });
    selection = (yield* read(".env.local"))["CONVEX_DEPLOYMENT"] ?? "";
  }

  if (!selection.startsWith("anonymous:")) {
    return yield* new CliError.UserError({
      cause: "Setup expected an anonymous backend; environment import stopped.",
    });
  }

  if (environment.exists) {
    const contents = yield* decrypt(environment.file);
    yield* convex(
      ["env", "set"],
      { ...environment.values, CONVEX_DEPLOYMENT: selection },
      contents,
    );
  }

  return yield* Console.log("Local Convex setup complete.");
});
