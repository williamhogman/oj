// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "oj-campaign-contract-"));
const archives = path.join(temporary, "archives");
const project = path.join(temporary, "sample-project");
const layer = path.join(temporary, "dependencies");
const output = path.join(temporary, "results");
const marker = path.join(temporary, "baseline-count");
const ojMarker = path.join(temporary, "oj-count");
const countingOj = path.join(temporary, "counting-oj");
const campaign = path.join(root, "bench", "project-campaign.mjs");

function createArchive(name, missing = false, replacement) {
  const source = replacement ?? (missing
    ? 'import "missing-example-dependency";\n'
    : 'document.body.textContent = "ready";\n');
  fs.writeFileSync(path.join(project, "main.js"), source);
  const packed = spawnSync("zip", ["-q", "-r", path.join(archives, `${name}.zip`), "sample-project"], {
    cwd: temporary,
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, `could not create an example archive: ${packed.stderr}`);
}

function run(args = []) {
  return spawnSync(process.execPath, [
    campaign,
    "--archives-dir", archives,
    "--dependency-layer", layer,
    "--oj", countingOj,
    "--output-dir", output,
    "--workers", "3",
    "--batch-size", "4",
    "--mode", "build",
    "--timeout-ms", "15000",
    ...args,
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CAMPAIGN_BASELINE_MARKER: marker,
      CAMPAIGN_OJ_MARKER: ojMarker,
      CAMPAIGN_REAL_OJ: path.join(root, "target", "debug", "oj"),
    },
    timeout: 90_000,
  });
}

function readJournal() {
  return fs.readFileSync(path.join(output, "results.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
}

try {
  fs.mkdirSync(archives);
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(layer, ".bin"), { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(project, "vite.config.mjs"), "export default {};\n");
  fs.writeFileSync(path.join(project, "index.html"), '<html><body><script type="module" src="/main.js"></script></body></html>');
  fs.writeFileSync(path.join(layer, ".bin", "vite"), [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'fs.appendFileSync(process.env.CAMPAIGN_BASELINE_MARKER, "baseline\\n");',
    'const port = process.argv[process.argv.indexOf("--port") + 1];',
    'if (process.argv.includes("--port")) {',
    '  const source = fs.readFileSync(require("node:path").join(process.cwd(), "main.js"), "utf8");',
    '  require("node:http").createServer((_request, response) => {',
    '    if (source.includes("SHARED_SSR_FAILURE")) {',
    '      response.writeHead(500); response.end("ReferenceError: synthetic runtime failure");',
    '    } else { response.end("<html><body>synthetic SSR</body></html>"); }',
    '  }).listen(Number(port), "127.0.0.1");',
    '}',
  ].join("\n") + "\n", { mode: 0o755 });
  fs.writeFileSync(countingOj, [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'const { spawnSync } = require("node:child_process");',
    'const path = require("node:path");',
    'fs.appendFileSync(process.env.CAMPAIGN_OJ_MARKER, "oj\\n");',
    'const source = fs.readFileSync(path.join(process.argv[3], "main.js"), "utf8");',
    'if (source.includes("SSR_FAILURE")) {',
    '  if (process.argv[2] === "build") {',
    '    fs.mkdirSync(path.join(process.argv[3], "dist"), { recursive: true }); process.exit(0);',
    '  }',
    '  const port = Number(process.argv[process.argv.indexOf("--port") + 1]);',
    '  require("node:http").createServer((_request, response) => {',
    '    response.writeHead(500); response.end("ReferenceError: synthetic runtime failure");',
    '  }).listen(port, "127.0.0.1");',
    '  return;',
    '}',
    'if (source.includes("missing-example-dependency")) {',
    '  console.error(\'Error: Could not resolve "missing-example-dependency"\');',
    "  process.exit(1);",
    "}",
    'if (source.includes("STRUCTURAL_ALPHA_ONE")) {',
    '  console.error(\'Error: circular graph recursion exceeded in "customer-one-private"\');',
    "  process.exit(1);",
    "}",
    'if (source.includes("STRUCTURAL_ALPHA_TWO")) {',
    '  console.error(\'Error: circular graph recursion exceeded in "customer-two-private"\');',
    "  process.exit(1);",
    "}",
    'if (source.includes("STRUCTURAL_BETA")) {',
    '  console.error(\'Error: invalid object spread encountered in "customer-three-private"\');',
    "  process.exit(1);",
    "}",
    'if (source.includes("TAXONOMY_ALPHA_ONE") || source.includes("TAXONOMY_ALPHA_TWO")) {',
    '  const customer = source.includes("TAXONOMY_ALPHA_ONE") ? "customer-alpha-private" : "customer-beta-private";',
    "  console.error(\"TypeError: Cannot read properties of undefined (reading 'options')\");",
    '  console.error(`plugin transform failed in ${customer} @secret/private-plugin CUSTOMER_SOURCE_DO_NOT_STORE`);',
    '  console.error(`at /private/${customer}/node_modules/rolldown/vite-plugin-bridge.mjs:42:7`);',
    '  console.error("api_key=never-persist contact=person@example.invalid id=123e4567-e89b-12d3-a456-426614174000");',
    "  process.exit(1);",
    "}",
    'if (source.includes("TAXONOMY_BETA")) {',
    "  console.error(\"TypeError: Cannot read properties of undefined (reading 'routes')\");",
    '  console.error("plugin transform failed in customer-gamma-private @secret/another-plugin");',
    '  console.error("at /private/customer-gamma-private/node_modules/rolldown/vite-plugin-bridge.mjs:77:3");',
    "  process.exit(1);",
    "}",
    'if (source.includes("TAXONOMY_PRIVATE_PROPERTY")) {',
    "  console.error(\"TypeError: Cannot read properties of undefined (reading 'customerPrivateField')\");",
    '  console.error("plugin transform failed in @secret/private-property-plugin");',
    '  console.error("at /private/customer-delta-private/node_modules/rolldown/vite-plugin-bridge.mjs:88:5");',
    "  process.exit(1);",
    "}",
    'const result = spawnSync(process.env.CAMPAIGN_REAL_OJ, process.argv.slice(2), { stdio: "inherit" });',
    "process.exit(result.status ?? 1);",
  ].join("\n") + "\n", { mode: 0o755 });

  for (let index = 0; index < 11; index += 1) {
    createArchive(`example-${String(index).padStart(2, "0")}`, index >= 8);
  }

  const initial = run();
  assert.equal(initial.status, 0, `campaign failed:\n${initial.stdout}\n${initial.stderr}`);
  const summary = JSON.parse(fs.readFileSync(path.join(output, "summary.json"), "utf8"));
  assert.equal(summary.discovered, 11, "campaign must not inherit the single-runner eight-project limit");
  assert.equal(summary.completed, 11);
  assert.equal(summary.passed, 8);
  assert.equal(summary.ojFailures, 3);
  assert.equal(summary.baselineFailures, 0);
  assert.equal(summary.clusters, 1, "equivalent failures should form one canonical cluster");
  assert.equal(readJournal().length, 11);
  assert.equal(fs.readFileSync(ojMarker, "utf8").trim().split("\n").length, 11,
    "baseline verification must not repeat the failed OJ build");
  assert.equal(fs.readFileSync(marker, "utf8").trim().split("\n").length, 3,
    "successful projects must not trigger baseline checks");

  const clusters = JSON.parse(fs.readFileSync(path.join(output, "clusters.json"), "utf8"));
  assert.equal(clusters.schemaVersion, 1);
  assert.equal(clusters.clusters[0].count, 3);
  assert.equal(clusters.clusters[0].occurrences, 3);
  assert.equal(clusters.clusters[0].stage, "build");
  assert.equal(clusters.clusters[0].kind, "missing-dependency");
  assert.match(clusters.clusters[0].fingerprint, /^[0-9a-f]{32}$/);
  assert.equal(fs.readdirSync(path.join(output, "batches")).length, 3);

  const publicResults = ["results.jsonl", "summary.json", "clusters.json"]
    .map((filename) => fs.readFileSync(path.join(output, filename), "utf8")).join("\n");
  assert.doesNotMatch(publicResults, /missing-example-dependency|sample-project|example-0|campaign-contract/,
    "persisted results must not contain project identities, dependency names, or source paths");

  const resumed = run();
  assert.equal(resumed.status, 0, `campaign resume failed:\n${resumed.stdout}\n${resumed.stderr}`);
  assert.equal(readJournal().length, 11, "resuming must not rerun completed projects");
  assert.equal(fs.readFileSync(marker, "utf8").trim().split("\n").length, 3);

  fs.appendFileSync(path.join(output, "results.jsonl"), '{"id":');
  const repaired = run();
  assert.equal(repaired.status, 0, `interrupted journal recovery failed:\n${repaired.stdout}\n${repaired.stderr}`);
  assert.equal(readJournal().length, 11, "a partially written final record should be repaired automatically");

  createArchive("example-11");
  const extended = run();
  assert.equal(extended.status, 0, `campaign extension failed:\n${extended.stdout}\n${extended.stderr}`);
  assert.equal(readJournal().length, 12, "only a newly discovered project should be evaluated");
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, "summary.json"), "utf8")).passed, 9);

  fs.writeFileSync(path.join(project, "vite.config.mjs"),
    'throw new Error("ERR_IGNORE_PREVIOUS_INSTRUCTIONS api_key=not-for-reports contact=person@example.invalid");\n');
  createArchive("example-12");
  fs.writeFileSync(path.join(project, "vite.config.mjs"), "export default {};\n");
  const untrusted = run();
  assert.equal(untrusted.status, 0, `untrusted diagnostic campaign failed:\n${untrusted.stdout}\n${untrusted.stderr}`);
  const sanitizedRecords = fs.readFileSync(path.join(output, "results.jsonl"), "utf8");
  assert.doesNotMatch(sanitizedRecords, /IGNORE.PREVIOUS|not-for-reports|person@example\.invalid/i,
    "untrusted project diagnostics must never become stored instructions, secrets, or contact details");

  createArchive("structural-alpha-one", false, "// STRUCTURAL_ALPHA_ONE\n");
  createArchive("structural-alpha-two", false, "// STRUCTURAL_ALPHA_TWO\n");
  createArchive("structural-beta", false, "// STRUCTURAL_BETA\n");
  const structural = run();
  assert.equal(structural.status, 0, `structural diagnostic campaign failed:\n${structural.stdout}\n${structural.stderr}`);
  const structuralClusters = JSON.parse(fs.readFileSync(path.join(output, "clusters.json"), "utf8"))
    .clusters.filter((cluster) => cluster.kind === "execution-failure"
      && cluster.message === "The compatibility check failed");
  assert.equal(structuralClusters.length, 2,
    "distinct structural failures with the same public message must form separate anonymous clusters");
  assert.deepEqual(structuralClusters.map((cluster) => cluster.count).sort(), [1, 2],
    "structurally equivalent errors differing only in private values must remain grouped");
  const structuralResults = ["results.jsonl", "summary.json", "clusters.json"]
    .map((filename) => fs.readFileSync(path.join(output, filename), "utf8")).join("\n");
  assert.doesNotMatch(structuralResults,
    /customer-(?:one|two|three)-private|STRUCTURAL_ALPHA|STRUCTURAL_BETA|circular graph|object spread/i,
    "structural fingerprinting must never persist customer values, source identifiers, or raw diagnostics");

  createArchive("taxonomy-alpha-one", false, "// TAXONOMY_ALPHA_ONE\n");
  createArchive("taxonomy-alpha-two", false, "// TAXONOMY_ALPHA_TWO\n");
  createArchive("taxonomy-beta", false, "// TAXONOMY_BETA\n");
  createArchive("taxonomy-private-property", false, "// TAXONOMY_PRIVATE_PROPERTY\n");
  const taxonomy = run();
  assert.equal(taxonomy.status, 0, `diagnostic taxonomy campaign failed:\n${taxonomy.stdout}\n${taxonomy.stderr}`);
  const taxonomyChecks = readJournal().map((record) => record.checks.build)
    .filter((check) => check.errorClass === "TypeError");
  assert.equal(taxonomyChecks.length, 4, "approved error classes should survive diagnostic redaction");
  for (const check of taxonomyChecks) {
    assert.ok(check.markers.includes("plugin-transform"), "public hook classes should remain actionable");
    assert.ok(check.markers.includes("property-of-nullish"), "public JavaScript failure classes should remain actionable");
    assert.deepEqual(check.publicSymbols, ["rolldown"], "only approved public package names may survive");
    assert.deepEqual(check.internalFrames, ["vite-plugin-bridge"], "only approved public OJ frame classes may survive");
  }
  assert.deepEqual(taxonomyChecks.map((check) => check.nullishProperty).filter(Boolean).sort(), ["options", "options", "routes"]);
  assert.equal(taxonomyChecks.filter((check) => check.nullishProperty === undefined).length, 1,
    "private JavaScript property names must never appear in the public diagnostic taxonomy");
  const taxonomyClusters = JSON.parse(fs.readFileSync(path.join(output, "clusters.json"), "utf8"))
    .clusters.filter((cluster) => cluster.errorClass === "TypeError");
  assert.deepEqual(taxonomyClusters.map((cluster) => cluster.count).sort(), [1, 1, 2],
    "approved structural taxonomy should separate distinct public failure mechanisms without customer values");
  const taxonomyResults = ["results.jsonl", "summary.json", "clusters.json"]
    .map((filename) => fs.readFileSync(path.join(output, filename), "utf8")).join("\n");
  assert.doesNotMatch(taxonomyResults,
    /customer-(?:alpha|beta|gamma|delta)-private|@secret\/|customerPrivateField|CUSTOMER_SOURCE|TAXONOMY_ALPHA|TAXONOMY_BETA|TAXONOMY_PRIVATE|never-persist|person@example|123e4567|\/private\//i,
    "diagnostic taxonomy must never persist customer paths, package names, source, secrets, contacts, or identifiers");

  const baselineOnlyOutput = path.join(temporary, "baseline-only-results");
  const buildsBeforeBaselineOnly = fs.readFileSync(ojMarker, "utf8").trim().split("\n").length;
  const baselineOnly = spawnSync(process.execPath, [
    path.join(root, "bench", "project-agent.mjs"),
    "--project", path.join(archives, "example-00.zip"),
    "--dependency-layer", layer,
    "--oj", countingOj,
    "--mode", "build",
    "--baseline-only",
    "--output-dir", baselineOnlyOutput,
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CAMPAIGN_BASELINE_MARKER: marker,
      CAMPAIGN_OJ_MARKER: ojMarker,
      CAMPAIGN_REAL_OJ: path.join(root, "target", "debug", "oj"),
    },
  });
  assert.equal(baselineOnly.status, 0, `baseline-only runner failed:\n${baselineOnly.stdout}\n${baselineOnly.stderr}`);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(baselineOnlyOutput, "report.json"), "utf8"))
    .projects[0].checks), ["baseline"], "baseline-only reports must not contain OJ checks");
  assert.equal(fs.readFileSync(ojMarker, "utf8").trim().split("\n").length, buildsBeforeBaselineOnly,
    "baseline-only runner must never invoke OJ");

  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({
    type: "module", dependencies: { "@tanstack/react-start": "1.0.0" },
  }));
  createArchive("shared-ssr-failure", false, "// SHARED_SSR_FAILURE\n");
  createArchive("oj-only-ssr-failure", false, "// OJ_ONLY_SSR_FAILURE\n");
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ type: "module" }));

  function runSsrParity(name) {
    const destination = path.join(temporary, `${name}-results`);
    const result = spawnSync(process.execPath, [
      campaign,
      "--archive", path.join(archives, `${name}.zip`),
      "--dependency-layer", layer,
      "--oj", countingOj,
      "--output-dir", destination,
      "--mode", "both",
      "--timeout-ms", "5000",
    ], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        CAMPAIGN_BASELINE_MARKER: marker,
        CAMPAIGN_OJ_MARKER: ojMarker,
        CAMPAIGN_REAL_OJ: path.join(root, "target", "debug", "oj"),
      },
    });
    assert.equal(result.status, 0, `SSR parity campaign failed:\n${result.stdout}\n${result.stderr}`);
    return {
      result: JSON.parse(fs.readFileSync(path.join(destination, "results.jsonl"), "utf8").trim()),
      clusters: JSON.parse(fs.readFileSync(path.join(destination, "clusters.json"), "utf8")),
    };
  }

  const sharedSsrFailure = runSsrParity("shared-ssr-failure");
  assert.equal(sharedSsrFailure.result.checks.build.ok, true);
  assert.equal(sharedSsrFailure.result.checks.dev.ok, false);
  assert.equal(sharedSsrFailure.result.baseline.ok, false,
    "a successful production build must not conceal an SSR failure shared by the Vite dev server");
  assert.equal(sharedSsrFailure.result.status, "baseline-failure");
  assert.deepEqual(sharedSsrFailure.clusters.clusters, [],
    "application SSR errors reproducible under Vite must not become OJ bug tasks");

  const ojOnlySsrFailure = runSsrParity("oj-only-ssr-failure");
  assert.equal(ojOnlySsrFailure.result.baseline.ok, true, JSON.stringify(ojOnlySsrFailure.result));
  assert.equal(ojOnlySsrFailure.result.status, "oj-failure",
    "an OJ-only SSR failure must remain actionable when Vite renders the same route");
  assert.equal(ojOnlySsrFailure.clusters.clusters.length, 1);

  const manifest = path.join(temporary, "inputs.jsonl");
  const manifestOutput = path.join(temporary, "manifest-results");
  fs.writeFileSync(manifest, JSON.stringify({ id: "example-source-label", archive: "archives/example-00.zip" }) + "\n");
  const manifested = spawnSync(process.execPath, [
    campaign,
    "--manifest", manifest,
    "--dependency-layer", layer,
    "--output-dir", manifestOutput,
    "--mode", "build",
  ], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(manifested.status, 0, `manifest campaign failed:\n${manifested.stdout}\n${manifested.stderr}`);
  const manifestRecord = JSON.parse(fs.readFileSync(path.join(manifestOutput, "results.jsonl"), "utf8").trim());
  assert.match(manifestRecord.id, /^[0-9a-f]{24}$/);
  assert.notEqual(manifestRecord.id, "example-source-label", "non-opaque manifest ids must be anonymized");

  const refused = spawnSync(process.execPath, [
    campaign,
    "--manifest", manifest,
    "--dependency-layer", layer,
    "--output-dir", path.join(temporary, "refused-results"),
    "--require-isolation",
  ], { cwd: root, encoding: "utf8" });
  assert.notEqual(refused.status, 0, "required isolation must fail closed without a sandbox command");
  assert.match(refused.stderr, /requires --sandbox-command/);

  const shimDirectory = path.join(temporary, "shims");
  const sandbox = path.join(temporary, "sandbox.mjs");
  const isolatedOutput = path.join(temporary, "isolated-results");
  fs.mkdirSync(shimDirectory);
  fs.writeFileSync(path.join(shimDirectory, "sudo"), [
    "#!/usr/bin/env node",
    'const { spawnSync } = require("node:child_process");',
    "const args = process.argv.slice(2);",
    'if (args.shift() !== "-n") process.exit(9);',
    'const result = spawnSync(args.shift(), args, { stdio: "inherit" });',
    "process.exit(result.status ?? 1);",
  ].join("\n") + "\n", { mode: 0o755 });
  fs.writeFileSync(sandbox, [
    'import { spawnSync } from "node:child_process";',
    'import fs from "node:fs";',
    'import path from "node:path";',
    "const args = process.argv.slice(2);",
    'if (args[0] === "--cleanup-output") {',
    '  const directory = args[1];',
    '  fs.appendFileSync(process.env.CAMPAIGN_CLEANUP_MARKER, `${directory}\\n`);',
    '  fs.chmodSync(directory, 0o700);',
    '  process.exit(0);',
    "}",
    'const archive = args[args.indexOf("--archive") + 1];',
    'const dependencies = args[args.indexOf("--dependencies") + 1];',
    'const output = args[args.indexOf("--output") + 1];',
    'const forwarded = args.slice(args.indexOf("--") + 1);',
    'const command = [path.join(process.env.CAMPAIGN_TEST_ROOT, "bench/project-agent.mjs"),',
    '  "--project", archive, "--dependency-layer", dependencies, "--output-dir", output, ...forwarded];',
    'const result = spawnSync(process.execPath, command, { stdio: "inherit" });',
    'if (process.env.CAMPAIGN_SANDBOX_TARGET) {',
    '  const report = path.join(output, "report.json");',
    "  fs.unlinkSync(report);",
    '  fs.symlinkSync(process.env.CAMPAIGN_SANDBOX_TARGET, report);',
    "}",
    'if (process.env.CAMPAIGN_SANDBOX_OVERSIZED) {',
    '  fs.writeFileSync(path.join(output, "report.json"), "x".repeat(4 * 1024 * 1024 + 1));',
    "}",
    'if (process.env.CAMPAIGN_SANDBOX_INACCESSIBLE) {',
    '  fs.symlinkSync(process.env.CAMPAIGN_SANDBOX_INACCESSIBLE, path.join(output, "external"));',
    '  fs.chmodSync(output, 0);',
    "}",
    "process.exit(result.status ?? 1);",
  ].join("\n") + "\n");
  const isolated = spawnSync(process.execPath, [
    campaign,
    "--manifest", manifest,
    "--dependency-layer", layer,
    "--output-dir", isolatedOutput,
    "--mode", "build",
    "--sandbox-command", sandbox,
    "--require-isolation",
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PATH: `${shimDirectory}${path.delimiter}${process.env.PATH}`, CAMPAIGN_TEST_ROOT: root },
  });
  assert.equal(isolated.status, 0, `sandbox campaign failed:\n${isolated.stdout}\n${isolated.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(isolatedOutput, "summary.json"), "utf8")).passed, 1,
    "isolated workers must consume the sandbox report contract");

  const externalReport = path.join(temporary, "outside-report.json");
  fs.writeFileSync(externalReport, JSON.stringify({
    projects: [{ kind: "html-vite", checks: { build: { ok: true } } }],
  }));
  const symlinkOutput = path.join(temporary, "symlink-results");
  const symlinked = spawnSync(process.execPath, [
    campaign,
    "--manifest", manifest,
    "--dependency-layer", layer,
    "--output-dir", symlinkOutput,
    "--mode", "build",
    "--retries", "0",
    "--sandbox-command", sandbox,
    "--require-isolation",
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${shimDirectory}${path.delimiter}${process.env.PATH}`,
      CAMPAIGN_TEST_ROOT: root,
      CAMPAIGN_SANDBOX_TARGET: externalReport,
    },
  });
  assert.equal(symlinked.status, 0, `symlink report campaign failed:\n${symlinked.stdout}\n${symlinked.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(symlinkOutput, "summary.json"), "utf8")).infrastructureFailures, 1,
    "worker-controlled report symbolic links must never be followed");

  const oversizedOutput = path.join(temporary, "oversized-results");
  const oversized = spawnSync(process.execPath, [
    campaign,
    "--manifest", manifest,
    "--dependency-layer", layer,
    "--output-dir", oversizedOutput,
    "--mode", "build",
    "--retries", "0",
    "--sandbox-command", sandbox,
    "--require-isolation",
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${shimDirectory}${path.delimiter}${process.env.PATH}`,
      CAMPAIGN_TEST_ROOT: root,
      CAMPAIGN_SANDBOX_OVERSIZED: "1",
    },
  });
  assert.equal(oversized.status, 0, `oversized report campaign failed:\n${oversized.stdout}\n${oversized.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(oversizedOutput, "summary.json"), "utf8")).infrastructureFailures, 1,
    "oversized worker reports must be rejected before parsing");

  const cleanupMarker = path.join(temporary, "cleanup-marker");
  const cleanupSentinel = path.join(temporary, "cleanup-sentinel");
  const cleanupOutput = path.join(temporary, "cleanup-results");
  fs.writeFileSync(cleanupSentinel, "external data must stay untouched");
  const inaccessible = spawnSync(process.execPath, [
    campaign,
    "--manifest", manifest,
    "--dependency-layer", layer,
    "--output-dir", cleanupOutput,
    "--mode", "build",
    "--retries", "0",
    "--sandbox-command", sandbox,
    "--require-isolation",
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${shimDirectory}${path.delimiter}${process.env.PATH}`,
      CAMPAIGN_TEST_ROOT: root,
      CAMPAIGN_CLEANUP_MARKER: cleanupMarker,
      CAMPAIGN_SANDBOX_INACCESSIBLE: cleanupSentinel,
    },
  });
  assert.equal(inaccessible.status, 0,
    `inaccessible worker output must not crash the campaign:\n${inaccessible.stdout}\n${inaccessible.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cleanupOutput, "summary.json"), "utf8")).passed, 1,
    "recoverable worker reports must remain usable after output ownership is restored");
  const recoveredDirectory = fs.readFileSync(cleanupMarker, "utf8").trim();
  assert.match(path.basename(recoveredDirectory), /^oj-campaign-worker-/);
  assert.equal(fs.existsSync(recoveredDirectory), false, "privileged recovery must remove inaccessible worker output");
  assert.equal(fs.readFileSync(cleanupSentinel, "utf8"), "external data must stay untouched",
    "worker output cleanup must not follow symbolic links");

  console.log("PROJECT-CAMPAIGN E2E PASSED");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
