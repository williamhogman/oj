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
const campaign = path.join(root, "bench", "project-campaign.mjs");

function createArchive(name, missing = false) {
  const source = missing
    ? 'import "missing-example-dependency";\n'
    : 'document.body.textContent = "ready";\n';
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
    "--output-dir", output,
    "--workers", "3",
    "--batch-size", "4",
    "--mode", "build",
    "--timeout-ms", "15000",
    ...args,
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CAMPAIGN_BASELINE_MARKER: marker },
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
    'require("node:fs").appendFileSync(process.env.CAMPAIGN_BASELINE_MARKER, "baseline\\n");',
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

  console.log("PROJECT-CAMPAIGN E2E PASSED");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
