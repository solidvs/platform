import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMigrationOverride, buildOverride, checkCompose, checkPromotion, imageRepository, parseChanges, parseTarget,
  releaseId, renderConfigs, renderSummary,
} from "./lib.ts";
import type { ComposeModel } from "./lib.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE = `ghcr.io/example/hello@${DIGEST}`;
const MIGRATE_IMAGE = `ghcr.io/example/hello/migrate@sha256:${"c".repeat(64)}`;

function model(service: Record<string, unknown> = {}): ComposeModel {
  return { services: { app: { image: IMAGE, mem_limit: "268435456", cpus: 0.5, ...service } } };
}

/** A system with its migration step; `step` changes the `migrate` service. */
function withMigration(step: Record<string, unknown> = {}): ComposeModel {
  return {
    services: {
      ...model().services,
      migrate: { image: MIGRATE_IMAGE, mem_limit: "268435456", cpus: 0.5, ...step },
    },
  };
}

test("parseTarget accepts only system files of a known environment", () => {
  assert.deepEqual(parseTarget("environments/staging/hello.compose.yaml"), { environment: "staging", system: "hello" });
  assert.equal(parseTarget("environments/dev/hello.compose.yaml"), null);
  assert.equal(parseTarget("environments/staging/Hello.compose.yaml"), null);
  assert.equal(parseTarget("environments/staging/../x.compose.yaml"), null);
  assert.equal(parseTarget("environments/staging/tunnel.yaml"), null);
  assert.equal(parseTarget("scripts/lib.ts"), null);
});

test("parseChanges maps added and modified files to deploys and deleted files to removals", () => {
  const diff = [
    "M\tenvironments/staging/hello.compose.yaml",
    "A\tenvironments/production/hello.compose.yaml",
    "D\tenvironments/staging/old-portal.compose.yaml",
    "M\tREADME.md",
    "M\tenvironments/staging/tunnel.yaml",
    "",
  ].join("\n");
  assert.deepEqual(parseChanges(diff), [
    { environment: "staging", system: "hello", action: "deploy" },
    { environment: "production", system: "hello", action: "deploy" },
    { environment: "staging", system: "old-portal", action: "remove" },
  ]);
});

test("checkCompose accepts a minimal hardened system", () => {
  assert.deepEqual(checkCompose("services: {}", model({ tmpfs: ["/tmp"], environment: { APP_SURFACE: "internal" } })), []);
  const nested = { services: { app: { image: IMAGE, deploy: { resources: { limits: { memory: "1", cpus: "0.5" } } } } } };
  assert.deepEqual(checkCompose("", nested), []);
});

test("checkCompose rejects what would weaken the server", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ image: "ghcr.io/example/hello:latest" }, /pinned by digest/],
    [{ image: undefined, build: { context: "." } }, /built by the system's pipeline/],
    [{ ports: [{ target: 3000, published: "3000" }] }, /no published ports/],
    [{ privileged: true }, /privileged/],
    [{ network_mode: "host" }, /network modes/],
    [{ cap_add: ["NET_ADMIN"] }, /capabilities/],
    [{ user: "root" }, /root/],
    [{ user: "0:0" }, /root/],
    [{ read_only: false }, /read_only/],
    [{ volumes: [{ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" }] }, /host paths/],
    [{ env_file: [{ path: ".env" }] }, /\/run\/secrets\/config/],
    [{ secrets: [{ source: "other" }] }, /attached by the platform/],
    [{ mem_limit: undefined }, /memory limit/],
    [{ cpus: undefined }, /CPU limit/],
    [{ profiles: ["debug"] }, /profiles are set by the platform/],
  ];
  for (const [service, expected] of cases) {
    const problems = checkCompose("", model(service));
    assert.ok(problems.some((problem) => expected.test(problem)), `${JSON.stringify(service)} -> ${problems.join("; ")}`);
  }
});

test("checkCompose accepts named volumes and a non-root user", () => {
  const service = { user: "10001:10001", volumes: [{ type: "volume", source: "data", target: "/data" }] };
  assert.deepEqual(checkCompose("", model(service)), []);
});

test("checkCompose rejects interpolation, reserved top-level keys and external networks", () => {
  assert.match(checkCompose("image: ${IMAGE}", model()).join(), /interpolation/);
  assert.match(checkCompose("command: echo $HOME", model()).join(), /interpolation/);
  assert.deepEqual(checkCompose("command: echo $$HOME costs 5$", model()), []);
  assert.match(checkCompose("", { ...model(), secrets: { config: { file: "x" } } }).join(), /reserved/);
  assert.match(checkCompose("", { ...model(), networks: { other: { external: true } } }).join(), /external networks/);
  assert.deepEqual(checkCompose("", { ...model(), networks: { default: { external: false } } }), []);
  assert.match(checkCompose("", {}).join(), /no service/);
});

test("checkCompose accepts a migration step with the system's migration image", () => {
  assert.deepEqual(checkCompose("", withMigration()), []);
  assert.equal(imageRepository(`registry:5000/org/hello:1.0@${DIGEST}`), "registry:5000/org/hello");
  assert.equal(imageRepository(MIGRATE_IMAGE), "ghcr.io/example/hello/migrate");
});

test("checkCompose holds the migration step to the same rules and to its own image", () => {
  const cases: Array<[ComposeModel, RegExp]> = [
    [withMigration({ image: "ghcr.io/example/hello/migrate:latest" }), /`migrate`: `image` must be pinned by digest/],
    [withMigration({ ports: [{ target: 5432, published: "5432" }] }), /`migrate`: `ports`: no published ports/],
    [withMigration({ mem_limit: undefined }), /`migrate`: a memory limit/],
    [withMigration({ privileged: true }), /`migrate`: `privileged`/],
    [withMigration({ profiles: ["manual"] }), /`migrate`: `profiles`/],
    // The application image in the migration slot would receive the DDL login.
    [withMigration({ image: IMAGE }), /must be the migration image of the system's release/],
    [withMigration({ image: `ghcr.io/example/other/migrate@${DIGEST}` }), /must be the migration image/],
    [{ services: { migrate: withMigration().services!.migrate } }, /needs the system's application service/],
    [{ services: { app: { ...model().services!.app, image: MIGRATE_IMAGE } } }, /`app`: a migration image runs only as the `migrate` service/],
  ];
  for (const [system, expected] of cases) {
    const problems = checkCompose("", system);
    assert.ok(problems.some((problem) => expected.test(problem)), `${expected} -> ${problems.join("; ")}`);
  }
});

test("checkPromotion requires production to run the digest that is in staging", () => {
  assert.deepEqual(checkPromotion(model(), model()), []);
  const other = model({ image: `ghcr.io/example/hello@sha256:${"b".repeat(64)}` });
  assert.match(checkPromotion(other, model()).join(), /not the one in staging/);
  assert.match(checkPromotion(model(), null).join(), /through staging/);
});

test("checkPromotion requires production to run the migration step that ran in staging", () => {
  assert.deepEqual(checkPromotion(withMigration(), withMigration()), []);
  assert.match(checkPromotion(model(), withMigration()).join(), /staging runs a `migrate` step and production does not/);
  const untested = withMigration({ image: `ghcr.io/example/hello/migrate@sha256:${"d".repeat(64)}` });
  assert.match(checkPromotion(untested, withMigration()).join(), /hello\/migrate@sha256:d+ is not the one in staging/);
  assert.match(checkPromotion(withMigration(), model()).join(), /migrate@sha256:c+ is not the one in staging/);
});

test("buildOverride hardens every service and attaches configuration and edge network", () => {
  const two: ComposeModel = { services: { public: { image: IMAGE }, internal: { image: IMAGE } } };
  const override = buildOverride(two, { environment: "production", system: "portal" }, "abc123") as any;
  assert.deepEqual(Object.keys(override.services), ["public", "internal"]);
  for (const name of ["public", "internal"]) {
    const service = override.services[name];
    assert.equal(service.read_only, true);
    assert.deepEqual(service.cap_drop, ["ALL"]);
    assert.deepEqual(service.security_opt, ["no-new-privileges:true"]);
    assert.equal(service.restart, "unless-stopped");
    assert.deepEqual(service.secrets, ["config"]);
    assert.equal(service.labels["platform.release"], "abc123");
    assert.deepEqual(service.networks.edge.aliases, [`portal-${name}`]);
  }
  assert.deepEqual(override.networks.edge, { external: true, name: "platform_production" });
  assert.deepEqual(override.secrets.config, { file: "./config.json" });
});

test("buildOverride makes the migration step a hardened one-shot step without configuration", () => {
  const override = buildOverride(withMigration(), { environment: "staging", system: "hello" }, "abc123") as any;
  const step = override.services.migrate;
  assert.equal(step.read_only, true);
  assert.deepEqual(step.cap_drop, ["ALL"]);
  assert.deepEqual(step.security_opt, ["no-new-privileges:true"]);
  assert.deepEqual(step.tmpfs, ["/tmp"]);
  assert.deepEqual(step.profiles, ["migrate"]);
  assert.equal(step.restart, "no");
  assert.deepEqual(step.networks, { edge: {} });
  assert.equal(step.labels["platform.release"], "abc123");
  // The services' configuration file, with the application login, is never mounted in it.
  assert.equal(step.secrets, undefined);
  assert.deepEqual(override.services.app.secrets, ["config"]);
  assert.equal(override.services.app.profiles, undefined);
});

test("buildMigrationOverride mounts the step's own file where the services read theirs", () => {
  assert.deepEqual(buildMigrationOverride("/srv/platform/staging/hello/.migration-x/config.json"), {
    services: { migrate: { secrets: [{ source: "migration_config", target: "config" }] } },
    secrets: { migration_config: { file: "/srv/platform/staging/hello/.migration-x/config.json" } },
  });
});

const VARS = JSON.stringify({ PORT: "3000", DATABASE_HOST: "db", DATABASE_NAME: "hello_staging" });
const SECRETS = JSON.stringify({
  github_token: "ghs_x",
  DATABASE_USER: "hello_staging_app",
  DATABASE_PASSWORD: "app\"pw\n",
  MIGRATION_DATABASE_USER: "hello_staging_migration",
  MIGRATION_DATABASE_PASSWORD: "ddl-pw",
  OIDC_CLIENT_SECRET: "oidc",
});

test("renderConfigs merges variables and secrets, sorted, without the workflow token", () => {
  const rendered = renderConfigs(
    JSON.stringify({ PORT: "3000", APP_NAME: "hello" }),
    JSON.stringify({ github_token: "ghs_x", DB_PASSWORD: "p\"w\nd" }),
    false,
  );
  assert.deepEqual(JSON.parse(rendered.service.json), { APP_NAME: "hello", DB_PASSWORD: "p\"w\nd", PORT: "3000" });
  assert.deepEqual(Object.keys(JSON.parse(rendered.service.json)), ["APP_NAME", "DB_PASSWORD", "PORT"]);
  assert.deepEqual(rendered.service.keys, ["APP_NAME", "DB_PASSWORD", "PORT"]);
  assert.deepEqual(rendered.variables, ["APP_NAME", "PORT"]);
  assert.deepEqual(rendered.secrets, ["DB_PASSWORD"]);
  assert.equal(rendered.migration, null);
});

test("renderConfigs keeps the migration login out of the services' file", () => {
  for (const withStep of [true, false]) {
    const { service } = renderConfigs(VARS, SECRETS, withStep);
    const values = JSON.parse(service.json);
    assert.deepEqual(service.keys, [
      "DATABASE_HOST", "DATABASE_NAME", "DATABASE_PASSWORD", "DATABASE_USER", "OIDC_CLIENT_SECRET", "PORT",
    ]);
    assert.ok(!Object.keys(values).some((key) => key.toUpperCase().startsWith("MIGRATION_")));
    assert.ok(!service.json.includes("ddl-pw") && !service.json.includes("hello_staging_migration"));
    assert.equal(values.DATABASE_USER, "hello_staging_app");
  }
});

test("renderConfigs gives the migration step the DATABASE_* keys only, with the migration login", () => {
  const { migration } = renderConfigs(VARS, SECRETS, true);
  assert.ok(migration);
  assert.deepEqual(JSON.parse(migration.json), {
    DATABASE_HOST: "db",
    DATABASE_NAME: "hello_staging",
    DATABASE_PASSWORD: "ddl-pw",
    DATABASE_USER: "hello_staging_migration",
  });
  assert.deepEqual(migration.keys, ["DATABASE_HOST", "DATABASE_NAME", "DATABASE_PASSWORD", "DATABASE_USER"]);
  assert.ok(!migration.json.includes("app\\\"pw") && !migration.json.includes("oidc"));
});

test("renderConfigs rejects a migration login that is missing, a variable or misspelled", () => {
  const secrets = JSON.parse(SECRETS);
  const without = (name: string) => JSON.stringify({ ...secrets, [name]: undefined });
  assert.throws(() => renderConfigs(VARS, without("MIGRATION_DATABASE_PASSWORD"), true), /lacks the secrets MIGRATION_DATABASE_PASSWORD/);
  // Without a migration step, a missing migration login is not needed.
  assert.doesNotThrow(() => renderConfigs(VARS, without("MIGRATION_DATABASE_PASSWORD"), false));
  assert.throws(
    () => renderConfigs(JSON.stringify({ MIGRATION_DATABASE_USER: "m" }), without("MIGRATION_DATABASE_USER"), true),
    /a secret, not a variable: MIGRATION_DATABASE_USER/,
  );
  assert.throws(
    () => renderConfigs(VARS, JSON.stringify({ ...secrets, MIGRATION_DATABASE_PASS: "x" }), true),
    /unknown MIGRATION_\* names: MIGRATION_DATABASE_PASS/,
  );
});

test("renderConfigs tolerates empty contexts and rejects bad input", () => {
  assert.equal(renderConfigs(undefined, "", false).service.json, "{}\n");
  assert.equal(renderConfigs("null", "{}", false).service.json, "{}\n");
  assert.throws(() => renderConfigs("{", "{}", false), /variables: not valid JSON/);
  assert.throws(() => renderConfigs("[]", "{}", false), /expected a JSON object/);
  assert.throws(() => renderConfigs(JSON.stringify({ A: 1 }), "{}", false), /not a string/);
  assert.throws(() => renderConfigs(JSON.stringify({ Db_Password: "x" }), JSON.stringify({ DB_PASSWORD: "y" }), false), /both as variable and as secret: DB_PASSWORD/);
});

test("releaseId is stable for the same content and changes with content or key", () => {
  const key = Buffer.from("k1");
  const id = releaseId(key, "compose", "config");
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(releaseId(key, "compose", "config"), id);
  assert.notEqual(releaseId(key, "compose", "config2"), id);
  assert.notEqual(releaseId(key, "compose2", "config"), id);
  assert.notEqual(releaseId(key, "composec", "onfig"), id);
  assert.notEqual(releaseId(Buffer.from("k2"), "compose", "config"), id);
});

test("renderSummary lists the names delivered to each container and never values", () => {
  const configs = renderConfigs(VARS, SECRETS, true);
  const text = renderSummary({
    environment: "staging", system: "hello", outcome: "deployed", release: "abc", previous: null, running: "abc",
    images: [IMAGE, MIGRATE_IMAGE], migration: "applied", variables: configs.variables, secrets: configs.secrets,
    serviceKeys: configs.service.keys, migrationKeys: configs.migration?.keys ?? null,
  });
  assert.match(text, /hello · staging · deployed/);
  assert.match(text, /Previous release \| none/);
  assert.match(text, /Running now \| `abc`/);
  assert.match(text, /Migration step \| applied/);
  assert.match(text, /Keys delivered to the services \| `DATABASE_HOST`, `DATABASE_NAME`, `DATABASE_PASSWORD`, `DATABASE_USER`, `OIDC_CLIENT_SECRET`, `PORT` \|/);
  assert.match(text, /Keys delivered to the migration step \| `DATABASE_HOST`, `DATABASE_NAME`, `DATABASE_PASSWORD` \(from `MIGRATION_DATABASE_PASSWORD`\), `DATABASE_USER` \(from `MIGRATION_DATABASE_USER`\) \|/);
  for (const value of ["ddl-pw", "hello_staging_migration", "hello_staging_app", "oidc", "3000"]) {
    assert.ok(!text.includes(value), `summary leaks ${value}`);
  }
  const none = renderSummary({
    environment: "staging", system: "hello", outcome: "deployed", release: "abc", previous: null, running: "abc",
    images: [IMAGE], migration: "none", variables: [], secrets: [], serviceKeys: [], migrationKeys: null,
  });
  assert.match(none, /migration step \| no migration step/);
});
