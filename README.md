# Platform

The desired state of every system running on the organization's servers, and the one workflow
that puts it there. Decision record: ADR-0007 of the standard stack (deploy, configuration and
secrets on GitHub).

```
system repository  → tests, scans, builds → images in the registry, identified by digest
this repository    → one file per system and environment, pointing at those digests
merged pull request → deploy workflow → runner on the server → migration step → Docker Compose
GitHub Environments → variables and secrets, delivered to each container as one file
```

A server needs Docker, one service user and one runner. No deploy tool, no secret store and no
open port.

## Layout

| Path | What it is |
|---|---|
| `environments/staging/<system>.compose.yaml` | What runs in staging |
| `environments/production/<system>.compose.yaml` | What runs in production |
| `scripts/lib.ts` | The rules: what a system file may contain, what the platform adds |
| `scripts/platform.ts` | The commands the workflows run: `validate`, `changes`, `target`, `deploy`, `remove` |
| `scripts/deploy.e2e.ts` | A deploy with a migration step against the machine's own Docker |
| `.github/workflows/validate.yaml` | Checks every pull request, on GitHub's machines |
| `.github/workflows/deploy.yaml` | Deploys what a merge changed, on the server's runner |
| `bootstrap.sh` | Prepares a server |

## A system file

A system file says which image runs and how much it may use. Everything else is added by the
platform at deploy time.

```yaml
services:
  app:
    image: ghcr.io/<organization>/<system>@sha256:<digest>
    mem_limit: 512m
    cpus: 1.0
    tmpfs: [/tmp]
    environment:
      APP_SURFACE: internal
```

A system with a database (ADR-0016) adds its migration step: a service named `migrate` running
the second image its pipeline publishes for the release, `<application image>/migrate`.

```yaml
services:
  app:
    image: ghcr.io/<organization>/<system>@sha256:<digest>
    mem_limit: 512m
    cpus: 1.0
    tmpfs: [/tmp]
  migrate:
    image: ghcr.io/<organization>/<system>/migrate@sha256:<digest>
    mem_limit: 256m
    cpus: 0.5
```

`migrate` is a one-shot step, not a service that stays up: `deploy` runs it once before the
release starts (see [Migrations](#migrations)), and `docker compose up` leaves it out. Both
digests come from the summary of the system's pipeline run and are promoted together.

**Added to every service by the platform:** read-only filesystem, all Linux capabilities
dropped, no privilege escalation, restart policy, rotated logs, the configuration file at
`/run/secrets/config`, the environment's private network with the name `<system>-<service>`,
and labels with system, environment and release.

**Added to `migrate` instead:** the same read-only filesystem, dropped capabilities, no privilege
escalation, logs and labels; scratch space at `/tmp`; the `migrate` profile, so `up` never starts
it; no restart; the environment's network only (it reaches the database, not the system's other
services); and its own configuration file, attached for the run only.

**Rejected by `validate`:** images not pinned by digest, published ports, host paths,
privileged mode, added capabilities, host namespaces, running as root, variable interpolation,
`profiles`, missing memory or CPU limit, and a production image that is not the one in staging.
The `migrate` service obeys the same rules and must run `<image of another service>/migrate`;
no other service may run a migration image; production must have a `migrate` step when staging
has one.

## Configuration

Each system and environment has a GitHub environment named `<system>-<environment>` (for
example `orders-production`). Its variables and secrets reach each container as one JSON file:

```json
{ "DATABASE_URL": "...", "PORT": "3000" }
```

The file is at `/run/secrets/config`. Values are never placed in the image, in the system
file, in container environment variables or in workflow logs. The application reads the file at
startup, validates it against its schema and refuses to start if it is incomplete.

A name defined both as a variable and as a secret stops the deploy.

### Migrations

A system with a `migrate` service uses two database logins (ADR-0016): the application login, in
`DATABASE_USER` and `DATABASE_PASSWORD`, and the migration login, which has DDL rights, in the
secrets `MIGRATION_DATABASE_USER` and `MIGRATION_DATABASE_PASSWORD`. Each container receives its
own file:

| Container | Its `/run/secrets/config` |
|---|---|
| Every service | Every variable and secret except `MIGRATION_*` |
| `migrate` | The `DATABASE_*` keys only, with `DATABASE_USER` and `DATABASE_PASSWORD` taken from `MIGRATION_DATABASE_USER` and `MIGRATION_DATABASE_PASSWORD` |

The deploy stops before changing anything when the migration login is missing, is defined as a
variable instead of a secret, or another `MIGRATION_*` name exists.

Order of a deploy:

1. Write the release directory (system file, the services' configuration, platform settings).
2. Run `migrate` once, with the services' hardening and its own configuration file. That file
   lives in a private directory outside the release and is deleted when the run ends, so the
   migration login is never kept on the server.
3. Only if the step ends with code 0, start the release.

A failed migration starts nothing and restarts nothing: the release that was running keeps
running, and the summary records `migration failed`. A step that runs longer than
`PLATFORM_MIGRATION_SECONDS` (600 by default) is stopped and counts as failed. Migrations are
idempotent, so deploying the same release again runs the step and it finds nothing to apply.

## Day to day

| Task | How |
|---|---|
| Deploy a new version to staging | Pull request changing the digest in `environments/staging/<system>.compose.yaml`; a second administrator approves; merging deploys |
| Promote to production | Pull request copying that digest to `environments/production/<system>.compose.yaml` |
| Change a variable or secret | Edit it in the GitHub environment, then run the `deploy` workflow by hand for that system and environment |
| Go back to an earlier version | Revert the pull request. A deploy that does not become healthy returns to the previous release by itself |
| Add a system | Create its two GitHub environments, restricted to the `main` branch; grant this repository read access to the system's image; open a pull request with its staging file |
| Remove a system | Pull request deleting its file. The system is stopped and its configuration deleted from the server; named volumes are kept |

Each run of the workflow records the system, the environment, the release, the images, the
outcome of the migration step, and the names (never the values) of the variables and secrets of
the environment and of the keys delivered to the services and to the migration step. A release is identified by its content: the
same system file and the same configuration give the same release, and deploying it again
restarts nothing.

## Setting up

**GitHub, once:**

1. Require two-factor authentication for the organization.
2. Give write access to this repository to platform administrators only.
3. Protect `main`: pull request required, one approval, the `validate` check required, no force push.
4. Keep no variable or secret at repository or organization level: those reach every system.

**Each server:**

1. Install Docker Engine with the Compose plugin.
2. Create a runner registration token (repository Settings → Actions → Runners).
3. Run `sudo REPO_URL=https://github.com/<organization>/<repository> ./bootstrap.sh`.

The runner's labels choose which environments the server runs (`staging,production` by
default; set `RUNNER_LABELS` to change). A second server is a second runner.

## Limits to know

- **Write access to this repository is root on its servers.** A branch can carry a workflow
  that runs on the runner before anyone reviews it. Review protects against mistakes and
  leaves the record; it does not stop a malicious administrator.
- **A GitHub environment that does not exist is created by the first deploy**, empty and
  without the branch restriction. Create it by hand first.
- **Systems of the same environment share one network** and can reach each other's ports.
- **Database changes are not undone** by returning to the previous release. A release that fails
  its health check after its migrations ran is replaced by the previous release, which then runs
  on the new schema; that is why destructive changes take two releases (ADR-0016).
- **A failed migration may be partly applied.** The previous release keeps running; fix the
  migration in the system and deploy a new release.
- **`validate` cannot tell that the two digests come from the same release.** It checks that the
  migration image is the application's `…/migrate`; pairing the digests is up to the pull request
  and its review, which copies both from one pipeline summary.
- **Reaching a system from outside** (the edge) is not in this repository yet.
- **`bootstrap.sh` has not run on a real server yet.** It passes `shellcheck`; the deploy
  commands, the migration step included, run end to end against a local Docker in every
  `validate` run (`scripts/deploy.e2e.ts`).

## Working on the platform itself

Node.js at the version in `.node-version`; no dependencies to install.

```sh
node --test "scripts/*.test.ts"       # the rules
node --test scripts/deploy.e2e.ts     # a deploy with a migration step (needs Docker Compose)
node scripts/platform.ts validate     # every system file (needs Docker Compose)
```

`deploy.e2e.ts` builds a throwaway system of two images, pushes them to a registry container on
`127.0.0.1` to pin them by digest, and deploys it with `platform.ts`. It proves that a failed
migration starts nothing, that the step runs before the application (which refuses to start
without it), that the step runs read-only, without capabilities, as a non-root user, with `/tmp`
writable, and that each container receives only its keys. It removes everything it created.
With Docker in a virtual machine (Colima, Docker Desktop), set `PLATFORM_TEST_DIR` to a folder
the machine mounts, for example `PLATFORM_TEST_DIR=$HOME/.cache`.
