# affect-cli

Shared environment and deployment commands for [Affect](https://github.com/ludicroushq/affect). Requires Bun 1.4.2 or later and a project-local Convex CLI.

```sh
bun add --dev --exact affect-cli
bunx --no-install affect --help
```

Run commands from the application repository root:

- `affect env` prints shell exports from `env/{development,preview,production,ci}/.env`. It requires the matching `DOTENV_PRIVATE_KEY` when that file exists. Treat its output as secrets.
- `affect dotenvx -- …` forwards arguments to the bundled native dotenvx CLI, for example `affect dotenvx -- encrypt -f env/development/.env --no-armor --no-native`.
- `affect setup` initializes an anonymous local Convex backend only for a fresh project, or retries its environment import. It preserves existing linked deployments and credentials.
- `affect deploy` uses Convex's native deploy/build sequence, imports the selected backend environment, and builds the frontend. It requires `VERCEL_ENV=preview|production`, a matching deploy key in the encrypted file, and a branch name for previews. `--build` is its internal Convex callback.

Selection uses `VERCEL_ENV`, then `ci` for GitHub Actions/CI, otherwise `development`. Files stay in the application; cryptography stays in dotenvx. Deployment follows Affect's `apps/web` layout.

For Mise, install dependencies once, then use:

```toml
[env]
_.source = { path = "node_modules/affect-cli/scripts/activate.sh", tools = true, redact = true }
_.file = { path = ".env.local", tools = true }

[tasks.setup]
run = "bun install --frozen-lockfile && bunx --no-install affect setup"
```

The Bash bridge only exports the CLI's output into the parent shell. It does not change backend state.

## Development and releases

```sh
bun install --frozen-lockfile
bun run check
bun run changeset
bun run changeset version
bun run release
```

For automated releases, commit a changeset with each releasable change. The release workflow opens a version PR; merging it publishes to npm. Configure npm's GitHub trusted publisher for `ludicroushq/affect-cli`, workflow `release.yml`, with direct publishing enabled. No npm token is needed. `bun run release` remains available for an intentional manual release.
