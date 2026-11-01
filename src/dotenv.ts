import { Effect, Path } from "effect";
import { ChildProcess } from "effect/process";

import { run } from "./process";

export const dotenvx = Effect.fn("Dotenvx.run")(function* dotenvx(
  args: readonly string[],
  capture: boolean,
) {
  const path = yield* Path.Path;

  const bin = yield* path.fromFileUrl(
    new URL("src/cli/dotenvx.js", import.meta.resolve("@dotenvx/dotenvx/package.json")),
  );

  return yield* run(
    ChildProcess.make("bun", [bin, ...args], {
      stderr: capture ? "ignore" : "inherit",
      stdin: "inherit",
      stdout: capture ? "pipe" : "inherit",
    }),
  );
});

export const decrypt = (file: string) =>
  dotenvx(["decrypt", "--stdout", "--no-armor", "--no-native", "-f", file], true);
