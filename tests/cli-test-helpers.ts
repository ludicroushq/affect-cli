import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const cliRoot = path.resolve(import.meta.dirname, "..");
export const cliEntry = path.join(cliRoot, "dist/index.js");

interface FixtureOptions {
  environment?: string;
  values?: Record<string, string>;
  convexMode?: string;
}

export interface Fixture {
  root: string;
  envFile: string;
  privateKey: string | undefined;
  convexLog: string;
  convexInputDir: string;
  convexCount: string;
  convexMode: string;
  cleanup: () => Promise<void>;
}

const pathForTest = (fixture: string) =>
  [path.join(fixture, "node_modules", ".bin"), process.env["PATH"] ?? ""].filter(Boolean).join(":");

type TestEnvironment = Record<string, string>;

const cleanEnv = (root: string, extra: TestEnvironment = {}) => ({
  HOME: path.join(root, ".home"),
  PATH: pathForTest(root),
  TMPDIR: path.join(root, ".tmp"),
  XDG_CACHE_HOME: path.join(root, ".cache"),
  XDG_CONFIG_HOME: path.join(root, ".config"),
  ...extra,
});

const runDotenvx = (root: string, args: string[]) => {
  const result = spawnSync(
    "bun",
    [path.join(cliRoot, "node_modules/@dotenvx/dotenvx/src/cli/dotenvx.js"), ...args],
    {
      cwd: root,
      encoding: "utf-8",
      env: cleanEnv(root),
    },
  );

  if (result.status !== 0) {
    throw new Error(`dotenvx failed (${result.status}): ${result.stderr || result.stdout}`);
  }
};

const readPrivateKey = async (keysFile: string) => {
  const source = await readFile(keysFile, "utf-8");

  return /^DOTENV_PRIVATE_KEY=(?<privateKey>.+)$/mu.exec(source)?.groups?.["privateKey"];
};

export const makeFixture = async ({
  environment = "development",
  values,
  convexMode = "",
}: FixtureOptions = {}): Promise<Fixture> => {
  const root = await mkdtemp(path.join(tmpdir(), "affect-cli-"));
  const convexBin = path.join(root, "node_modules", ".bin", "convex");
  const convexInputDir = path.join(root, "convex-input");
  const convexLog = path.join(root, "convex.log");
  const convexCount = path.join(root, "convex.count");
  await mkdir(path.dirname(convexBin), { recursive: true });
  await mkdir(convexInputDir, { recursive: true });
  await mkdir(path.join(root, "apps", "web"), { recursive: true });
  await mkdir(path.join(root, ".home"), { recursive: true });
  await mkdir(path.join(root, ".tmp"), { recursive: true });

  await writeFile(
    convexBin,
    `#!/bin/sh
set -eu
count=0
if [ -f "$AFFECT_FAKE_CONVEX_COUNT" ]; then
  count=$(cat "$AFFECT_FAKE_CONVEX_COUNT")
fi
printf '%s\\n' "$((count + 1))" > "$AFFECT_FAKE_CONVEX_COUNT"
printf '%s\\n' "$*" >> "$AFFECT_FAKE_CONVEX_LOG"
printf 'CONVEX_DEPLOY_KEY=%s\\n' "\${CONVEX_DEPLOY_KEY-}" >> "$AFFECT_FAKE_CONVEX_LOG"
printf 'CONVEX_AGENT_MODE=%s\\n' "\${CONVEX_AGENT_MODE-}" >> "$AFFECT_FAKE_CONVEX_LOG"
case "\${1-}" in
  init)
    if [ "\${AFFECT_FAKE_CONVEX_MODE-}" = bad-init ]; then
      printf '%s\\n' 'CONVEX_DEPLOYMENT=named:fixture' > .env.local
    else
      printf '%s\\n' 'CONVEX_DEPLOYMENT=anonymous:fixture' > .env.local
    fi
    ;;
  env)
    cat > "$AFFECT_FAKE_CONVEX_INPUT_DIR/$count"
    if [ "\${AFFECT_FAKE_CONVEX_MODE-}" = fail-env-set ]; then exit 23; fi
    ;;
  deploy)
    if [ "\${AFFECT_FAKE_CONVEX_MODE-}" = fail-deploy ]; then exit 24; fi
    ;;
esac
`,
    { mode: 0o755 },
  );

  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      private: true,
      scripts: {
        build:
          "node -e \"require('fs').writeFileSync('build.marker', [process.env.NEXT_PUBLIC_CONVEX_URL || '', process.env.NEXT_PUBLIC_CONVEX_SITE_URL || '', process.env.SITE_URL || ''].join('|'))\"",
        preinstall: "node -e \"require('fs').writeFileSync('install.marker', 'installed')\"",
      },
    }),
  );

  const envDir = path.join(root, "env", environment);
  const envFile = path.join(envDir, ".env");
  const keysFile = path.join(root, ".env.keys");
  let privateKey: string | undefined;

  if (values !== undefined) {
    await mkdir(envDir, { recursive: true });

    for (const [key, value] of Object.entries(values)) {
      runDotenvx(root, [
        "set",
        key,
        value,
        "--encrypt",
        "--no-native",
        "--no-armor",
        "--no-1password",
        "--no-bitwarden",
        "-f",
        envFile,
        "-fk",
        keysFile,
      ]);
    }

    privateKey = await readPrivateKey(keysFile);
    await unlink(keysFile);
  }

  return {
    cleanup: async () => {
      await rm(root, { force: true, recursive: true });
    },
    convexCount,
    convexInputDir,
    convexLog,
    convexMode,
    envFile,
    privateKey,
    root,
  };
};

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export const evaluateExports = (fixture: Fixture, exportsText: string, variable: string) => {
  const result = spawnSync(
    "bash",
    ["-c", `eval "$1"; printf '%s' "$${variable}"`, "bash", exportsText],
    { cwd: fixture.root, encoding: "utf-8", env: cleanEnv(fixture.root) },
  );

  return { status: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
};

export const runCli = (
  fixture: Fixture,
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): CliResult => {
  const env: NodeJS.ProcessEnv = cleanEnv(fixture.root, {
    AFFECT_FAKE_CONVEX_COUNT: fixture.convexCount,
    AFFECT_FAKE_CONVEX_INPUT_DIR: fixture.convexInputDir,
    AFFECT_FAKE_CONVEX_LOG: fixture.convexLog,
    AFFECT_FAKE_CONVEX_MODE: fixture.convexMode,
  });

  for (const [key, value] of Object.entries(extraEnv)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  const result = spawnSync("bun", [cliEntry, ...args], {
    cwd: fixture.root,
    encoding: "utf-8",
    env,
  });

  return { status: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
};

export const readConvexLog = async (fixture: Fixture) => {
  try {
    return await readFile(fixture.convexLog, "utf-8");
  } catch {
    return "";
  }
};

export const readConvexInput = async (fixture: Fixture, index: number) =>
  await readFile(path.join(fixture.convexInputDir, String(index)), "utf-8");

export const readFixtureFile = async (fixture: Fixture, relativePath: string) =>
  await readFile(path.join(fixture.root, relativePath), "utf-8");

export const fixtureEnv = (fixture: Fixture) => ({
  DOTENV_PRIVATE_KEY: fixture.privateKey,
});
