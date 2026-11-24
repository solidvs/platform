// Pure rules of the platform: what a system file may contain, what the platform adds to it,
// how configuration is rendered and how a release is identified. No I/O here; see platform.ts.

import { createHmac } from "node:crypto";

export const ENVIRONMENTS = ["staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export interface Target {
  environment: Environment;
  system: string;
}

export interface Change extends Target {
  action: "deploy" | "remove";
}

type Json = Record<string, unknown>;

export interface ComposeModel {
  services?: Record<string, Json>;
  networks?: Record<string, Json | null>;
  secrets?: Json;
  configs?: Json;
}

/**
 * The reserved service that holds a system's migration step (ADR-0016): run once by the deploy,
 * before the release starts, and never started by `docker compose up`.
 */
export const MIGRATION_SERVICE = "migrate";
/** The Compose profile the platform gives the migration step, so `up` leaves it out. */
export const MIGRATION_PROFILE = "migrate";

const SYSTEM_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const TARGET_PATH = /^environments\/([^/]+)\/([^/]+)\.compose\.yaml$/;
const PINNED_IMAGE = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
// "$VAR" or "${VAR}" would be filled in from the runner's environment; "$$" is a literal dollar.
const INTERPOLATION = /(?<!\$)\$(?:\{|[A-Za-z_])/;

export function isEnvironment(value: string): value is Environment {
  return (ENVIRONMENTS as readonly string[]).includes(value);
}

export function isSystemName(value: string): boolean {
  return SYSTEM_NAME.test(value);
}

export function composePath(target: Target): string {
  return `environments/${target.environment}/${target.system}.compose.yaml`;
}

/** Maps a repository path to the system and environment it describes, or null if it is not one. */
export function parseTarget(path: string): Target | null {
  const match = TARGET_PATH.exec(path);
  if (!match) return null;
  const [, environment, system] = match;
  if (!isEnvironment(environment) || !isSystemName(system)) return null;
  return { environment, system };
}

export function projectName(target: Target): string {
  return `${target.environment}-${target.system}`;
}

export function edgeNetwork(environment: Environment): string {
  return `platform_${environment}`;
}

/** Turns `git diff --no-renames --name-status` output into the deploys and removals to run. */
export function parseChanges(nameStatus: string): Change[] {
  const changes: Change[] = [];
  for (const line of nameStatus.split("\n")) {
    const [status, path] = line.trim().split(/\s+/, 2);
    if (!status || !path) continue;
    const target = parseTarget(path);
    if (!target) continue;
    changes.push({ ...target, action: status === "D" ? "remove" : "deploy" });
  }
  return changes;
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `registry/name:tag@sha256:...` -> `registry/name`. */
export function imageRepository(image: string): string {
  const name = image.split("@")[0];
  const slash = name.lastIndexOf("/");
  const colon = name.lastIndexOf(":");
  return colon > slash ? name.slice(0, colon) : name;
}

function hasLimit(service: Json, direct: string, nested: string): boolean {
  if (service[direct] !== undefined && service[direct] !== null) return true;
  const deploy = service["deploy"];
  const resources = isRecord(deploy) ? deploy["resources"] : undefined;
  const limits = isRecord(resources) ? resources["limits"] : undefined;
  return isRecord(limits) && limits[nested] !== undefined && limits[nested] !== null;
}

/**
 * Checks a system file against the platform rules.
 * `source` is the file as written; `model` is `docker compose config --format json` of it.
 * Returns one message per violation; an empty list means the file is acceptable.
 */
export function checkCompose(source: string, model: ComposeModel): string[] {
  const problems: string[] = [];
  if (INTERPOLATION.test(source)) {
    problems.push("variable interpolation ($NAME, ${NAME}) is not allowed; values come from the configuration file");
  }
  if (model.secrets && Object.keys(model.secrets).length > 0) {
    problems.push("top-level `secrets` is reserved for the platform");
  }
  if (model.configs && Object.keys(model.configs).length > 0) {
    problems.push("top-level `configs` is not allowed");
  }
  for (const [name, network] of Object.entries(model.networks ?? {})) {
    if (isRecord(network) && network["external"]) {
      problems.push(`network \`${name}\`: external networks are attached by the platform only`);
    }
  }

  const services = Object.entries(model.services ?? {});
  if (services.length === 0) problems.push("no service defined");

  for (const [name, service] of services) {
    const at = (message: string) => problems.push(`service \`${name}\`: ${message}`);
    const forbidden: Array<[string, string]> = [
      ["build", "images are built by the system's pipeline, never on the server"],
      ["ports", "no published ports; systems are reached through the edge only"],
      ["container_name", "container names are set by the platform"],
      ["network_mode", "custom network modes are not allowed"],
      ["pid", "sharing the host process namespace is not allowed"],
      ["ipc", "custom IPC modes are not allowed"],
      ["userns_mode", "custom user namespace modes are not allowed"],
      ["cap_add", "added capabilities are not allowed"],
      ["devices", "host devices are not allowed"],
      ["security_opt", "security options are set by the platform"],
      ["env_file", "configuration is delivered by the platform at /run/secrets/config"],
      ["secrets", "the configuration secret is attached by the platform"],
      ["restart", "the restart policy is set by the platform"],
      ["logging", "logging is set by the platform"],
      ["profiles", "profiles are set by the platform"],
    ];
    for (const [key, reason] of forbidden) {
      const value = service[key];
      const empty = value === undefined || value === null || (Array.isArray(value) && value.length === 0);
      if (!empty) at(`\`${key}\`: ${reason}`);
    }
    if (service["privileged"] === true) at("`privileged` is not allowed");
    if (service["read_only"] === false) at("`read_only: false` is not allowed; use `tmpfs` for scratch space");

    const image = service["image"];
    if (typeof image !== "string" || !PINNED_IMAGE.test(image)) {
      at("`image` must be pinned by digest (`name@sha256:...`)");
    }
    const user = service["user"];
    if (user !== undefined && /^(0|root)(:|$)/.test(String(user))) at("must not run as root");

    const volumes = Array.isArray(service["volumes"]) ? service["volumes"] : [];
    for (const volume of volumes) {
      const type = isRecord(volume) ? volume["type"] : undefined;
      if (type !== "volume" && type !== "tmpfs") {
        at("only named volumes and tmpfs are allowed; host paths cannot be mounted");
      }
    }
    if (!hasLimit(service, "mem_limit", "memory")) at("a memory limit (`mem_limit`) is required");
    if (!hasLimit(service, "cpus", "cpus")) at("a CPU limit (`cpus`) is required");
  }
  problems.push(...checkMigration(model));
  return problems;
}

/**
 * The migration step is the service named `migrate`, and only it runs a migration image:
 * `<repository of the system's image>/migrate`, the second image the system's pipeline publishes
 * for each release. The migration login never reaches any other service, so a migration image
 * elsewhere could not run, and an application image in its place would receive the DDL login.
 */
function checkMigration(model: ComposeModel): string[] {
  const problems: string[] = [];
  const services = Object.entries(model.services ?? {});
  const repositoryOf = (service: Json) => {
    const image = service["image"];
    return typeof image === "string" ? imageRepository(image) : null;
  };
  const applications = new Set<string>();
  for (const [name, service] of services) {
    const repository = repositoryOf(service);
    if (name === MIGRATION_SERVICE || repository === null) continue;
    if (repository.endsWith("/migrate")) {
      problems.push(`service \`${name}\`: a migration image runs only as the \`${MIGRATION_SERVICE}\` service`);
    } else {
      applications.add(repository);
    }
  }
  const migration = model.services?.[MIGRATION_SERVICE];
  if (!migration) return problems;
  const at = (message: string) => problems.push(`service \`${MIGRATION_SERVICE}\`: ${message}`);
  const repository = repositoryOf(migration);
  if (applications.size === 0) {
    at("a migration step needs the system's application service next to it");
  } else if (repository !== null) {
    const matches = repository.endsWith("/migrate") && applications.has(repository.slice(0, -"/migrate".length));
    if (!matches) {
      at(`\`image\` must be the migration image of the system's release (\`${[...applications][0]}/migrate@sha256:...\`)`);
    }
  }
  return problems;
}

function images(model: ComposeModel): string[] {
  return Object.values(model.services ?? {})
    .map((service) => service["image"])
    .filter((image): image is string => typeof image === "string");
}

/** Production may only run images that are in the staging file of the same system. */
export function checkPromotion(production: ComposeModel, staging: ComposeModel | null): string[] {
  if (!staging) return ["no staging file for this system; a system reaches production through staging"];
  const tested = new Set(images(staging));
  const problems = images(production)
    .filter((image) => !tested.has(image))
    .map((image) => `image ${image} is not the one in staging; promote the digest that was tested`);
  // Staging applied the release's migrations before running it; production must do the same.
  if (staging.services?.[MIGRATION_SERVICE] && !production.services?.[MIGRATION_SERVICE]) {
    problems.push(`staging runs a \`${MIGRATION_SERVICE}\` step and production does not; promote it with the release`);
  }
  return problems;
}

/**
 * What the platform adds to every service of a system at deploy time. Written next to the
 * system file as a second Compose file, so these settings win over anything in the first.
 *
 * The migration step gets the same hardening, plus scratch space at /tmp, and differs in what
 * makes it a one-shot step: a profile that keeps it out of `up`, no restart, only the
 * environment's network (it talks to the database, never to the system's other services) and no
 * configuration here. Its configuration is attached for the one run only, by
 * `buildMigrationOverride`, so the migration login is never written to the release directory.
 */
export function buildOverride(model: ComposeModel, target: Target, release: string): Json {
  const services: Record<string, Json> = {};
  for (const name of Object.keys(model.services ?? {})) {
    const hardening = {
      read_only: true,
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges:true"],
      logging: { driver: "local" },
      labels: {
        "platform.system": target.system,
        "platform.environment": target.environment,
        "platform.release": release,
      },
    };
    services[name] = name === MIGRATION_SERVICE
      ? {
        ...hardening,
        profiles: [MIGRATION_PROFILE],
        restart: "no",
        tmpfs: ["/tmp"],
        networks: { edge: {} },
      }
      : {
        ...hardening,
        restart: "unless-stopped",
        secrets: ["config"],
        networks: {
          default: {},
          edge: { aliases: [`${target.system}-${name}`] },
        },
      };
  }
  return {
    services,
    secrets: { config: { file: "./config.json" } },
    networks: { edge: { external: true, name: edgeNetwork(target.environment) } },
  };
}

/**
 * Third Compose file of a migration run: attaches the migration step's own configuration file
 * (an absolute path, outside the release directory, deleted after the run) at the same place
 * the services read theirs, /run/secrets/config.
 */
export function buildMigrationOverride(configFile: string): Json {
  return {
    services: { [MIGRATION_SERVICE]: { secrets: [{ source: "migration_config", target: "config" }] } },
    secrets: { migration_config: { file: configFile } },
  };
}

/** A configuration file for one container, and the names of the keys it holds. */
export interface DeliveredConfig {
  /** File content delivered to the container at /run/secrets/config. */
  json: string;
  keys: string[];
}

export interface RenderedConfigs {
  /** What every service of the system receives. Never holds a `MIGRATION_*` key. */
  service: DeliveredConfig;
  /** What the migration step receives; null when the system has none. */
  migration: DeliveredConfig | null;
  /** Names defined in the GitHub environment, as variables and as secrets. */
  variables: string[];
  secrets: string[];
}

/** Secrets of the migration login, and the key each one becomes in the migration step. */
export const MIGRATION_LOGIN: Readonly<Record<string, string>> = {
  MIGRATION_DATABASE_USER: "DATABASE_USER",
  MIGRATION_DATABASE_PASSWORD: "DATABASE_PASSWORD",
};
const MIGRATION_PREFIX = "MIGRATION_";
const DATABASE_PREFIX = "DATABASE_";

function readContext(label: string, raw: string | undefined): Record<string, string> {
  if (!raw || raw.trim() === "" || raw.trim() === "null") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label}: not valid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${label}: expected a JSON object`);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.toLowerCase() === "github_token") continue;
    if (typeof value !== "string") throw new Error(`${label}: value of ${key} is not a string`);
    result[key] = value;
  }
  return result;
}

function toFile(values: Record<string, string>): DeliveredConfig {
  const keys = Object.keys(values).sort();
  const sorted = Object.fromEntries(keys.map((name) => [name, values[name]]));
  return { json: `${JSON.stringify(sorted, null, 2)}\n`, keys };
}

/**
 * Turns the variables and secrets of a GitHub environment (the `vars` and `secrets` contexts,
 * as JSON) into the configuration file of each container (ADR-0007, ADR-0016):
 *
 * - the services receive every name except `MIGRATION_*`;
 * - the migration step, when the system has one, receives the `DATABASE_*` keys only, with
 *   `DATABASE_USER` and `DATABASE_PASSWORD` taken from the migration login's secrets.
 *
 * Names are case-insensitive on GitHub, so a name present both as variable and as secret is
 * rejected instead of silently picking one. The migration login must be a secret, and no other
 * `MIGRATION_*` name exists, so a typo cannot leave a credential undelivered or misdelivered.
 */
export function renderConfigs(
  varsJson: string | undefined, secretsJson: string | undefined, withMigration: boolean,
): RenderedConfigs {
  const variables = readContext("variables", varsJson);
  const secrets = readContext("secrets", secretsJson);
  const seen = new Set(Object.keys(variables).map((name) => name.toUpperCase()));
  const clashes = Object.keys(secrets).filter((name) => seen.has(name.toUpperCase()));
  if (clashes.length > 0) {
    throw new Error(`defined both as variable and as secret: ${clashes.sort().join(", ")}`);
  }
  const isMigration = (name: string) => name.toUpperCase().startsWith(MIGRATION_PREFIX);
  const asVariables = Object.keys(variables).filter(isMigration);
  if (asVariables.length > 0) {
    throw new Error(`the migration login is a secret, not a variable: ${asVariables.sort().join(", ")}`);
  }
  const unknown = Object.keys(secrets).filter((name) => isMigration(name) && !(name in MIGRATION_LOGIN));
  if (unknown.length > 0) {
    throw new Error(`unknown ${MIGRATION_PREFIX}* names: ${unknown.sort().join(", ")}; `
      + `only ${Object.keys(MIGRATION_LOGIN).join(" and ")} exist`);
  }

  const merged = { ...variables, ...secrets };
  const service = Object.fromEntries(Object.entries(merged).filter(([name]) => !isMigration(name)));

  let migration: DeliveredConfig | null = null;
  if (withMigration) {
    const missing = Object.keys(MIGRATION_LOGIN).filter((name) => !(name in secrets));
    if (missing.length > 0) {
      throw new Error(`the system has a ${MIGRATION_SERVICE} step and the environment lacks the secrets `
        + `${missing.join(", ")}`);
    }
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(service)) {
      if (name.toUpperCase().startsWith(DATABASE_PREFIX)) values[name] = value;
    }
    for (const [secret, key] of Object.entries(MIGRATION_LOGIN)) values[key] = secrets[secret];
    migration = toFile(values);
  }

  return {
    service: toFile(service),
    migration,
    variables: Object.keys(variables).sort(),
    secrets: Object.keys(secrets).sort(),
  };
}

/**
 * Identifies a release by what it contains: the system file and the services' configuration.
 * The same content always gives the same identifier, so deploying again without a change does
 * nothing. Keyed with a value that never leaves the server, so the identifier reveals nothing
 * about the secrets it covers.
 */
export function releaseId(key: Buffer, compose: string, config: string): string {
  return createHmac("sha256", key).update(compose).update("\0").update(config).digest("hex").slice(0, 16);
}

export interface Summary extends Target {
  outcome: "deployed" | "unchanged" | "rolled back" | "migration failed" | "failed";
  /** The release this deploy tried to put in place. */
  release: string;
  /** The release that was in place before, if it was a different one. */
  previous: string | null;
  /** The release in place when the deploy ended; null if the system is down. */
  running: string | null;
  images: string[];
  /** What happened to the migration step; "none" when the system has none. */
  migration: "applied" | "failed" | "none";
  variables: string[];
  secrets: string[];
  /** Keys in the configuration file of the services. */
  serviceKeys: string[];
  /** Keys in the configuration file of the migration step; null when there is none. */
  migrationKeys: string[] | null;
}

/** The record of a deploy, for the workflow run page. Names only; never values. */
export function renderSummary(summary: Summary): string {
  const list = (items: string[]) => (items.length > 0 ? items.map((item) => `\`${item}\``).join(", ") : "none");
  const sources = Object.fromEntries(Object.entries(MIGRATION_LOGIN).map(([secret, key]) => [key, secret]));
  const migrationKeys = summary.migrationKeys === null
    ? "no migration step"
    : summary.migrationKeys
      .map((key) => (sources[key] ? `\`${key}\` (from \`${sources[key]}\`)` : `\`${key}\``))
      .join(", ") || "none";
  return [
    `### ${summary.system} · ${summary.environment} · ${summary.outcome}`,
    "",
    "| | |",
    "|---|---|",
    `| Release | \`${summary.release}\` |`,
    `| Previous release | ${summary.previous ? `\`${summary.previous}\`` : "none"} |`,
    `| Running now | ${summary.running ? `\`${summary.running}\`` : "nothing"} |`,
    `| Images | ${list(summary.images)} |`,
    `| Migration step | ${summary.migration} |`,
    `| Variables | ${list(summary.variables)} |`,
    `| Secrets (names only) | ${list(summary.secrets)} |`,
    `| Keys delivered to the services | ${list(summary.serviceKeys)} |`,
    `| Keys delivered to the migration step | ${migrationKeys} |`,
    "",
  ].join("\n");
}

export function modelImages(model: ComposeModel): string[] {
  return images(model);
}
