import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { version } from "../package.json";

import {
  evaluateExports,
  fixtureEnv,
  makeFixture,
  readConvexInput,
  readConvexLog,
  readFixtureFile,
  runCli,
} from "./cli-test-helpers";
import type { Fixture } from "./cli-test-helpers";

const active: Fixture[] = [];
const dollar = "$";
const siteTemplate = `${dollar}{VERCEL_URL:+https://}${dollar}{VERCEL_URL:-http://localhost:3000}`;
const originsTemplate = `${dollar}{SITE_URL}${dollar}{VERCEL_URL:+,https://}${dollar}{VERCEL_URL}${dollar}{VERCEL_BRANCH_URL:+,https://}${dollar}{VERCEL_BRANCH_URL}`;

const fixture = async (options?: Parameters<typeof makeFixture>[0]) => {
  const value = await makeFixture(options);
  active.push(value);

  return value;
};

const expectFailure = (result: ReturnType<typeof runCli>, message: RegExp) => {
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(message);
};

describe("published CLI", () => {
  afterEach(async () => {
    await Promise.all(
      active.splice(0).map(async (value) => {
        await value.cleanup();
      }),
    );
  });

  it.each([
    ["--help", /Environment and deployment commands/u],
    ["--version", `affect v${version}`],
  ])("supports %s without project credentials", async (flag, output) => {
    const f = await fixture();
    const result = runCli(f, [flag]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(output);
  });

  it("forwards arguments to the bundled dotenvx", async () => {
    const f = await fixture();
    const result = runCli(f, ["dotenvx", "--", "--version"]);
    expect(result).toMatchObject({ status: 0, stdout: "2.38.0\n" });
  });

  it.each([
    ["development", {}],
    ["ci", { CI: "true" }],
    ["ci", { GITHUB_ACTIONS: "true" }],
    ["preview", { CI: "true", VERCEL_ENV: "preview" }],
    ["ci", { CI: "true", VERCEL_ENV: "" }],
  ])("selects %s from environment precedence", async (environment, overrides) => {
    const f = await fixture({ environment, values: { AFFECT_SELECTED: environment } });
    const result = runCli(f, ["env"], { ...fixtureEnv(f), ...overrides });
    expect(result.status).toBe(0);
    expect(evaluateExports(f, result.stdout, "AFFECT_SELECTED")).toMatchObject({
      status: 0,
      stdout: environment,
    });
  });

  it("round-trips quotes, backticks, dollar signs, and newlines through the shell", async () => {
    const value = "single' double\" `touch escaped-marker` dollar$\nnext";
    const f = await fixture({ values: { AFFECT_VALUE: value } });
    const result = runCli(f, ["env"], fixtureEnv(f));
    expect(result.status).toBe(0);
    expect(evaluateExports(f, result.stdout, "AFFECT_VALUE")).toMatchObject({
      status: 0,
      stdout: value,
    });
    await expect(readFixtureFile(f, "escaped-marker")).rejects.toThrow("ENOENT");
  });

  it("resolves dotenvx command substitutions exactly once before exporting", async () => {
    const f = await fixture();
    await mkdir(path.dirname(f.envFile), { recursive: true });
    await writeFile(f.envFile, 'AFFECT_COUNTER="$(echo invocation >> counter; printf resolved)"\n');
    const result = runCli(f, ["env"], { DOTENV_PRIVATE_KEY: "synthetic-unused-key" });
    expect(result.status).toBe(0);
    expect(evaluateExports(f, result.stdout, "AFFECT_COUNTER")).toMatchObject({
      status: 0,
      stdout: "resolved",
    });
    await expect(readFixtureFile(f, "counter")).resolves.toBe("invocation\n");
  });

  it("expands the Vercel URL template to the local fallback without Vercel variables", async () => {
    const f = await fixture({
      values: {
        SITE_URL: siteTemplate,
        TRUSTED_ORIGINS: originsTemplate,
      },
    });

    const result = runCli(f, ["env"], fixtureEnv(f));
    expect(result.status).toBe(0);
    expect(evaluateExports(f, result.stdout, "SITE_URL")).toMatchObject({
      status: 0,
      stdout: "http://localhost:3000",
    });
    expect(evaluateExports(f, result.stdout, "TRUSTED_ORIGINS")).toMatchObject({
      status: 0,
      stdout: "http://localhost:3000",
    });
  });

  it("rejects invalid shell variable names without exposing their values", async () => {
    const f = await fixture();
    await mkdir(path.dirname(f.envFile), { recursive: true });
    await writeFile(f.envFile, "BAD-NAME=private-test-value\n");
    const result = runCli(f, ["env"], { DOTENV_PRIVATE_KEY: "synthetic-unused-key" });
    expectFailure(result, /invalid shell variable name/u);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("private-test-value");
  });

  it("allows a fresh project without an encrypted file or key", async () => {
    const f = await fixture();
    expect(runCli(f, ["env"])).toMatchObject({ status: 0, stderr: "", stdout: "\n" });
  });

  it("rejects an unsupported environment", async () => {
    const f = await fixture();
    const result = runCli(f, ["env"], { VERCEL_ENV: "staging" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Unsupported/u);
  });

  it("rejects a missing encrypted file without exposing the key", async () => {
    const f = await fixture();
    const result = runCli(f, ["env"], { DOTENV_PRIVATE_KEY: "never-print-this" });
    expectFailure(result, /Missing encrypted project file/u);
    expect(result.stderr).not.toContain("never-print-this");
  });

  it("requires the key for an existing encrypted file", async () => {
    const f = await fixture({ values: { PRIVATE_VALUE: "secret-fixture" } });
    const result = runCli(f, ["env"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Set DOTENV_PRIVATE_KEY/u);
  });

  it("fails with a wrong key and does not expose plaintext", async () => {
    const f = await fixture({ values: { PRIVATE_VALUE: "secret-fixture" } });
    const result = runCli(f, ["env"], { DOTENV_PRIVATE_KEY: "0".repeat(64) });
    expectFailure(result, /Cannot load/u);
    expect(`${result.stdout}${result.stderr}`).not.toContain("secret-fixture");
  });

  it("rejects conflicting inherited deployment credentials", async () => {
    const f = await fixture({ values: { CONVEX_DEPLOY_KEY: "preview:expected" } });
    expectFailure(
      runCli(f, ["env"], { ...fixtureEnv(f), CONVEX_DEPLOY_KEY: "prod:other" }),
      /CONVEX_DEPLOY_KEY conflicts/u,
    );
    await expect(readConvexLog(f)).resolves.toBe("");
  });

  it("initializes a fresh anonymous backend and imports config without installing", async () => {
    const f = await fixture({ values: { AFFECT_SETUP_VALUE: "synthetic setup value" } });
    expect(runCli(f, ["setup"], fixtureEnv(f)).status).toBe(0);
    await expect(readConvexLog(f)).resolves.toMatch(
      /^init\nCONVEX_DEPLOY_KEY=\nCONVEX_AGENT_MODE=anonymous\nenv set/mu,
    );
    await expect(readConvexInput(f, 1)).resolves.toContain(
      'AFFECT_SETUP_VALUE="synthetic setup value"',
    );
    await expect(readFixtureFile(f, "install.marker")).rejects.toThrow("ENOENT");
    await expect(readFixtureFile(f, "bun.lock")).rejects.toThrow("ENOENT");
  });

  it("retries an existing anonymous backend without another initialization", async () => {
    const f = await fixture({ values: { AFFECT_SETUP_VALUE: "retry value" } });
    await writeFile(path.join(f.root, ".env.local"), "CONVEX_DEPLOYMENT=anonymous:existing\n");
    expect(runCli(f, ["setup"], fixtureEnv(f)).status).toBe(0);
    await expect(readConvexLog(f)).resolves.toMatch(/^env set\n/u);
  });

  it.each([
    "CONVEX_DEPLOYMENT=named:fixture\n",
    "CONVEX_DEPLOYMENT_TOKEN=token-fixture\n",
    "CONVEX_SELF_HOSTED_URL=http://self-hosted\n",
    "CONVEX_SELF_HOSTED_ADMIN_KEY=admin-fixture\n",
  ])("preserves existing %s", async (configuration) => {
    const f = await fixture();
    await writeFile(path.join(f.root, ".env.local"), configuration);
    const result = runCli(f, ["setup"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/preserved/u);
    await expect(readConvexLog(f)).resolves.toBe("");
  });

  it("stops setup if initialization does not return an anonymous backend", async () => {
    const f = await fixture({ convexMode: "bad-init", values: { AFFECT_VALUE: "test" } });
    expectFailure(runCli(f, ["setup"], fixtureEnv(f)), /expected an anonymous backend/u);
    await expect(readConvexLog(f)).resolves.toMatch(/^init\n/u);
    await expect(readConvexInput(f, 1)).rejects.toThrow("ENOENT");
  });

  it.each([
    ["production", "prod:synthetic-secret", /^deploy --cmd .*affect deploy --build/u],
    [
      "preview",
      "preview:synthetic-secret",
      /^deploy --preview-name feature\/fixture --cmd .*affect deploy --build/u,
    ],
  ])(
    "deploys %s with matching credentials and an explicit preview name",
    async (environment, key, command) => {
      const f = await fixture({ environment, values: { CONVEX_DEPLOY_KEY: key } });

      const result = runCli(f, ["deploy"], {
        ...fixtureEnv(f),
        VERCEL_ENV: environment,
        VERCEL_GIT_COMMIT_REF: "feature/fixture",
      });

      expect(result.status).toBe(0);
      await expect(readConvexLog(f)).resolves.toMatch(command);
      await expect(readFixtureFile(f, "apps/web/.env.production")).resolves.toBe(
        await readFile(f.envFile, "utf-8"),
      );
      expect(`${result.stdout}${result.stderr}`).not.toContain(key);
    },
  );

  it("rejects a development deployment target", async () => {
    const f = await fixture();
    expectFailure(runCli(f, ["deploy"]), /VERCEL_ENV=preview or production/u);
    await expect(readConvexLog(f)).resolves.toBe("");
  });

  it("requires a preview branch", async () => {
    const f = await fixture({
      environment: "preview",
      values: { CONVEX_DEPLOY_KEY: "preview:key" },
    });

    expectFailure(
      runCli(f, ["deploy"], { ...fixtureEnv(f), VERCEL_ENV: "preview" }),
      /branch name/u,
    );
    await expect(readConvexLog(f)).resolves.toBe("");
  });

  it("rejects a deployment key for the wrong target before copying or deploying", async () => {
    const f = await fixture({
      environment: "production",
      values: { CONVEX_DEPLOY_KEY: "preview:key" },
    });

    expectFailure(
      runCli(f, ["deploy"], { ...fixtureEnv(f), VERCEL_ENV: "production" }),
      /matching VERCEL_ENV/u,
    );
    await expect(readFixtureFile(f, "apps/web/.env.production")).rejects.toThrow("ENOENT");
    await expect(readConvexLog(f)).resolves.toBe("");
  });

  it.each(["production", "preview"])(
    "keeps Convex URLs and imports before the %s build",
    async (environment) => {
      const key = environment === "preview" ? "preview:test" : "prod:test";

      const f = await fixture({
        environment,
        values: {
          CONVEX_DEPLOY_KEY: key,
          INTERPOLATED_VALUE: `${dollar}{VERCEL_URL}`,
          NEXT_PUBLIC_CONVEX_SITE_URL: "stale-site",
          NEXT_PUBLIC_CONVEX_URL: "stale-cloud",
          SITE_URL: "configured-site",
          SPECIAL_VALUE: `quote" single' backslash\\n CRLF\r\n trailing\n`,
        },
      });

      const result = runCli(f, ["deploy", "--build"], {
        ...fixtureEnv(f),
        INHERITED_SECRET: "inherited-synthetic-secret",
        NEXT_PUBLIC_CONVEX_SITE_URL: "https://injected-site.convex.site",
        NEXT_PUBLIC_CONVEX_URL: "https://injected-cloud.convex.cloud",
        VERCEL_ENV: environment,
        VERCEL_GIT_COMMIT_REF: "feature/fixture",
        VERCEL_URL: "expanded.example.com",
      });

      const httpLog = await readFixtureFile(f, "convex-http.log");
      const body = await readFixtureFile(f, "convex-http.body");
      const build = await readFixtureFile(f, "build.marker");
      expect({ build, status: result.status }).toStrictEqual({
        build:
          "https://injected-cloud.convex.cloud|https://injected-site.convex.site|configured-site",
        status: 0,
      });
      expect(httpLog).toContain(
        `https://injected-cloud.convex.cloud/api/v1/update_environment_variables\nConvex ${key}`,
      );
      expect(JSON.parse(body)).toHaveProperty(
        "changes",
        expect.arrayContaining([
          { name: "INTERPOLATED_VALUE", value: "expanded.example.com" },
          { name: "SITE_URL", value: "configured-site" },
          {
            name: "SPECIAL_VALUE",
            value: `quote" single' backslash\\n CRLF\r\n trailing\n`,
          },
        ]),
      );
      expect(body).not.toMatch(/INHERITED_SECRET|CONVEX_DEPLOY_KEY|NEXT_PUBLIC_CONVEX_URL/u);
    },
  );

  it("runs the Convex build callback with only the encrypted preview key", async () => {
    const f = await fixture({
      convexMode: "run-build",
      environment: "preview",
      values: {
        CONVEX_DEPLOY_KEY: "preview:test",
        NEXT_PUBLIC_CONVEX_SITE_URL: "stale-site",
        NEXT_PUBLIC_CONVEX_URL: "stale-cloud",
        NEXT_PUBLIC_POSTHOG_HOST: `${dollar}{POSTHOG_HOST}`,
        NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: `${dollar}{POSTHOG_PROJECT_TOKEN}`,
        POSTHOG_HOST: "https://us.i.posthog.com",
        POSTHOG_PROJECT_TOKEN: "",
        SITE_URL: siteTemplate,
        TRUSTED_ORIGINS: originsTemplate,
      },
    });

    const environment = {
      ...fixtureEnv(f),
      CI: "true",
      VERCEL: "1",
      VERCEL_BRANCH_URL: "feature-fixture.example.com",
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "feature/fixture",
    };

    const encrypted = await readFile(f.envFile, "utf-8");

    for (const host of ["preview.example.com", "preview-refresh.example.com"]) {
      const result = runCli(f, ["deploy"], { ...environment, VERCEL_URL: host });

      const build = readFileSync(path.join(f.root, "build.marker"), "utf-8");
      const copied = readFileSync(path.join(f.root, "apps/web/.env.production"), "utf-8");
      const body = readFileSync(f.convexHttpBody, "utf-8");

      expect({ build, copied, status: result.status }).toMatchObject({
        build: `https://callback.convex.cloud|https://callback.convex.site|https://${host}`,
        copied: encrypted,
        status: 0,
      });
      expect(body).toContain(`https://${host}`);
      expect(body).toContain(`https://${host},https://${host},https://feature-fixture.example.com`);
      expect(body).toContain('"name":"POSTHOG_PROJECT_TOKEN","value":""');
      expect(body).not.toContain("CONVEX_DEPLOY_KEY");
    }

    const log = await readConvexLog(f);
    expect(
      log.match(/^deploy --preview-name feature\/fixture --cmd .*affect deploy --build/gmu),
    ).toHaveLength(2);
    expect(log).not.toContain("--preview-create");
  });

  it("stops before the build if environment synchronization fails", async () => {
    const f = await fixture({
      convexMode: "fail-env-set",
      environment: "production",
      values: {
        CONVEX_DEPLOY_KEY: "prod:test",
        FAIL_VALUE: "payload-secret-sentinel",
      },
    });

    const result = runCli(f, ["deploy", "--build"], {
      ...fixtureEnv(f),
      NEXT_PUBLIC_CONVEX_SITE_URL: "https://injected-site.convex.site",
      NEXT_PUBLIC_CONVEX_URL: "https://injected-cloud.convex.cloud",
      VERCEL_ENV: "production",
    });

    expectFailure(result, /Could not synchronize Convex environment variables/u);
    expect(result.stderr).not.toContain("prod:test");
    expect(result.stderr).not.toContain("payload-secret-sentinel");
    await expect(readFixtureFile(f, "build.marker")).rejects.toThrow("ENOENT");
  });

  it("propagates a build failure", async () => {
    const f = await fixture({
      environment: "production",
      values: { BUILD_VALUE: "synthetic", CONVEX_DEPLOY_KEY: "prod:test" },
    });

    await writeFile(
      path.join(f.root, "package.json"),
      JSON.stringify({ private: true, scripts: { build: 'node -e "process.exit(31)"' } }),
    );

    const result = runCli(f, ["deploy", "--build"], {
      ...fixtureEnv(f),
      NEXT_PUBLIC_CONVEX_SITE_URL: "https://site.convex.site",
      NEXT_PUBLIC_CONVEX_URL: "https://cloud.convex.cloud",
      VERCEL_ENV: "production",
    });

    expectFailure(result, /bun exited with status 31/u);
    await expect(readFixtureFile(f, "convex-http.body")).resolves.toContain('"changes"');
  });

  it("propagates a deployment failure", async () => {
    const f = await fixture({
      convexMode: "fail-deploy",
      environment: "production",
      values: { CONVEX_DEPLOY_KEY: "prod:test" },
    });

    expectFailure(
      runCli(f, ["deploy"], { ...fixtureEnv(f), VERCEL_ENV: "production" }),
      /exited with status 24/u,
    );
    await expect(readFixtureFile(f, "build.marker")).rejects.toThrow("ENOENT");
  });
});
