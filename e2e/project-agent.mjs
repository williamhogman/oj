// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "oj-agent-contract-"));
const project = path.join(temporary, "sample-project");
const layer = path.join(temporary, "dependencies");
const archive = path.join(temporary, "project.zip");
const output = path.join(temporary, "results");

try {
  fs.mkdirSync(project);
  fs.mkdirSync(layer);
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(project, "vite.config.mjs"), "export default {};\n");
  fs.writeFileSync(path.join(project, "index.html"), '<html><body><script type="module" src="/main.js"></script></body></html>');
  fs.writeFileSync(path.join(project, "main.js"), 'document.body.textContent = "archive contract";');

  const packed = spawnSync("zip", ["-q", "-r", archive, "sample-project"], {
    cwd: temporary,
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, `could not create test archive: ${packed.stderr}`);

  const agent = spawnSync(process.execPath, [
    path.join(root, "bench", "project-agent.mjs"),
    "--project", archive,
    "--dependency-layer", layer,
    "--mode", "build",
    "--output-dir", output,
  ], { cwd: root, encoding: "utf8" });
  assert.equal(agent.status, 0, `archive runner failed:\n${agent.stdout}\n${agent.stderr}`);

  const report = JSON.parse(fs.readFileSync(path.join(output, "report.json"), "utf8"));
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.summary, { projects: 1, checks: 1, passed: 1, failed: 0 });
  assert.equal(report.projects[0].name, "project");
  assert.equal(report.projects[0].kind, "html-vite");
  assert.ok(fs.existsSync(path.join(output, "projects", "project", "build.log")));

  const missingArchive = path.join(temporary, "missing-dependency.zip");
  const missingOutput = path.join(temporary, "missing-results");
  fs.writeFileSync(path.join(project, "main.js"), 'import "missing-agent-dependency";\n');
  const missingPack = spawnSync("zip", ["-q", "-r", missingArchive, "sample-project"], {
    cwd: temporary,
    encoding: "utf8",
  });
  assert.equal(missingPack.status, 0, `could not create missing-dependency archive: ${missingPack.stderr}`);

  const missing = spawnSync(process.execPath, [
    path.join(root, "bench", "project-agent.mjs"),
    "--project", missingArchive,
    "--dependency-layer", layer,
    "--mode", "build",
    "--output-dir", missingOutput,
  ], { cwd: root, encoding: "utf8" });
  assert.notEqual(missing.status, 0, "archives with missing dependencies must fail");

  const missingReport = JSON.parse(fs.readFileSync(path.join(missingOutput, "report.json"), "utf8"));
  assert.equal(missingReport.projects[0].checks.build.diagnostic.kind, "missing-dependency");
  assert.ok(missingReport.projects[0].checks.build.diagnostic.dependencies.includes("missing-agent-dependency"));

  const unsafe = path.join(temporary, "unsafe.zip");
  fs.symlinkSync("/etc/passwd", path.join(project, "outside"));
  const unsafePack = spawnSync("zip", ["-q", "-r", "-y", unsafe, "sample-project"], {
    cwd: temporary,
    encoding: "utf8",
  });
  assert.equal(unsafePack.status, 0, `could not create symbolic-link archive: ${unsafePack.stderr}`);

  const rejected = spawnSync(process.execPath, [
    path.join(root, "bench", "project-agent.mjs"),
    "--project", unsafe,
    "--dependency-layer", layer,
    "--mode", "build",
  ], { cwd: root, encoding: "utf8" });
  assert.notEqual(rejected.status, 0, "archives containing symbolic links must be rejected");
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /symbolic links/);

  const unsafePreparation = spawnSync(process.execPath, [
    path.join(root, "bench", "agent-vm.mjs"),
    "prepare",
    "--manifest", path.join(project, "package.json"),
  ], { cwd: root, encoding: "utf8" });
  assert.notEqual(unsafePreparation.status, 0, "external manifests must never enter network preparation");
  assert.match(`${unsafePreparation.stdout}\n${unsafePreparation.stderr}`, /checkout manifests/);

  console.log("PROJECT-AGENT E2E PASSED");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
