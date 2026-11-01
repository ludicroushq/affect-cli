import { Effect, Stream } from "effect";
import { ChildProcess } from "effect/process";

import { CliError } from "effect/cli";

export const run = Effect.fn("Process.run")(function* run(command: ChildProcess.StandardCommand) {
  const child = yield* command;
  const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
  const code = yield* child.exitCode;

  if (code !== 0) {
    return yield* new CliError.UserError({
      cause: `${command.command} exited with status ${code}.`,
    });
  }

  return output;
}, Effect.scoped);

export const convex = (args: readonly string[], env: Record<string, string>, input?: string) =>
  run(
    ChildProcess.make("bunx", ["--no-install", "convex", ...args], {
      env,
      extendEnv: true,
      stderr: "inherit",
      stdin: input === undefined ? "inherit" : Stream.make(new TextEncoder().encode(input)),
      stdout: "inherit",
    }),
  );
