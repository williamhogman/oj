// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const schemaVersion = 1;
const testPath = /(?:^|\/)(?:test|tests|e2e|fixtures|__tests__)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$|(?:^|\/)[^/]+_test\.[^/]+$/i;
const knownStages = new Set(["baseline", "build", "config", "dev", "install", "prepare", "probe", "resolve", "serve", "transform", "unknown"]);
const knownKinds = new Set([
  "asset", "config", "crash", "execution-failure", "incompatible-dependency", "missing-dependency",
  "panic", "plugin", "resolution", "runtime", "syntax", "timeout", "transform", "unknown",
]);
const protectedPatterns = [
  { name: "email address", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { name: "network address", pattern: /\bhttps?:\/\/[^\s"'<>]+/i },
  { name: "absolute user path", pattern: /(?:^|[\s"'(])(?:\/(?:Users|home|private|tmp)\/|[A-Z]:[\\/])/i },
  { name: "opaque external identifier", pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i },
  { name: "credential assignment", pattern: /(?:api[_-]?key|access[_-]?token|secret[_-]?key|password)\s*[:=]\s*["']?[A-Z0-9_/-]{12,}/i },
];

function usage() {
  return `Usage: node bench/bug-pipeline.mjs ACTION --state PATH [options]

Actions:
  ingest     Convert a cluster report into a sanitized, prioritized task queue
  list       Show pending, claimed, and completed tasks
  claim      Claim the highest-priority pending task and create a Git worktree
  release    Return a claimed task to the pending queue
  verify     Verify a regression fails before its fix and passes afterward
  complete   Verify a claimed task and mark it complete
  publish    Publish one verified regression and fix as an individual pull request

Options:
  --state PATH           Durable JSON queue state
  --input PATH           Generic cluster report for ingest
  --repo PATH            Git checkout (default: current directory)
  --worktrees PATH       Worktree directory (default: system temporary directory)
  --base REF             Starting Git revision (default: HEAD; main for publish)
  --worker NAME          Claiming worker identifier
  --id ID                Task identifier for release, verify, complete, or publish
  --test-commit SHA      Test-only commit containing the failing regression
  --fix-commit SHA       Later commit fixing the unchanged regression
  --test-command TEXT    Regression command, without shell operators
  --github-repo NAME     Pull request target in OWNER/REPOSITORY format
  --push-remote NAME     Git remote receiving bug branches (default: origin)
  --upstream-remote NAME Git remote supplying the pull request base (default: upstream)
  --head-owner NAME      GitHub account owning the push remote
  --report PATH          Write an independent verification report
  --deny TEXT            Reject public artifacts containing this text; repeatable
  --timeout-ms NUMBER    Regression timeout (default: 120000)
  --draft                Create a draft pull request
  --dry-run              Preview actions without changing durable state`;
}

function parseArguments(argv) {
  const [action, ...arguments_] = argv;
  if (!action || action === "--help" || action === "help") {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  if (!["ingest", "list", "claim", "release", "verify", "complete", "publish"].includes(action)) {
    throw new Error(`unknown action: ${action}`);
  }

  const options = {
    action,
    repo: process.cwd(),
    worktrees: path.join(os.tmpdir(), "project-bug-worktrees"),
    base: action === "publish" ? "main" : "HEAD",
    pushRemote: "origin",
    upstreamRemote: "upstream",
    deny: [],
    timeoutMs: 120_000,
    dryRun: false,
    draft: false,
  };

  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (flag === "--draft") {
      options.draft = true;
      continue;
    }
    if (flag === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    const value = arguments_[++index];
    if (!value) throw new Error(`${flag} requires a value`);
    switch (flag) {
      case "--state": options.state = path.resolve(value); break;
      case "--input": options.input = path.resolve(value); break;
      case "--repo": options.repo = path.resolve(value); break;
      case "--worktrees": options.worktrees = path.resolve(value); break;
      case "--base": options.base = value; break;
      case "--worker": options.worker = value; break;
      case "--id": options.id = value; break;
      case "--test-commit": options.testCommit = value; break;
      case "--fix-commit": options.fixCommit = value; break;
      case "--test-command": options.testCommand = value; break;
      case "--github-repo": options.githubRepo = value; break;
      case "--push-remote": options.pushRemote = value; break;
      case "--upstream-remote": options.upstreamRemote = value; break;
      case "--head-owner": options.headOwner = value; break;
      case "--report": options.report = path.resolve(value); break;
      case "--deny": options.deny.push(value); break;
      case "--timeout-ms": options.timeoutMs = Number(value); break;
      default: throw new Error(`unknown option: ${flag}`);
    }
  }

  if (!options.state) throw new Error("--state is required");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  for (const [flag, value] of [
    ["--id", options.id],
    ["--worker", options.worker],
    ["--push-remote", options.pushRemote],
    ["--upstream-remote", options.upstreamRemote],
    ["--head-owner", options.headOwner],
  ]) {
    if (value && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)) {
      throw new Error(`${flag} must be a simple identifier`);
    }
  }
  if (options.githubRepo && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(options.githubRepo)) {
    throw new Error("--github-repo must use OWNER/REPOSITORY format");
  }
  return options;
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readState(statePath) {
  if (!fs.existsSync(statePath)) return { schemaVersion, tasks: [] };
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (state.schemaVersion !== schemaVersion || !Array.isArray(state.tasks)) {
    throw new Error("unsupported queue state");
  }
  return state;
}

function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  try {
    const file = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
      fs.fsyncSync(file);
    } finally {
      fs.closeSync(file);
    }
    fs.renameSync(temporary, statePath);
    const directory = fs.openSync(path.dirname(statePath), "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function withStateLock(options, callback) {
  if (options.dryRun) return callback(readState(options.state));
  fs.mkdirSync(path.dirname(options.state), { recursive: true });
  const lock = `${options.state}.lock`;
  const owner = path.join(lock, "owner.json");
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      fs.writeFileSync(owner, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || Date.now() >= deadline) {
        throw new Error(`cannot acquire queue lock: ${error.message}`);
      }
      try {
        const current = JSON.parse(fs.readFileSync(owner, "utf8"));
        try {
          process.kill(current.pid, 0);
        } catch (ownerError) {
          if (ownerError.code === "ESRCH") {
            fs.unlinkSync(owner);
            fs.rmdirSync(lock);
            continue;
          }
        }
      } catch {
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    const state = readState(options.state);
    const result = callback(state);
    writeState(options.state, state);
    return result;
  } finally {
    fs.unlinkSync(owner);
    fs.rmdirSync(lock);
  }
}

function safeLabel(value, allowed) {
  const fallback = "unknown";
  if (typeof value !== "string") return fallback;
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 40);
  return allowed.has(normalized) ? normalized : fallback;
}

function affectedCount(cluster) {
  const value = cluster.count ?? cluster.affectedCount ?? cluster.occurrences ?? cluster.size ?? cluster.projects?.length ?? 1;
  const number = Array.isArray(value) ? value.length : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 1;
}

function taskFromCluster(cluster) {
  const stage = safeLabel(cluster.stage, knownStages);
  const kind = safeLabel(cluster.kind ?? cluster.category, knownKinds);
  const signature = String(cluster.fingerprint ?? cluster.id ?? JSON.stringify([stage, kind, cluster.message ?? ""]));
  const fingerprint = /^[a-f0-9]{16,64}$/i.test(signature) ? signature.toLowerCase() : digest(signature);
  const count = affectedCount(cluster);
  return {
    id: `bug-${fingerprint.slice(0, 16)}`,
    fingerprint,
    stage,
    kind,
    affectedCount: count,
    priority: count,
    status: "pending",
    instructions: [
      "Identify the failure mechanism using approved isolated diagnostics.",
      "Author an independent synthetic regression and commit only test files.",
      "Confirm the regression fails on the test-only commit.",
      "Implement the fix in a separate later commit without changing the regression.",
      "Confirm the unchanged regression passes and submit both commit identifiers.",
    ],
  };
}

function privacyFindings(value, deny) {
  const text = String(value);
  const findings = protectedPatterns
    .filter(({ pattern }) => pattern.test(text))
    .map(({ name }) => name);
  for (const entry of deny) {
    if (text.toLowerCase().includes(entry.toLowerCase())) findings.push("configured restricted text");
  }
  return [...new Set(findings)];
}

function assertPrivateSafe(value, deny, context) {
  const findings = privacyFindings(value, deny);
  if (findings.length) throw new Error(`${context} failed privacy screening: ${findings.join(", ")}`);
}

function git(repo, arguments_, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", repo, ...arguments_], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error(`git failed: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    const firstLine = result.stderr.trim().split("\n")[0] || "command failed";
    throw new Error(`git ${arguments_[0]} failed: ${firstLine}`);
  }
  return result;
}

function requireTask(state, id, status) {
  if (!id) throw new Error("--id is required");
  const task = state.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`unknown task: ${id}`);
  if (status && task.status !== status) throw new Error(`task ${id} is not ${status}`);
  return task;
}

function ingest(options) {
  if (!options.input) throw new Error("--input is required");
  const report = JSON.parse(fs.readFileSync(options.input, "utf8"));
  const clusters = Array.isArray(report) ? report : report.clusters ?? report.failures;
  if (!Array.isArray(clusters)) throw new Error("cluster report must contain a clusters array");

  return withStateLock(options, (state) => {
    let created = 0;
    let updated = 0;
    for (const cluster of clusters) {
      if (!cluster || typeof cluster !== "object") continue;
      const next = taskFromCluster(cluster);
      assertPrivateSafe(JSON.stringify(next), options.deny, "task");
      const existing = state.tasks.find((candidate) => candidate.id === next.id);
      if (existing) {
        if (existing.status !== "completed") {
          existing.affectedCount = Math.max(existing.affectedCount, next.affectedCount);
          existing.priority = existing.affectedCount;
          updated += 1;
        }
        continue;
      }
      state.tasks.push(next);
      created += 1;
    }
    state.tasks.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
    return { action: "ingest", dryRun: options.dryRun, created, updated, total: state.tasks.length };
  });
}

function claim(options) {
  if (!options.worker) throw new Error("--worker is required");
  assertPrivateSafe(options.worker, options.deny, "worker identifier");
  return withStateLock(options, (state) => {
    const task = state.tasks.find((candidate) => candidate.status === "pending");
    if (!task) return { action: "claim", dryRun: options.dryRun, task: null };
    const branch = `agent/${task.id}`;
    const directory = path.join(options.worktrees, task.id);
    const baseCommit = resolveCommit(options.repo, options.base, "--base");
    if (!options.dryRun) {
      fs.mkdirSync(options.worktrees, { recursive: true, mode: 0o700 });
      git(options.repo, ["worktree", "add", "-b", branch, directory, options.base]);
    }
    task.status = "claimed";
    task.worker = options.worker;
    task.branch = branch;
    task.worktree = directory;
    task.baseCommit = baseCommit;
    task.claimedAt = new Date().toISOString();
    return { action: "claim", dryRun: options.dryRun, task };
  });
}

function release(options) {
  return withStateLock(options, (state) => {
    const task = requireTask(state, options.id, "claimed");
    if (options.worker && options.worker !== task.worker) throw new Error("task belongs to another worker");
    const branch = task.branch;
    const directory = task.worktree;
    if (!options.dryRun && branch) {
      const merged = git(options.repo, ["merge-base", "--is-ancestor", branch, options.base], { allowFailure: true });
      if (merged.status !== 0) {
        throw new Error("cannot release a branch containing unmerged commits");
      }
    }
    if (!options.dryRun && directory && fs.existsSync(directory)) {
      const dirty = git(directory, ["status", "--porcelain"]).stdout.trim();
      if (dirty) throw new Error("cannot release a worktree with uncommitted changes");
      git(options.repo, ["worktree", "remove", directory]);
    }
    if (!options.dryRun && branch) {
      git(options.repo, ["branch", "-d", branch]);
    }
    task.status = "pending";
    delete task.worker;
    delete task.branch;
    delete task.worktree;
    delete task.baseCommit;
    delete task.claimedAt;
    return { action: "release", dryRun: options.dryRun, task };
  });
}

function splitCommand(value) {
  if (!value) throw new Error("--test-command is required");
  if (value.trim().startsWith("[")) {
    const command = JSON.parse(value);
    if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
      throw new Error("JSON test command must be a non-empty string array");
    }
    return command;
  }
  const parts = [];
  let current = "";
  let quote;
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) parts.push(current);
      current = "";
    } else {
      if (/[;&|`<>]/.test(character)) throw new Error("shell operators are not supported in test commands");
      current += character;
    }
  }
  if (quote) throw new Error("unterminated quote in test command");
  if (current) parts.push(current);
  if (parts.length === 0) throw new Error("test command cannot be empty");
  return parts;
}

function resolveCommit(repo, value, flag) {
  if (!value) throw new Error(`${flag} is required`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/^-]{0,199}$/.test(value)) throw new Error(`${flag} is invalid`);
  return git(repo, ["rev-parse", "--verify", `${value}^{commit}`]).stdout.trim();
}

function changedFiles(repo, left, right) {
  return git(repo, ["diff", "--name-only", "--diff-filter=ACMR", left, right]).stdout
    .split("\n")
    .filter(Boolean);
}

function screenChanges(repo, base, fix, deny) {
  const changes = git(repo, ["diff", "--unified=0", "--no-ext-diff", base, fix]).stdout;
  const additions = changes.split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
  const findings = privacyFindings(additions.join("\n"), deny);
  for (const filename of changedFiles(repo, base, fix)) {
    findings.push(...privacyFindings(filename, deny));
  }
  if (findings.length) throw new Error(`commit changes failed privacy screening: ${[...new Set(findings)].join(", ")}`);
  return { addedLines: additions.length, findings: [] };
}

function executeRegression(directory, command, timeoutMs) {
  const started = Date.now();
  const result = spawnSync(command[0], command.slice(1), {
    cwd: directory,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CI: "1", npm_config_ignore_scripts: "true" },
  });
  if (result.error) throw new Error(`regression command could not run: ${result.error.code ?? result.error.message}`);
  if (result.signal) throw new Error(`regression command stopped unexpectedly: ${result.signal}`);
  if (!Number.isInteger(result.status)) throw new Error("regression command returned no exit status");
  return {
    exitCode: result.status,
    durationMs: Date.now() - started,
    outputSha256: digest(`${result.stdout ?? ""}\n${result.stderr ?? ""}`),
  };
}

function verifyTask(options, task) {
  const testCommit = resolveCommit(options.repo, options.testCommit, "--test-commit");
  const fixCommit = resolveCommit(options.repo, options.fixCommit, "--fix-commit");
  if (testCommit === fixCommit) throw new Error("test and fix commits must be different");
  const ancestor = git(options.repo, ["merge-base", "--is-ancestor", testCommit, fixCommit], { allowFailure: true });
  if (ancestor.status !== 0) throw new Error("test commit must be an ancestor of the fix commit");
  if (task.branch) {
    const branchCommit = resolveCommit(options.repo, task.branch, "task branch");
    if (branchCommit !== fixCommit) throw new Error("fix commit must be the claimed task branch tip");
  }

  const parent = git(options.repo, ["rev-parse", "--verify", `${testCommit}^`]).stdout.trim();
  if (task.baseCommit && parent !== task.baseCommit) {
    throw new Error("test-only commit must immediately follow the claimed base revision");
  }
  const tests = changedFiles(options.repo, parent, testCommit);
  if (tests.length === 0 || tests.some((filename) => !testPath.test(filename))) {
    throw new Error("test-only commit must change regression or fixture files exclusively");
  }
  const followUpChanges = changedFiles(options.repo, testCommit, fixCommit);
  if (followUpChanges.length === 0) throw new Error("fix commit must change implementation files");
  if (tests.some((filename) => followUpChanges.includes(filename))) {
    throw new Error("fix commit must not modify the original regression files");
  }
  if (!followUpChanges.some((filename) => !testPath.test(filename))) {
    throw new Error("fix commit must include an implementation change");
  }

  const command = splitCommand(options.testCommand);
  assertPrivateSafe(options.testCommand, options.deny, "test command");
  const privacy = screenChanges(options.repo, parent, fixCommit, options.deny);
  const report = {
    schemaVersion,
    taskId: task.id,
    fingerprint: task.fingerprint,
    testCommit,
    fixCommit,
    testFiles: tests,
    implementationFiles: followUpChanges.filter((filename) => !testPath.test(filename)),
    privacy,
    dryRun: options.dryRun,
  };

  if (options.dryRun) return report;
  const verificationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bug-pipeline-verify-"));
  const checkout = path.join(verificationRoot, "checkout");
  let created = false;
  try {
    git(options.repo, ["worktree", "add", "--detach", checkout, testCommit]);
    created = true;
    report.failingRegression = executeRegression(checkout, command, options.timeoutMs);
    if (report.failingRegression.exitCode === 0) {
      throw new Error("regression must fail on the test-only commit");
    }
    git(checkout, ["checkout", "--detach", fixCommit]);
    report.passingRegression = executeRegression(checkout, command, options.timeoutMs);
    if (report.passingRegression.exitCode !== 0) {
      throw new Error("regression must pass on the fix commit");
    }
    report.verifiedAt = new Date().toISOString();
    report.result = "passed";
    return report;
  } finally {
    if (created) git(options.repo, ["worktree", "remove", "--force", checkout]);
    fs.rmSync(verificationRoot, { recursive: true, force: true });
  }
}

function writeReport(options, report) {
  if (!options.report || options.dryRun) return;
  fs.mkdirSync(path.dirname(options.report), { recursive: true, mode: 0o700 });
  fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function verify(options) {
  const state = readState(options.state);
  const task = requireTask(state, options.id);
  const report = verifyTask(options, task);
  writeReport(options, report);
  return { action: "verify", report };
}

function complete(options) {
  const snapshot = requireTask(readState(options.state), options.id, "claimed");
  if (options.worker && options.worker !== snapshot.worker) throw new Error("task belongs to another worker");
  const report = verifyTask(options, snapshot);
  return withStateLock(options, (state) => {
    const task = requireTask(state, options.id, "claimed");
    if (task.worker !== snapshot.worker || task.claimedAt !== snapshot.claimedAt) {
      throw new Error("task claim changed during verification");
    }
    if (!options.dryRun) {
      task.status = "completed";
      task.testCommit = report.testCommit;
      task.fixCommit = report.fixCommit;
      task.testCommand = options.testCommand;
      task.verification = {
        failingExitCode: report.failingRegression.exitCode,
        passingExitCode: report.passingRegression.exitCode,
        verifiedAt: report.verifiedAt,
      };
      task.completedAt = report.verifiedAt;
      writeReport(options, report);
    }
    return { action: "complete", dryRun: options.dryRun, task, report };
  });
}

function resolvePublicationBase(options) {
  const valid = git(options.repo, ["check-ref-format", `refs/heads/${options.base}`], { allowFailure: true });
  if (valid.status !== 0) throw new Error("--base must be a valid target branch name for publish");
  for (const candidate of [
    `refs/remotes/${options.upstreamRemote}/${options.base}`,
    `refs/heads/${options.base}`,
  ]) {
    const resolved = git(options.repo, ["rev-parse", "--verify", `${candidate}^{commit}`], { allowFailure: true });
    if (resolved.status === 0) return resolved.stdout.trim();
  }
  throw new Error(`cannot resolve target branch ${options.base}; fetch ${options.upstreamRemote} first`);
}

function resolveHeadOwner(options) {
  if (options.headOwner) return options.headOwner;
  const remote = git(options.repo, ["remote", "get-url", options.pushRemote]).stdout.trim();
  const match = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([a-zA-Z0-9_-]+)\/[a-zA-Z0-9._-]+(?:\.git)?\/?$/);
  if (!match) throw new Error("cannot infer GitHub fork owner; provide --head-owner");
  return match[1];
}

function pullRequestText(task, command, report) {
  const title = `fix(${task.stage}): handle ${task.kind} compatibility failure`;
  const body = [
    "## Summary",
    "",
    `- Correct a ${task.kind} failure during ${task.stage}.`,
    "- Add an independent synthetic regression in a separate preceding commit.",
    "",
    "## Verification",
    "",
    `- Regression command: \`${command}\`.`,
    `- Before the fix: fails with exit code ${report.failingRegression.exitCode}.`,
    `- After the fix: passes with exit code ${report.passingRegression.exitCode}.`,
  ].join("\n");
  return { title, body };
}

function createPullRequest(options, branch, headOwner, title, body) {
  const arguments_ = [
    "pr", "create",
    "--repo", options.githubRepo,
    "--head", `${headOwner}:${branch}`,
    "--base", options.base,
    "--title", title,
    "--body", body,
  ];
  if (options.draft) arguments_.push("--draft");
  const result = spawnSync("gh", arguments_, {
    cwd: options.repo,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw new Error(`pull request creation failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`pull request creation failed: ${result.stderr.trim().split("\n")[0] || "command failed"}`);
  }
  const url = result.stdout.trim().split("\n").at(-1);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("pull request creation did not return a GitHub pull request URL");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com"
    || !new RegExp(`^/${options.githubRepo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/[0-9]+/?$`, "i").test(parsed.pathname)) {
    throw new Error("pull request creation returned an unexpected repository URL");
  }
  return url;
}

function publish(options) {
  if (!options.githubRepo) throw new Error("--github-repo is required for publish");
  const snapshot = requireTask(readState(options.state), options.id, "completed");
  if (snapshot.pullRequest) {
    return { action: "publish", dryRun: options.dryRun, alreadyPublished: true, task: snapshot, pullRequest: snapshot.pullRequest };
  }
  const command = options.testCommand ?? snapshot.testCommand;
  if (!command) throw new Error("--test-command is required for completed tasks without a recorded regression command");
  const baseCommit = resolvePublicationBase(options);
  const headOwner = resolveHeadOwner(options);
  const branch = `bugfix/${snapshot.id}`;
  const initialOptions = {
    ...options,
    dryRun: true,
    testCommit: snapshot.testCommit,
    fixCommit: snapshot.fixCommit,
    testCommand: command,
  };
  verifyTask(initialOptions, snapshot);
  const planned = { branch, base: options.base, baseCommit, repository: options.githubRepo, head: `${headOwner}:${branch}` };
  if (options.dryRun) return { action: "publish", dryRun: true, task: snapshot, pullRequest: planned };

  const publicationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bug-pipeline-publish-"));
  const checkout = path.join(publicationRoot, "checkout");
  let created = false;
  let pushed = false;
  let pullRequest;
  try {
    git(options.repo, ["worktree", "add", "-b", branch, checkout, baseCommit]);
    created = true;
    git(checkout, ["cherry-pick", snapshot.testCommit]);
    const testCommit = resolveCommit(checkout, "HEAD", "publication regression commit");
    git(checkout, ["cherry-pick", `${snapshot.testCommit}..${snapshot.fixCommit}`]);
    const fixCommit = resolveCommit(checkout, "HEAD", "publication fix commit");
    const task = { ...snapshot, branch, baseCommit };
    const report = verifyTask({
      ...options,
      repo: checkout,
      testCommit,
      fixCommit,
      testCommand: command,
    }, task);
    const { title, body } = pullRequestText(snapshot, command, report);
    assertPrivateSafe(title, options.deny, "pull request title");
    assertPrivateSafe(body, options.deny, "pull request body");
    git(checkout, ["push", options.pushRemote, `${branch}:refs/heads/${branch}`]);
    pushed = true;
    const url = createPullRequest(options, branch, headOwner, title, body);
    pullRequest = {
      ...planned,
      testCommit,
      fixCommit,
      title,
      url,
      publishedAt: new Date().toISOString(),
    };
    return withStateLock(options, (state) => {
      const current = requireTask(state, snapshot.id, "completed");
      if (current.testCommit !== snapshot.testCommit || current.fixCommit !== snapshot.fixCommit) {
        throw new Error("completed task changed while publishing its pull request");
      }
      current.pullRequest = pullRequest;
      writeReport(options, report);
      return { action: "publish", dryRun: false, alreadyPublished: false, task: current, report, pullRequest };
    });
  } finally {
    if (created) {
      git(options.repo, ["worktree", "remove", "--force", checkout], { allowFailure: true });
      if (!pushed) git(options.repo, ["branch", "-D", branch], { allowFailure: true });
    }
    fs.rmSync(publicationRoot, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const handlers = {
    ingest,
    list: ({ state }) => {
      const queue = readState(state);
      return {
        action: "list",
        summary: Object.fromEntries(["pending", "claimed", "completed"]
          .map((status) => [status, queue.tasks.filter((task) => task.status === status).length])),
        tasks: queue.tasks,
      };
    },
    claim,
    release,
    verify,
    complete,
    publish,
  };
  const result = handlers[options.action](options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`bug-pipeline: ${error.message}\n`);
  process.exitCode = 1;
}
