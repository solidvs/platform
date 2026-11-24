// End-to-end check of `deploy` against a real Docker (ADR-0016 migration step).
//
//   node --test scripts/deploy.e2e.ts
//
// Builds a throwaway system of two images (application and migration step) on a pinned base,
// pushes them to a registry container on 127.0.0.1 so they can be pinned by digest, and deploys
// it with platform.ts as the workflow would. Needs Docker with Compose; leaves nothing behind.
// The platform state goes under PLATFORM_TEST_DIR (default: the system's temporary directory);
// with Docker in a virtual machine (Colima, Docker Desktop), point it at a folder the VM mounts.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const PLATFORM = resolve(dirname(fileURLToPath(import.meta.url)), "platform.ts");
// busybox 1.37.0 and registry 3.0.0, pinned by digest.
const BASE = "busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec";
const REGISTRY = "registry@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e";
const ENVIRONMENT = "staging";
const NETWORK = `platform_${ENVIRONMENT}`;

const id = randomBytes(3).toString("hex");
const system = `e2e-${id}`;
const project = `${ENVIRONMENT}-${system}`;
const registryName = `platform-e2e-registry-${id}`;
const work = mkdtempSync(join(process.env["PLATFORM_TEST_DIR"] ?? tmpdir(), "platform-e2e-"));
const root = join(work, "root");
const repo = join(work, "repo");
const builtImages: string[] = [];
let createdNetwork = false;

// Synthetic values: the test checks where each one ends up.
const VARS = { DATABASE_HOST: "db.internal", DATABASE_NAME: `${system.replace(/-/g, "_")}_staging`, PORT: "3000" };
const SECRETS = {
  DATABASE_USER: "app_login",
  DATABASE_PASSWORD: "app-password-e2e",
  MIGRATION_DATABASE_USER: "migration_login",
  MIGRATION_DATABASE_PASSWORD: "migration-password-e2e",
};

function docker(args: string[], input?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("docker", args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function must(args: string[], input?: string): string {
  const result = docker(args, input);
  assert.equal(result.status, 0, `docker ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

/** Builds an image from a Dockerfile given as text, pushes it and returns it pinned by digest. */
function image(name: string, dockerfile: string, port: string): string {
  const tag = `127.0.0.1:${port}/e2e/${name}:test`;
  must(["build", "--quiet", "--tag", tag, "-"], dockerfile);
  must(["push", "--quiet", tag]);
  builtImages.push(tag);
  return must(["inspect", "--format", "{{index .RepoDigests 0}}", tag]);
}

function deploy(vars: Record<string, string>, secrets: Record<string, string>) {
  const summary = join(work, `summary-${randomBytes(3).toString("hex")}.md`);
  writeFileSync(summary, "");
  const result = spawnSync(process.execPath, [PLATFORM, "deploy", ENVIRONMENT, system], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PLATFORM_ROOT: root,
      PLATFORM_WAIT_SECONDS: "60",
      PLATFORM_VARS: JSON.stringify(vars),
      PLATFORM_SECRETS: JSON.stringify({ github_token: "ghs_e2e", ...secrets }),
      GITHUB_STEP_SUMMARY: summary,
    },
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}`, summary: readFileSync(summary, "utf8") };
}

/** A file the containers wrote in the system's named volume. */
function fromVolume(path: string): string {
  const result = docker(["run", "--rm", "--network", "none", "-v", `${project}_data:/data:ro`, BASE, "cat", `/data/${path}`]);
  return result.status === 0 ? result.stdout : "";
}

function containers(): string[] {
  return must(["ps", "--all", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}} {{.Label \"platform.release\"}} {{.State}}"])
    .split("\n").filter(Boolean);
}

/** Every file under the platform's state, with its content. */
function stateFiles(directory = root): Array<[string, string]> {
  const files: Array<[string, string]> = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...stateFiles(path));
    else files.push([path, readFileSync(path, "utf8")]);
  }
  return files;
}

const current = () => readFileSync(join(root, ENVIRONMENT, system, "current"), "utf8").trim();

before(() => {
  mkdirSync(join(repo, "environments", ENVIRONMENT), { recursive: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "release.key"), randomBytes(32));
  if (docker(["network", "inspect", NETWORK]).status !== 0) {
    must(["network", "create", NETWORK]);
    createdNetwork = true;
  }
  must(["run", "--detach", "--rm", "--name", registryName, "--publish", "127.0.0.1::5000", REGISTRY]);
  const port = must(["port", registryName, "5000/tcp"]).split("\n")[0].split(":").pop()!;

  // The migration step records what it received and how it ran; a database name of "fail"
  // makes it fail. The application refuses to start before the migration has run.
  const migrate = image(`${system}/migrate`, [
    `FROM ${BASE}`,
    "RUN mkdir /data && chown 1000:1000 /data",
    "USER 1000:1000",
    `CMD ["sh", "-c", "cp /run/secrets/config /data/migration-config.json; ` +
      `{ echo uid=$(id -u); grep CapEff /proc/self/status; touch /probe 2>/dev/null && echo root=rw || echo root=ro; ` +
      `touch /tmp/probe && echo tmp=rw; } > /data/migration-facts; ` +
      `grep -q '\\"DATABASE_NAME\\": \\"fail\\"' /run/secrets/config && exit 3; echo migrate >> /data/order"]`,
  ].join("\n"), port);
  const app = image(system, [
    `FROM ${BASE}`,
    "RUN mkdir /data && chown 1000:1000 /data",
    "USER 1000:1000",
    "HEALTHCHECK --interval=1s --timeout=2s --retries=30 CMD test -f /data/app-config.json",
    `CMD ["sh", "-c", "grep -q migrate /data/order || { echo 'not migrated'; exit 1; }; ` +
      `echo app >> /data/order; cp /run/secrets/config /data/app-config.json; exec sleep 3600"]`,
  ].join("\n"), port);

  writeFileSync(join(repo, "environments", ENVIRONMENT, `${system}.compose.yaml`), [
    "services:",
    "  app:",
    `    image: ${app}`,
    "    mem_limit: 64m",
    "    cpus: 0.25",
    "    tmpfs: [/tmp]",
    "    volumes: [data:/data]",
    "  migrate:",
    `    image: ${migrate}`,
    "    mem_limit: 64m",
    "    cpus: 0.25",
    "    volumes: [data:/data]",
    "volumes:",
    "  data: {}",
    "",
  ].join("\n"));
});

after(() => {
  docker(["compose", "-p", project, "down", "--volumes", "--remove-orphans"]);
  docker(["rm", "--force", `${project}-migrate`]);
  docker(["rm", "--force", registryName]);
  for (const tag of builtImages) docker(["rmi", "--force", tag]);
  if (createdNetwork) docker(["network", "rm", NETWORK]);
  rmSync(work, { recursive: true, force: true });
});

test("the system file with a migration step passes validate", () => {
  const result = spawnSync(process.execPath, [PLATFORM, "validate"], { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`${system}\\.compose\\.yaml: ok`));
});

test("a failed migration starts nothing", () => {
  const result = deploy({ ...VARS, DATABASE_NAME: "fail" }, SECRETS);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /migration failed; staging-e2e-[0-9a-f]+ was not started/);
  assert.match(result.summary, /· migration failed/);
  assert.match(result.summary, /Migration step \| failed/);
  assert.deepEqual(containers(), []);
  assert.deepEqual(readdirSync(join(root, ENVIRONMENT, system)).filter((entry) => entry !== "releases"), []);
  assert.deepEqual(readdirSync(join(root, ENVIRONMENT, system, "releases")), []);
});

test("the migration step runs first, hardened, with the migration login only", () => {
  docker(["volume", "rm", `${project}_data`]);
  const result = deploy(VARS, SECRETS);
  assert.equal(result.status, 0, result.output);
  assert.match(result.summary, /· deployed/);
  assert.match(result.summary, /Migration step \| applied/);

  assert.equal(fromVolume("order"), "migrate\napp\n");

  const migration = JSON.parse(fromVolume("migration-config.json"));
  assert.deepEqual(migration, {
    DATABASE_HOST: VARS.DATABASE_HOST,
    DATABASE_NAME: VARS.DATABASE_NAME,
    DATABASE_PASSWORD: SECRETS.MIGRATION_DATABASE_PASSWORD,
    DATABASE_USER: SECRETS.MIGRATION_DATABASE_USER,
  });
  const app = JSON.parse(fromVolume("app-config.json"));
  assert.deepEqual(Object.keys(app), ["DATABASE_HOST", "DATABASE_NAME", "DATABASE_PASSWORD", "DATABASE_USER", "PORT"]);
  assert.equal(app.DATABASE_USER, SECRETS.DATABASE_USER);

  const facts = fromVolume("migration-facts");
  assert.match(facts, /^uid=1000$/m);
  assert.match(facts, /^CapEff:\s+0+$/m);
  assert.match(facts, /^root=ro$/m);
  assert.match(facts, /^tmp=rw$/m);

  // The one-shot container is gone, and the migration login is nowhere in the platform's state.
  assert.deepEqual(containers().map((line) => line.split(" ")[0]), [`${project}-app-1`]);
  for (const [path, content] of stateFiles()) {
    assert.ok(!content.includes(SECRETS.MIGRATION_DATABASE_PASSWORD), `${path} holds the migration password`);
    assert.ok(!path.includes(".migration-"), `${path} was left behind`);
  }
  for (const value of Object.values(SECRETS)) assert.ok(!result.summary.includes(value), "summary holds a value");
  assert.match(result.summary, /`DATABASE_USER` \(from `MIGRATION_DATABASE_USER`\)/);
});

test("a failed migration of a new release leaves the running release in place", () => {
  const running = current();
  const result = deploy({ ...VARS, DATABASE_NAME: "fail", PORT: "3001" }, SECRETS);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, new RegExp(`stays on release ${running}`));
  assert.equal(current(), running);
  assert.deepEqual(containers(), [`${project}-app-1 ${running} running`]);
  assert.deepEqual(readdirSync(join(root, ENVIRONMENT, system, "releases")), [running]);
});
