// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dependencies = process.argv[2] && path.resolve(process.argv[2]);

if (process.platform !== "linux" || !dependencies) {
  console.log("PROJECT-SANDBOX E2E SKIPPED: requires Linux and a dependency layer");
  process.exit(0);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "oj-sandbox-contract-"));
const project = path.join(temporary, "example");
const archive = path.join(temporary, "example.zip");
const output = path.join(temporary, "output");

try {
  fs.mkdirSync(project);
  fs.mkdirSync(output, { mode: 0o700 });
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(project, "index.html"), '<html><body><script type="module" src="/main.js"></script></body></html>');
  fs.writeFileSync(path.join(project, "main.js"), 'document.body.textContent = "isolated";\n');
  fs.writeFileSync(path.join(project, "vite.config.mjs"), `
import fs from "node:fs";
import { spawnSync } from "node:child_process";

if (process.getuid() === 0) throw new Error("project execution retained root privileges");
if (fs.existsSync("/home") || fs.existsSync("/root")) throw new Error("host directories are visible");
if (Object.keys(process.env).some((name) => /TOKEN|SECRET|CREDENTIAL/i.test(name))) {
  throw new Error("privileged environment leaked into project execution");
}
if (spawnSync("sudo", ["-n", "true"], { stdio: "ignore" }).status === 0) {
  throw new Error("project execution can regain administrator privileges");
}
try {
  fs.writeFileSync("/opt/node_modules/.sandbox-escape", "blocked");
  throw new Error("dependency layer is writable");
} catch (error) {
  if (error.message === "dependency layer is writable") throw error;
}
const interfaces = fs.readFileSync("/proc/net/dev", "utf8").split("\\n")
  .filter((line) => line.includes(":"))
  .map((line) => line.split(":")[0].trim())
  .filter((entry) => entry !== "lo");
if (interfaces.length > 0) throw new Error("external network interfaces are visible");
export default {};
`);

  const packed = spawnSync("python3", ["-m", "zipfile", "-c", archive, "example"], {
    cwd: temporary,
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, `could not create isolation fixture: ${packed.stderr}`);

  const args = [
    "-n", process.execPath, path.join(root, "bench", "project-sandbox.mjs"),
    "--archive", archive,
    "--dependencies", dependencies,
    "--output", output,
    "--", "--mode", "build", "--timeout-ms", "15000",
  ];
  const isolated = spawnSync("sudo", args, { cwd: root, encoding: "utf8" });
  assert.equal(isolated.status, 0, `isolated project failed:\n${isolated.stdout}\n${isolated.stderr}`);
  const report = JSON.parse(fs.readFileSync(path.join(output, "report.json"), "utf8"));
  assert.equal(report.summary.failed, 0);
  assert.equal(fs.statSync(output).uid, process.getuid());

  const escaped = spawnSync("sudo", [
    "-n", process.execPath, path.join(root, "bench", "project-sandbox.mjs"),
    "--archive", archive,
    "--dependencies", dependencies,
    "--output", "/etc",
  ], { cwd: root, encoding: "utf8" });
  assert.notEqual(escaped.status, 0, "host system directories must never become sandbox outputs");

  console.log("PROJECT-SANDBOX E2E PASSED");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
