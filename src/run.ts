import { Effect } from "effect";
import { ChildProcess } from "effect/process";

import { load } from "./environment";

export const run = Effect.fn("Run.command")(function* run(
  command: string,
  args: readonly string[],
) {
  const { values } = yield* load();

  const child = yield* ChildProcess.make(command, args, {
    env: { ...values, ...process.env },
    extendEnv: true,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });

  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    yield* Effect.sync(() => {
      process.exitCode = exitCode;
    });
  }
}, Effect.scoped);
