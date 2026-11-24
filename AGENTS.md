# Instructions for AI coding agents

This repository deploys production systems. Read `README.md` first.

- **Rules live in `scripts/lib.ts` and are pure functions.** Every rule has a test in
  `scripts/lib.test.ts`. Change a rule and its test together; run `node --test "scripts/*.test.ts"`.
- **Side effects live in `scripts/platform.ts`** (Docker, files, Git). Keep it that way. A change
  to `deploy` passes `node --test scripts/deploy.e2e.ts` (needs Docker) before it lands.
- **The migration login reaches the `migrate` step only** (ADR-0016). `MIGRATION_*` keys never go
  into the services' configuration, and the step's configuration file is never written to a
  release directory. Tests in both test files hold this; never relax them.
- **No dependencies.** Node.js built-ins only, TypeScript that Node runs directly (no enums,
  namespaces or parameter properties). Import local files with the `.ts` extension.
- **Never weaken a check to make a system file pass.** If a system needs something the rules
  forbid, that is a decision for a platform administrator, recorded as an ADR.
- **Never write a secret value** to a file in this repository, a log line or a job summary.
  Names of variables and secrets are fine; values are not.
- **Third-party actions are pinned by commit**, with the version in a comment.
- **A release directory on the server is written once.** Running containers mount its
  configuration file by path; changing or moving it breaks them on the next restart.
- Code, comments and documentation in English.
