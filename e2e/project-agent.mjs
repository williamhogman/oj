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

  const baselineExecutables = path.join(temporary, "baseline-executables");
  const baselineInvocation = path.join(temporary, "baseline-invocation.json");
  const packageRunnerInvocation = path.join(temporary, "package-runner-invocation");
  const baselineOutput = path.join(temporary, "baseline-results");
  const baselineWorkdir = path.join(temporary, "baseline-workdir");
  fs.mkdirSync(baselineExecutables);
  fs.mkdirSync(path.join(layer, ".bin"));
  fs.writeFileSync(path.join(layer, ".bin", "vite"), [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    "fs.writeFileSync(process.env.PROJECT_AGENT_BASELINE_INVOCATION,",
    "  JSON.stringify({ arguments: process.argv.slice(2), directory: process.cwd() }));",
  ].join("\n") + "\n", { mode: 0o755 });
  fs.writeFileSync(path.join(baselineExecutables, "npx"), [
    "#!/usr/bin/env node",
    'require("node:fs").writeFileSync(process.env.PROJECT_AGENT_PACKAGE_RUNNER_INVOCATION, "invoked");',
    "process.exit(79);",
  ].join("\n") + "\n", { mode: 0o755 });

  const baseline = spawnSync(process.execPath, [
    path.join(root, "bench", "project-agent.mjs"),
    "--project", archive,
    "--dependency-layer", layer,
    "--mode", "build",
    "--baseline-only",
    "--workdir", baselineWorkdir,
    "--output-dir", baselineOutput,
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${baselineExecutables}${path.delimiter}${process.env.PATH}`,
      PROJECT_AGENT_BASELINE_INVOCATION: baselineInvocation,
      PROJECT_AGENT_PACKAGE_RUNNER_INVOCATION: packageRunnerInvocation,
    },
  });
  assert.equal(baseline.status, 0, `direct Vite baseline failed:\n${baseline.stdout}\n${baseline.stderr}`);
  assert.equal(fs.existsSync(packageRunnerInvocation), false, "production baselines must never invoke npx");
  const stagedProject = path.join(baselineWorkdir, "project", "sample-project");
  assert.deepEqual(JSON.parse(fs.readFileSync(baselineInvocation, "utf8")), {
    arguments: ["build", "--outDir", path.join(stagedProject, ".vite-dist")],
    directory: fs.realpathSync(stagedProject),
  }, "production baselines must invoke the staged project's local Vite executable");
  assert.equal(JSON.parse(fs.readFileSync(path.join(baselineOutput, "report.json"), "utf8"))
    .projects[0].checks.baseline.ok, true);

  if (process.platform !== "win32") {
    const lingeringOj = path.join(temporary, "lingering-oj");
    fs.writeFileSync(lingeringOj, [
      "#!/usr/bin/env node",
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });',
      'fs.writeFileSync(process.env.PROJECT_AGENT_DESCENDANT_PID, String(descendant.pid));',
      "setInterval(() => {}, 1000);",
    ].join("\n") + "\n", { mode: 0o755 });

    for (const mode of ["build", "dev"]) {
      const descendantMarker = path.join(temporary, `${mode}-descendant-pid`);
      const timeoutOutput = path.join(temporary, `${mode}-timeout-results`);
      const started = performance.now();
      const timed = spawnSync(process.execPath, [
        path.join(root, "bench", "project-agent.mjs"),
        "--project", archive,
        "--dependency-layer", layer,
        "--mode", mode,
        "--oj", lingeringOj,
        "--timeout-ms", "1000",
        "--output-dir", timeoutOutput,
      ], {
        cwd: root,
        encoding: "utf8",
        timeout: 6_000,
        killSignal: "SIGKILL",
        env: { ...process.env, PROJECT_AGENT_DESCENDANT_PID: descendantMarker },
      });
      const elapsed = performance.now() - started;
      const descendantPid = fs.existsSync(descendantMarker)
        ? Number(fs.readFileSync(descendantMarker, "utf8"))
        : undefined;

      try {
        assert.equal(timed.error, undefined, `${mode} timeout must not wait for inherited descendant pipes`);
        assert.ok(elapsed < 5_000, `${mode} timeout exceeded its bounded cleanup window: ${elapsed}ms`);
        assert.ok(Number.isSafeInteger(descendantPid), `${mode} fixture must start a descendant:\n${timed.stdout}\n${timed.stderr}`);
        assert.throws(() => process.kill(descendantPid, 0), `${mode} timeout must terminate its full process group`);
        const result = JSON.parse(fs.readFileSync(path.join(timeoutOutput, "report.json"), "utf8"));
        assert.equal(result.projects[0].checks[mode].diagnostic.kind, "timeout");
      } finally {
        if (descendantPid) {
          try { process.kill(descendantPid, "SIGKILL"); } catch {}
        }
      }
    }
  }

  const missingArchive = path.join(temporary, "missing-dependency.zip");
  const missingOutput = path.join(temporary, "missing-results");
  fs.writeFileSync(path.join(project, "main.js"), 'import "missing-agent-dependency";\n');
  const missingPack = spawnSync("zip", ["-q", "-r", missingArchive, "sample-project"], {
    cwd: temporary,
    encoding: "utf8",
  });
  assert.equal(missingPack.status, 0, `could not create missing-dependency archive: ${missingPack.stderr}`);

  const rollupExecutable = path.join(temporary, "synthetic-rollup-oj");
  fs.writeFileSync(rollupExecutable, "#!/usr/bin/env node\nconsole.error(process.env.OJ_SYNTHETIC_FAILURE);\nprocess.exit(1);\n", {
    mode: 0o755,
  });
  const missing = spawnSync(process.execPath, [
    path.join(root, "bench", "project-agent.mjs"),
    "--project", missingArchive,
    "--dependency-layer", layer,
    "--mode", "build",
    "--oj", rollupExecutable,
    "--output-dir", missingOutput,
  ], { cwd: root, encoding: "utf8", env: { ...process.env, OJ_SYNTHETIC_FAILURE: 'Error: Could not resolve "missing-agent-dependency"' } });
  assert.notEqual(missing.status, 0, "archives with missing dependencies must fail");

  const missingReport = JSON.parse(fs.readFileSync(path.join(missingOutput, "report.json"), "utf8"));
  assert.equal(missingReport.projects[0].checks.build.diagnostic.kind, "missing-dependency");
  assert.ok(missingReport.projects[0].checks.build.diagnostic.dependencies.includes("missing-agent-dependency"));

  for (const [index, [message, dependency]] of [
    ['[vite]: Rollup failed to resolve import "@synthetic/rollup-package" from "/synthetic/main.ts"', "@synthetic/rollup-package"],
    ['[plugin:vite:import-analysis] Failed to resolve import "synthetic-vite-package" from "src/App.tsx"', "synthetic-vite-package"],
    ['RollupError: Could not resolve import "synthetic-import-package" from "entry.ts"', "synthetic-import-package"],
  ].entries()) {
    const rollupOutput = path.join(temporary, `rollup-results-${index}`);
    const rollup = spawnSync(process.execPath, [
      path.join(root, "bench", "project-agent.mjs"),
      "--project", archive,
      "--dependency-layer", layer,
      "--mode", "build",
      "--oj", rollupExecutable,
      "--output-dir", rollupOutput,
    ], { cwd: root, encoding: "utf8", env: { ...process.env, OJ_SYNTHETIC_FAILURE: message } });
    assert.notEqual(rollup.status, 0, "synthetic Rollup dependency failures must fail");
    const rollupReport = JSON.parse(fs.readFileSync(path.join(rollupOutput, "report.json"), "utf8"));
    const diagnostic = rollupReport.projects[0].checks.build.diagnostic;
    assert.equal(diagnostic.kind, "missing-dependency", `expected missing-dependency classification for: ${message}`);
    assert.deepEqual(diagnostic.dependencies, [dependency]);
  }

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
