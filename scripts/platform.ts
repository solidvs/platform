#!/usr/bin/env node
// Command line of the platform. Runs with Node's built-in TypeScript support; no dependencies.
//
//   node scripts/platform.ts validate
//   node scripts/platform.ts changes <before-commit> <after-commit>
//   node scripts/platform.ts target <environment> <system>
//   node scripts/platform.ts deploy <environment> <system>
//   node scripts/platform.ts remove <environment> <system>

import { spawnSync } from "node:child_process";
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ENVIRONMENTS, MIGRATION_SERVICE, buildMigrationOverride, buildOverride, checkCompose, checkPromotion,
  composePath, isEnvironment, isSystemName, modelImages, parseChanges, parseTarget, projectName, releaseId,
  renderConfigs, renderSummary,
} from "./lib.ts";
import type { Change, ComposeModel, Summary, Target } from "./lib.ts";

const ROOT = resolve(process.env["PLATFORM_ROOT"] ?? "/srv/platform");
const WAIT_SECONDS = process.env["PLATFORM_WAIT_SECONDS"] ?? "120";
const MIGRATION_SECONDS = Number(process.env["PLATFORM_MIGRATION_SECONDS"] ?? "600");
const EMPTY_COMMIT = /^0+$/;

// Docker never needs the configuration values; keep them out of every child process.
const childEnv = { ...process.env };
delete childEnv["PLATFORM_VARS"];
delete childEnv["PLATFORM_SECRETS"];

class Failure extends Error {}

function run(
  command: string, args: string[], capture: boolean, timeoutSeconds?: number,
): { ok: boolean; stdout: string; status: number | null; timedOut: boolean } {
  const result = spawnSync(command, args, {
    env: childEnv,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    maxBuffer: 64 * 1024 * 1024,
    ...(timeoutSeconds ? { timeout: timeoutSeconds * 1000 } : {}),
  });
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  if (result.error && !timedOut) throw new Failure(`cannot run ${command}: ${result.error.message}`);
  return { ok: result.status === 0, stdout: result.stdout ?? "", status: result.status, timedOut };
}

/** The Compose model of a project. Every profile is enabled, so no service escapes the checks. */
function composeModel(files: string[], projectDirectory?: string): ComposeModel {
  const args = ["compose", "--profile", "*", ...files.flatMap((file) => ["-f", file])];
  if (projectDirectory) args.push("--project-directory", projectDirectory);
  const result = run("docker", [...args, "config", "--format", "json"], true);
  if (!result.ok) throw new Failure(`not a valid Compose file: ${files.join(", ")}`);
  return JSON.parse(result.stdout) as ComposeModel;
}

function parseTargetArgs(args: string[]): Target {
  const [environment, system] = args;
  if (!environment || !isEnvironment(environment)) {
    throw new Failure(`environment must be one of: ${ENVIRONMENTS.join(", ")}`);
  }
  if (!system || !isSystemName(system)) throw new Failure("system name must be lowercase letters, digits and hyphens");
  return { environment, system };
}

function summarize(summary: Summary): void {
  const text = renderSummary(summary);
  console.log(text);
  const file = process.env["GITHUB_STEP_SUMMARY"];
  if (file) appendFileSync(file, text);
}

// ---------------------------------------------------------------------------------------------
// validate: every system file in the repository obeys the rules. Runs on pull requests.

function validate(): void {
  let failed = false;
  const report = (path: string, problems: string[]) => {
    for (const problem of problems) {
      failed = true;
      console.error(`${path}: ${problem}`);
    }
  };
  const scratch = mkdtempSync(join(tmpdir(), "platform-validate-"));
  try {
    for (const environment of ENVIRONMENTS) {
      const directory = join("environments", environment);
      if (!existsSync(directory)) continue;
      for (const entry of readdirSync(directory).sort()) {
        const path = `environments/${environment}/${entry}`;
        if (!entry.endsWith(".compose.yaml")) {
          if (entry !== "tunnel.yaml" && entry !== ".gitkeep") report(path, ["unexpected file"]);
          continue;
        }
        const target = parseTarget(path);
        if (!target) {
          report(path, ["file name must be <system>.compose.yaml, lowercase letters, digits and hyphens"]);
          continue;
        }
        let model: ComposeModel;
        try {
          model = composeModel([path]);
        } catch (error) {
          report(path, [(error as Error).message]);
          continue;
        }
        const problems = checkCompose(readFileSync(path, "utf8"), model);
        if (environment === "production") {
          const staging = composePath({ environment: "staging", system: target.system });
          problems.push(...checkPromotion(model, existsSync(staging) ? composeModel([staging]) : null));
        }
        if (problems.length === 0) {
          // The file must still be valid once the platform's additions are merged in.
          writeFileSync(join(scratch, "override.json"), JSON.stringify(buildOverride(model, target, "validate")));
          writeFileSync(join(scratch, "config.json"), "{}\n");
          const files = [path, join(scratch, "override.json")];
          if (model.services?.[MIGRATION_SERVICE]) {
            writeFileSync(join(scratch, "migration.json"), "{}\n");
            writeFileSync(join(scratch, "migration.override.json"),
              JSON.stringify(buildMigrationOverride(join(scratch, "migration.json"))));
            files.push(join(scratch, "migration.override.json"));
          }
          try {
            composeModel(files, scratch);
          } catch {
            problems.push("not valid once merged with the platform settings");
          }
        }
        report(path, problems);
        if (problems.length === 0) console.log(`${path}: ok`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (failed) throw new Failure("validation failed");
}

// ---------------------------------------------------------------------------------------------
// changes / target: which systems a workflow run must act on. Feeds the job matrices.

function emitPlan(plan: Change[]): void {
  const deploys = plan.filter((change) => change.action === "deploy");
  const removals = plan.filter((change) => change.action === "remove");
  const output = process.env["GITHUB_OUTPUT"];
  if (output) {
    appendFileSync(output, [
      `deploy=${JSON.stringify({ include: deploys })}`, `deploy_count=${deploys.length}`,
      `remove=${JSON.stringify({ include: removals })}`, `remove_count=${removals.length}`, "",
    ].join("\n"));
  }
  console.log(JSON.stringify({ deploy: deploys, remove: removals }, null, 2));
}

/** A push to the main branch: every system file it added, changed or deleted. */
function changes(args: string[]): void {
  const [before, after] = args;
  if (!before || !after) throw new Failure("usage: changes <before-commit> <after-commit>");
  // A first push has no previous commit: compare against the empty tree, so every file counts.
  const emptyTree = run("git", ["hash-object", "-t", "tree", "/dev/null"], true).stdout.trim();
  const from = EMPTY_COMMIT.test(before) ? emptyTree : before;
  const diff = run("git", ["diff", "--no-renames", "--name-status", from, after, "--", "environments"], true);
  if (!diff.ok) throw new Failure("git diff failed");
  emitPlan(parseChanges(diff.stdout));
}

/** A manual run: one system of one environment, deployed again as the repository describes it. */
function target(args: string[]): void {
  const chosen = parseTargetArgs(args);
  if (!existsSync(composePath(chosen))) throw new Failure(`${composePath(chosen)} does not exist`);
  emitPlan([{ ...chosen, action: "deploy" }]);
}

// ---------------------------------------------------------------------------------------------
// deploy: bring one system of one environment to the state described in the repository.

function readPointer(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8").trim() || null : null;
}

function writePointer(path: string, value: string): void {
  writeFileSync(`${path}.tmp`, `${value}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

function releaseFiles(releaseDir: string): string[] {
  return ["-f", join(releaseDir, "compose.yaml"), "-f", join(releaseDir, "override.json")];
}

function composeUp(target: Target, releaseDir: string): boolean {
  return run("docker", [
    "compose", "-p", projectName(target), "--project-directory", releaseDir, ...releaseFiles(releaseDir),
    "up", "--detach", "--wait", "--wait-timeout", WAIT_SECONDS, "--remove-orphans",
  ], false).ok;
}

function removeContainer(name: string): void {
  const found = run("docker", ["ps", "--all", "--quiet", "--filter", `name=^${name}$`], true).stdout.trim();
  if (found) run("docker", ["rm", "--force", name], true);
}

/**
 * Runs the migration step of a release once (ADR-0016), with the hardening of the release's
 * override and its own configuration file. That file holds the migration login, so it lives in
 * a private directory outside the release, only for the length of the run.
 */
function migrate(target: Target, stateDir: string, releaseDir: string, configJson: string): boolean {
  const container = `${projectName(target)}-${MIGRATION_SERVICE}`;
  const scratch = mkdtempSync(join(stateDir, ".migration-"));
  try {
    const configFile = join(scratch, "config.json");
    // Readable by the step's own user, whatever its id; the directory is the platform user's only.
    writeFileSync(configFile, configJson, { mode: 0o444 });
    chmodSync(configFile, 0o444);
    writeFileSync(join(scratch, "override.json"), JSON.stringify(buildMigrationOverride(configFile)), { mode: 0o600 });
    removeContainer(container); // left by an interrupted run, it would hold the name
    console.log(`Running the migration step of ${projectName(target)}.`);
    const result = run("docker", [
      "compose", "-p", projectName(target), "--project-directory", releaseDir, ...releaseFiles(releaseDir),
      "-f", join(scratch, "override.json"),
      "run", "--rm", "--no-deps", "-T", "--name", container, MIGRATION_SERVICE,
    ], false, MIGRATION_SECONDS);
    if (result.timedOut) {
      console.error(`The migration step did not finish in ${MIGRATION_SECONDS} s; stopping it.`);
      removeContainer(container);
      return false;
    }
    if (!result.ok) console.error(`The migration step ended with code ${result.status}.`);
    return result.ok;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function deploy(args: string[]): void {
  const target = parseTargetArgs(args);
  const source = composePath(target);
  if (!existsSync(source)) throw new Failure(`${source} does not exist`);

  const compose = readFileSync(source, "utf8");
  const model = composeModel([source]);
  const problems = checkCompose(compose, model);
  if (problems.length > 0) throw new Failure(`${source} breaks the platform rules:\n  ${problems.join("\n  ")}`);

  const keyFile = join(ROOT, "release.key");
  if (!existsSync(keyFile)) throw new Failure(`${keyFile} is missing; run bootstrap.sh on this server`);
  const hasMigration = model.services?.[MIGRATION_SERVICE] !== undefined;
  const config = renderConfigs(process.env["PLATFORM_VARS"], process.env["PLATFORM_SECRETS"], hasMigration);
  const release = releaseId(readFileSync(keyFile), compose, config.service.json);

  const stateDir = join(ROOT, target.environment, target.system);
  const releaseDir = join(stateDir, "releases", release);
  const current = readPointer(join(stateDir, "current"));
  const summary: Summary = {
    ...target, outcome: "deployed", release, running: release,
    previous: current && current !== release ? current : null,
    images: modelImages(model), migration: "none", variables: config.variables, secrets: config.secrets,
    serviceKeys: config.service.keys, migrationKeys: config.migration?.keys ?? null,
  };

  // A release directory is written once and never changed: running containers mount its
  // configuration file by path, and must find the same file again after a server restart.
  const created = !existsSync(join(releaseDir, "override.json"));
  if (created) {
    mkdirSync(releaseDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(releaseDir, "compose.yaml"), compose, { mode: 0o600 });
    // Readable by the container's own user, whatever its id; the directories above are
    // closed to everyone but the platform user.
    writeFileSync(join(releaseDir, "config.json"), config.service.json, { mode: 0o444 });
    chmodSync(join(releaseDir, "config.json"), 0o444);
    writeFileSync(join(releaseDir, "override.json"), JSON.stringify(buildOverride(model, target, release), null, 2), { mode: 0o600 });
  }

  // A migration run interrupted by a cancelled job leaves its configuration behind; delete it.
  for (const entry of readdirSync(stateDir)) {
    if (entry.startsWith(".migration-")) rmSync(join(stateDir, entry), { recursive: true, force: true });
  }

  // Migrations come first, and the release starts only if they succeed. On failure nothing is
  // restarted: the running release, if any, keeps running. Migrations are idempotent, so
  // deploying the same release again runs the step again and it finds nothing to apply.
  if (config.migration) {
    if (!migrate(target, stateDir, releaseDir, config.migration.json)) {
      if (created) rmSync(releaseDir, { recursive: true, force: true });
      summarize({ ...summary, outcome: "migration failed", migration: "failed", running: current });
      throw new Failure(current
        ? `migration failed; ${projectName(target)} stays on release ${current}`
        : `migration failed; ${projectName(target)} was not started`);
    }
    summary.migration = "applied";
  }

  if (composeUp(target, releaseDir)) {
    if (current === release) {
      summary.outcome = "unchanged";
    } else {
      if (current) writePointer(join(stateDir, "previous"), current);
      writePointer(join(stateDir, "current"), release);
    }
    // Older releases hold old configuration values; keep only what a rollback needs.
    const keep = new Set([release, readPointer(join(stateDir, "previous"))]);
    for (const entry of readdirSync(join(stateDir, "releases"))) {
      if (!keep.has(entry)) rmSync(join(stateDir, "releases", entry), { recursive: true, force: true });
    }
    summarize(summary);
    return;
  }

  console.error(`\nRelease ${release} did not become healthy. State and last log lines:`);
  const project = ["compose", "-p", projectName(target)];
  run("docker", [...project, "ps", "--all"], false);
  run("docker", [...project, "logs", "--tail", "40"], false);

  if (current && current !== release && existsSync(join(stateDir, "releases", current))) {
    console.error(`\nReturning to release ${current}.`);
    const restored = composeUp(target, join(stateDir, "releases", current));
    if (restored && created) rmSync(releaseDir, { recursive: true, force: true });
    summarize({ ...summary, outcome: restored ? "rolled back" : "failed", running: restored ? current : null });
    throw new Failure(restored
      ? `deploy failed; ${projectName(target)} is back on release ${current}`
      : `deploy failed and the return to release ${current} failed too; ${projectName(target)} needs attention`);
  }
  if (!current) {
    run("docker", [...project, "down", "--remove-orphans"], false);
    rmSync(releaseDir, { recursive: true, force: true });
  }
  summarize({ ...summary, outcome: "failed", running: null });
  throw new Failure(`deploy failed; ${projectName(target)} has no earlier release to return to`);
}

// ---------------------------------------------------------------------------------------------
// remove: the system file was deleted from the repository. Stops the system and deletes its
// configuration from the server. Named volumes are kept: data is removed by hand, on purpose.

function remove(args: string[]): void {
  const target = parseTargetArgs(args);
  if (existsSync(composePath(target))) throw new Failure(`${composePath(target)} still exists; delete it first`);
  const stopped = run("docker", ["compose", "-p", projectName(target), "down", "--remove-orphans"], false).ok;
  if (!stopped) throw new Failure(`could not stop ${projectName(target)}`);
  rmSync(join(ROOT, target.environment, target.system), { recursive: true, force: true });
  console.log(`${projectName(target)} removed. Named volumes, if any, were kept.`);
}

// ---------------------------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "validate") validate();
  else if (command === "changes") changes(rest);
  else if (command === "target") target(rest);
  else if (command === "deploy") deploy(rest);
  else if (command === "remove") remove(rest);
  else throw new Failure("usage: platform.ts <validate | changes | target | deploy | remove> [arguments]");
} catch (error) {
  if (!(error instanceof Failure) && !(error instanceof Error)) throw error;
  console.error(`error: ${error.message}`);
  process.exit(1);
}
