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
const origin = path.join(temporary, "origin.git");
const upstream = path.join(temporary, "upstream.git");
const executables = path.join(temporary, "executables");
const githubCalls = path.join(temporary, "github-calls.jsonl");

function command(executable, arguments_, cwd = repository) {
  const result = spawnSync(executable, arguments_, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${executable} ${arguments_.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function run(arguments_, { failure = false, env = {} } = {}) {
  const result = spawnSync(process.execPath, [pipeline, ...arguments_, "--state", state, "--repo", repository], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, ...env },
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
  command("git", ["branch", "-M", "main"]);
  const initial = command("git", ["rev-parse", "HEAD"]);
  command("git", ["init", "--bare", "-q", origin]);
  command("git", ["init", "--bare", "-q", upstream]);
  command("git", ["remote", "add", "origin", origin]);
  command("git", ["remote", "add", "upstream", upstream]);
  command("git", ["push", "-q", "origin", "main"]);
  command("git", ["push", "-q", "upstream", "main"]);

  fs.mkdirSync(executables);
  fs.writeFileSync(path.join(executables, "gh"), [
    "#!/usr/bin/env node",
    'import fs from "node:fs";',
    'fs.appendFileSync(process.env.BUG_PIPELINE_GITHUB_CALLS, `${JSON.stringify(process.argv.slice(2))}\\n`);',
    'if (process.argv[2] !== "pr" || process.argv[3] !== "create") process.exit(2);',
    'process.stdout.write("https://github.com/synthetic-upstream/oj/pull/42\\n");',
    "",
  ].join("\n"), { mode: 0o755 });
  const githubEnvironment = {
    PATH: `${executables}${path.delimiter}${process.env.PATH}`,
    BUG_PIPELINE_GITHUB_CALLS: githubCalls,
  };

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

  const prematurelyPublished = run([
    "publish", "--id", task.id, "--github-repo", "synthetic-upstream/oj", "--head-owner", "synthetic-owner",
  ], { failure: true, env: githubEnvironment });
  assert.match(prematurelyPublished.stderr, /not completed/);
  assert.equal(fs.existsSync(githubCalls), false, "unverified tasks must never reach GitHub");

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

  fs.writeFileSync(path.join(repository, "upstream-only.mjs"), "export const upstreamOnly = true;\n");
  command("git", ["add", "upstream-only.mjs"]);
  command("git", ["commit", "-q", "-m", "advance upstream independently"]);
  command("git", ["push", "-q", "upstream", "main"]);
  command("git", ["fetch", "-q", "upstream", "main"]);
  const latestUpstream = command("git", ["rev-parse", "upstream/main"]);
  assert.notEqual(latestUpstream, initial);

  const publishOptions = [
    "publish", "--id", task.id,
    "--github-repo", "synthetic-upstream/oj",
    "--head-owner", "synthetic-owner",
  ];

  const missingGithubRepository = run([
    "publish", "--id", task.id, "--head-owner", "synthetic-owner",
  ], { failure: true, env: githubEnvironment });
  assert.match(missingGithubRepository.stderr, /--github-repo/);

  const invalidGithubRepository = run([
    "publish", "--id", task.id, "--github-repo", "synthetic-upstream/oj --unsafe",
  ], { failure: true, env: githubEnvironment });
  assert.match(invalidGithubRepository.stderr, /github.repo|repository|owner/i);

  const deniedPublication = run([...publishOptions, "--deny", "export const"], {
    failure: true,
    env: githubEnvironment,
  });
  assert.match(deniedPublication.stderr, /privacy screening/);
  assert.equal(fs.existsSync(githubCalls), false, "unsafe changes must never reach GitHub");

  const previewPublication = run([...publishOptions, "--dry-run"], { env: githubEnvironment });
  assert.equal(previewPublication.action, "publish");
  assert.equal(previewPublication.dryRun, true);
  assert.equal(fs.existsSync(githubCalls), false, "dry-run must not create a pull request");
  assert.equal(
    command("git", ["for-each-ref", "--format=%(refname)", "refs/heads/bugfix/"], origin),
    "",
    "dry-run must not push a public branch",
  );
  assert.equal(
    run(["list"]).tasks.find((candidate) => candidate.id === task.id).pullRequest,
    undefined,
    "dry-run must not persist publication state",
  );

  const publication = run([...publishOptions, "--draft"], { env: githubEnvironment });
  assert.equal(publication.action, "publish");
  const publishedTask = run(["list"]).tasks.find((candidate) => candidate.id === task.id);
  assert.equal(publishedTask.status, "completed");
  assert.equal(publishedTask.pullRequest.url, "https://github.com/synthetic-upstream/oj/pull/42");
  assert.equal(publishedTask.pullRequest.branch, `bugfix/${task.id}`);
  assert.equal(publishedTask.pullRequest.base, "main");

  const calls = fs.readFileSync(githubCalls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls.length, 1, "one verified bug must create exactly one pull request");
  const [call] = calls;
  assert.deepEqual(call.slice(0, 2), ["pr", "create"]);
  for (const [flag, expected] of [
    ["--repo", "synthetic-upstream/oj"],
    ["--head", `synthetic-owner:bugfix/${task.id}`],
    ["--base", "main"],
  ]) {
    const index = call.indexOf(flag);
    assert.notEqual(index, -1, `${flag} must be passed to GitHub`);
    assert.equal(call[index + 1], expected);
  }
  assert.equal(call.includes("--draft"), true);
  const body = call[call.indexOf("--body") + 1];
  assert.match(body, /fail/i, "pull requests must describe the failing regression");
  assert.match(body, /pass/i, "pull requests must describe the passing fix");
  assert.equal(body.includes(restricted), false, "pull requests must not contain restricted input");
  assert.equal(body.includes("external-customer-identifier"), false, "pull requests must not identify projects");
  assert.equal(body.includes("customer@example.invalid"), false, "pull requests must not contain customer details");
  assert.equal(body.includes("example.invalid/customer"), false, "pull requests must not contain customer URLs");

  const remoteBranch = `refs/heads/bugfix/${task.id}`;
  const publishedTip = command("git", ["rev-parse", remoteBranch], origin);
  assert.equal(command("git", ["merge-base", publishedTip, latestUpstream]), latestUpstream);
  assert.equal(
    command("git", ["rev-list", "--count", `${latestUpstream}..${publishedTip}`]),
    "2",
    "each public branch must contain only its regression and implementation commits",
  );
  assert.deepEqual(
    command("git", ["log", "--format=%s", "--reverse", `${latestUpstream}..${publishedTip}`]).split("\n"),
    ["test: reproduce incorrect value", "fix: return the expected value"],
  );
  assert.deepEqual(
    command("git", ["diff", "--name-only", latestUpstream, publishedTip]).split("\n").sort(),
    ["tests/regression.test.mjs", "value.mjs"],
    "the pull request must not include tooling, unrelated bugs, or upstream-only changes",
  );

  const repeatedPublication = run(publishOptions, { env: githubEnvironment });
  assert.equal(repeatedPublication.action, "publish");
  assert.equal(fs.readFileSync(githubCalls, "utf8").trim().split("\n").length, 1);

  console.log("BUG-PIPELINE E2E PASSED");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
