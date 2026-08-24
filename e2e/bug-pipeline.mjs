// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pipeline = path.join(root, "bench", "bug-pipeline.mjs");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "bug-pipeline-e2e-"));
const repository = path.join(temporary, "repository");
const state = path.join(temporary, "state", "queue.json");
const worktrees = path.join(temporary, "worktrees");
const clusters = path.join(temporary, "clusters.json");

function command(executable, arguments_, cwd = repository) {
  const result = spawnSync(executable, arguments_, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${executable} ${arguments_.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function run(arguments_, { failure = false } = {}) {
  const result = spawnSync(process.execPath, [pipeline, ...arguments_, "--state", state, "--repo", repository], {
    cwd: repository,
    encoding: "utf8",
  });
  if (failure) {
    assert.notEqual(result.status, 0, `command unexpectedly succeeded:\n${result.stdout}`);
    return result;
  }
  assert.equal(result.status, 0, `pipeline failed:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

try {
  fs.mkdirSync(repository);
  command("git", ["init", "-q"]);
  command("git", ["config", "user.name", "Synthetic Worker"]);
  command("git", ["config", "user.email", "worker@example.invalid"]);
  fs.writeFileSync(path.join(repository, "value.mjs"), "export const value = 1;\n");
  command("git", ["add", "value.mjs"]);
  command("git", ["commit", "-q", "-m", "initial implementation"]);
  const initial = command("git", ["rev-parse", "HEAD"]);

  const restricted = "restricted-company-token";
  const upstreamFingerprint = "0123456789abcdef0123456789abcdef";
  fs.writeFileSync(clusters, JSON.stringify({
    schemaVersion: 1,
    clusters: [
      { id: "small", fingerprint: "low-frequency", count: 2, stage: "private-customer-stage", kind: "syntax" },
      {
        id: "high",
        fingerprint: upstreamFingerprint,
        count: 17,
        stage: "build",
        kind: "resolution",
        message: `project data ${restricted} customer@example.invalid https://example.invalid/customer`,
        projects: ["external-customer-identifier"],
      },
    ],
  }));

  const preview = run(["ingest", "--input", clusters, "--deny", restricted, "--dry-run"]);
  assert.equal(preview.created, 2);
  assert.equal(fs.existsSync(state), false, "dry-run must not create durable state");

  const ingested = run(["ingest", "--input", clusters, "--deny", restricted]);
  assert.equal(ingested.created, 2);
  const abandonedLock = `${state}.lock`;
  fs.mkdirSync(abandonedLock);
  fs.writeFileSync(path.join(abandonedLock, "owner.json"), JSON.stringify({ pid: 2_147_483_647 }));
  assert.equal(run(["ingest", "--input", clusters]).updated, 2, "abandoned queue locks must be reclaimed");
  assert.equal(fs.existsSync(abandonedLock), false);
  const persisted = fs.readFileSync(state, "utf8");
  assert.equal(persisted.includes(restricted), false, "private cluster messages must never persist");
  assert.equal(persisted.includes("external-customer-identifier"), false, "project identifiers must never persist");
  assert.equal(persisted.includes("customer@example.invalid"), false, "customer contact data must never persist");
  assert.equal(persisted.includes("private-customer-stage"), false, "unrecognized stage labels must never persist");

  const listed = run(["list"]);
  assert.deepEqual(listed.summary, { pending: 2, claimed: 0, completed: 0 });
  assert.equal(listed.tasks[0].affectedCount, 17, "highest-impact cluster must be first");
  assert.equal(listed.tasks[0].fingerprint, upstreamFingerprint, "safe upstream fingerprints must remain joinable");

  const dryClaim = run(["claim", "--worker", "worker-1", "--worktrees", worktrees, "--dry-run"]);
  assert.equal(fs.existsSync(dryClaim.task.worktree), false, "dry-run must not create worktrees");
  assert.equal(run(["list"]).summary.pending, 2);

  const claimed = run(["claim", "--worker", "worker-1", "--worktrees", worktrees]);
  const task = claimed.task;
  assert.equal(task.affectedCount, 17);
  assert.equal(fs.existsSync(task.worktree), true);
  assert.equal(command("git", ["rev-parse", "--abbrev-ref", "HEAD"], task.worktree), task.branch);

  const wrongWorker = run(["release", "--id", task.id, "--worker", "worker-2"], { failure: true });
  assert.match(wrongWorker.stderr, /another worker/);

  const secondary = run(["claim", "--worker", "worker-2", "--worktrees", worktrees]);
  assert.notEqual(secondary.task.id, task.id);
  assert.equal(run(["claim", "--worker", "worker-3", "--worktrees", worktrees]).task, null);
  const draft = path.join(secondary.task.worktree, "draft.txt");
  fs.writeFileSync(draft, "unsaved work\n");
  const dirtyRelease = run(["release", "--id", secondary.task.id, "--worker", "worker-2"], { failure: true });
  assert.match(dirtyRelease.stderr, /uncommitted changes/);
  assert.equal(fs.existsSync(draft), true, "rejected release must preserve uncommitted work");
  fs.unlinkSync(draft);
  run(["release", "--id", secondary.task.id, "--worker", "worker-2"]);
  assert.equal(fs.existsSync(secondary.task.worktree), false);

  fs.mkdirSync(path.join(task.worktree, "tests"));
  fs.writeFileSync(path.join(task.worktree, "tests", "regression.test.mjs"), [
    'import assert from "node:assert/strict";',
    'import { value } from "../value.mjs";',
    "assert.equal(value, 2);",
    "",
  ].join("\n"));
  command("git", ["add", "tests/regression.test.mjs"], task.worktree);
  command("git", ["commit", "-q", "-m", "test: reproduce incorrect value"], task.worktree);
  const testCommit = command("git", ["rev-parse", "HEAD"], task.worktree);

  fs.writeFileSync(path.join(task.worktree, "value.mjs"), "export const value = 2;\n");
  command("git", ["add", "value.mjs"], task.worktree);
  command("git", ["commit", "-q", "-m", "fix: return the expected value"], task.worktree);
  const fixCommit = command("git", ["rev-parse", "HEAD"], task.worktree);

  const shared = [
    "--id", task.id,
    "--test-commit", testCommit,
    "--fix-commit", fixCommit,
    "--test-command", "node tests/regression.test.mjs",
  ];

  const reversed = run([
    "verify", "--id", task.id,
    "--test-commit", fixCommit,
    "--fix-commit", testCommit,
    "--test-command", "node tests/regression.test.mjs",
  ], { failure: true });
  assert.match(reversed.stderr, /ancestor/);

  const denied = run(["verify", ...shared, "--deny", "export const"], { failure: true });
  assert.match(denied.stderr, /privacy screening/);

  const missingExecutable = run([
    "verify", "--id", task.id,
    "--test-commit", testCommit,
    "--fix-commit", fixCommit,
    "--test-command", "missing-synthetic-executable tests/regression.test.mjs",
  ], { failure: true });
  assert.match(missingExecutable.stderr, /could not run/);

  const dryVerification = run(["verify", ...shared, "--dry-run"]);
  assert.equal(dryVerification.report.dryRun, true);
  assert.equal("failingRegression" in dryVerification.report, false);

  const reportPath = path.join(temporary, "verification", "report.json");
  const verification = run(["verify", ...shared, "--report", reportPath]);
  assert.equal(verification.report.result, "passed");
  assert.notEqual(verification.report.failingRegression.exitCode, 0);
  assert.equal(verification.report.passingRegression.exitCode, 0);
  assert.deepEqual(verification.report.testFiles, ["tests/regression.test.mjs"]);
  assert.deepEqual(verification.report.implementationFiles, ["value.mjs"]);
  assert.equal(JSON.parse(fs.readFileSync(reportPath, "utf8")).result, "passed");

  const completed = run(["complete", ...shared, "--worker", "worker-1"]);
  assert.equal(completed.task.status, "completed");
  assert.deepEqual(run(["list"]).summary, { pending: 1, claimed: 0, completed: 1 });

  const replacement = run(["claim", "--worker", "worker-2", "--worktrees", worktrees, "--base", initial]);
  fs.mkdirSync(path.join(replacement.task.worktree, "tests"));
  fs.writeFileSync(path.join(replacement.task.worktree, "tests", "bad.test.mjs"), "process.exit(1);\n");
  fs.writeFileSync(path.join(replacement.task.worktree, "value.mjs"), "export const value = 3;\n");
  command("git", ["add", "tests/bad.test.mjs", "value.mjs"], replacement.task.worktree);
  command("git", ["commit", "-q", "-m", "incorrect mixed regression commit"], replacement.task.worktree);
  const mixedCommit = command("git", ["rev-parse", "HEAD"], replacement.task.worktree);
  fs.writeFileSync(path.join(replacement.task.worktree, "value.mjs"), "export const value = 4;\n");
  command("git", ["add", "value.mjs"], replacement.task.worktree);
  command("git", ["commit", "-q", "-m", "follow-up implementation"], replacement.task.worktree);
  const mixedFix = command("git", ["rev-parse", "HEAD"], replacement.task.worktree);
  const mixed = run([
    "verify", "--id", replacement.task.id,
    "--test-commit", mixedCommit,
    "--fix-commit", mixedFix,
    "--test-command", "node tests/bad.test.mjs",
  ], { failure: true });
  assert.match(mixed.stderr, /test-only commit/);

  console.log("BUG-PIPELINE E2E PASSED");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
