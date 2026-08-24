// SPDX-License-Identifier: MIT

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(root, "bench", "project-agent.mjs");
const stableErrorCodes = new Set([
  "EACCES", "EADDRINUSE", "ECONNREFUSED", "EISDIR", "ENOENT", "ENOTDIR", "ETIMEDOUT",
  "ERR_INVALID_MODULE_SPECIFIER", "ERR_INVALID_PACKAGE_CONFIG", "ERR_MODULE_NOT_FOUND",
  "ERR_PACKAGE_IMPORT_NOT_DEFINED", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_REQUIRE_ESM",
  "ERR_UNKNOWN_FILE_EXTENSION", "ERR_UNSUPPORTED_DIR_IMPORT",
]);
const maximumReportBytes = 4 * 1024 * 1024;

function usage() {
  return `Usage: node bench/project-campaign.mjs [options]

  --archive PATH             Anonymous ZIP archive; repeat as needed
  --archives-dir PATH        Discover ZIP archives in a directory
  --manifest PATH            JSONL records containing archive and optional id
  --output-dir PATH          Durable campaign journal and anonymized reports
  --dependency-layer PATH    Existing dependency layer; repeat as needed
  --oj PATH                  Existing OJ executable
  --sandbox-command PATH     Execute each archive through a privileged sandbox
  --require-isolation        Refuse to run without a sandbox command
  --workers COUNT            Concurrent project runners (default: 2)
  --batch-size COUNT         Anonymous manifest batch size (default: 200)
  --limit COUNT              Optional maximum number of archives
  --mode build|dev|both      Compatibility checks (default: both)
  --timeout-ms MS            Timeout per project check (default: 30000)
  --retries COUNT            Retry infrastructure/timeouts (default: 1)
  --no-baseline              Disable baseline checks for failed projects
  --retry-failures           Reprocess previously failed terminal records`;
}

function parseArguments(argv) {
  const options = {
    archives: [],
    directories: [],
    manifests: [],
    dependencyLayers: [],
    workers: 2,
    batchSize: 200,
    timeoutMs: 30_000,
    retries: 1,
    mode: "both",
    baseline: true,
    retryFailures: false,
    requireIsolation: false,
    oj: path.join(root, "target", "debug", "oj"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next) throw new Error(`${flag} requires a value`);
      return next;
    };

    switch (flag) {
      case "--archive": options.archives.push(path.resolve(value())); break;
      case "--archives-dir": options.directories.push(path.resolve(value())); break;
      case "--manifest": options.manifests.push(path.resolve(value())); break;
      case "--output-dir": options.output = path.resolve(value()); break;
      case "--dependency-layer": options.dependencyLayers.push(path.resolve(value())); break;
      case "--oj": options.oj = path.resolve(value()); break;
      case "--sandbox-command": options.sandbox = path.resolve(value()); break;
      case "--workers": options.workers = Number(value()); break;
      case "--batch-size": options.batchSize = Number(value()); break;
      case "--limit": options.limit = Number(value()); break;
      case "--timeout-ms": options.timeoutMs = Number(value()); break;
      case "--retries": options.retries = Number(value()); break;
      case "--mode": options.mode = value(); break;
      case "--no-baseline": options.baseline = false; break;
      case "--retry-failures": options.retryFailures = true; break;
      case "--require-isolation": options.requireIsolation = true; break;
      case "--help": console.log(usage()); process.exit(0);
      default: throw new Error(`unknown option: ${flag}`);
    }
  }

  if (!options.output) throw new Error("--output-dir is required");
  if (options.dependencyLayers.length === 0) throw new Error("at least one --dependency-layer is required");
  if (options.requireIsolation && !options.sandbox) throw new Error("isolated execution requires --sandbox-command");
  if (options.sandbox && !fs.existsSync(options.sandbox)) throw new Error("sandbox command was not found");
  if (options.sandbox && options.dependencyLayers.length !== 1) throw new Error("sandbox execution requires one dependency layer");
  if (!fs.existsSync(options.oj)) throw new Error("OJ executable was not found");
  if (!["build", "dev", "both"].includes(options.mode)) throw new Error("invalid campaign mode");
  for (const key of ["workers", "batchSize", "timeoutMs"]) {
    if (!Number.isSafeInteger(options[key]) || options[key] < 1) throw new Error(`${key} must be positive`);
  }
  if (!Number.isSafeInteger(options.retries) || options.retries < 0) throw new Error("retries must be nonnegative");
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw new Error("limit must be positive");
  }
  return options;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readManifest(filename) {
  const directory = path.dirname(filename);
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`invalid manifest record at line ${index + 1}`);
    }
    if (typeof record === "string") record = { archive: record };
    if (!record || typeof record !== "object" || typeof record.archive !== "string") {
      throw new Error(`manifest record ${index + 1} requires an archive`);
    }
    if (record.id !== undefined && (typeof record.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(record.id))) {
      throw new Error(`manifest record ${index + 1} has an invalid anonymous id`);
    }
    return { archive: path.resolve(directory, record.archive), id: record.id };
  });
}

function discoverArchives(options) {
  const records = options.archives.map((archive) => ({ archive }));
  for (const directory of options.directories) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".zip")) {
        records.push({ archive: path.join(directory, entry.name) });
      }
    }
  }
  for (const manifest of options.manifests) records.push(...readManifest(manifest));

  const seen = new Map();
  for (const record of records) {
    if (!record.archive.toLowerCase().endsWith(".zip")) throw new Error("campaign inputs must be ZIP archives");
    if (!fs.statSync(record.archive).isFile()) throw new Error("campaign archive is not a regular file");
    const supplied = record.id;
    const id = supplied && /^[a-f0-9]{16,64}$/i.test(supplied)
      ? supplied.toLowerCase()
      : digest(supplied ?? record.archive).slice(0, 24);
    const existing = seen.get(id);
    if (existing && existing.archive !== record.archive) throw new Error("anonymous archive ids must be unique");
    if (!existing) seen.set(id, { id, archive: record.archive });
  }

  const archives = [...seen.values()].sort((left, right) => left.id.localeCompare(right.id));
  if (archives.length === 0) throw new Error("no ZIP archives were discovered");
  return options.limit ? archives.slice(0, options.limit) : archives;
}

function atomicWrite(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  const descriptor = fs.openSync(temporary, "w");
  try {
    fs.writeFileSync(descriptor, value);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filename);
  const directory = fs.openSync(path.dirname(filename), "r");
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

function restoreJournal(filename) {
  if (!fs.existsSync(filename)) return new Map();
  const content = fs.readFileSync(filename, "utf8");
  const records = new Map();
  const lines = content.split("\n");
  let validBytes = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      if (index < lines.length - 1) validBytes += 1;
      continue;
    }
    try {
      const record = JSON.parse(line);
      if (typeof record.id !== "string") throw new Error("invalid campaign record");
      records.set(record.id, record);
      validBytes += Buffer.byteLength(line) + (index < lines.length - 1 ? 1 : 0);
    } catch {
      if (index !== lines.length - 1) throw new Error("campaign journal contains an invalid record");
      fs.truncateSync(filename, validBytes);
    }
  }
  return records;
}

function sanitize(value) {
  return String(value ?? "")
    .replaceAll(/\u001b\[[0-9;]*m/g, "")
    .replaceAll(/(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi, "<credential>")
    .replaceAll(/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, "<credential>")
    .replaceAll(/https?:\/\/[^\s"'<>]+/gi, "<url>")
    .replaceAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "<email>")
    .replaceAll(/(?:[a-z]:)?(?:\/[\w.@-]+){2,}(?::\d+(?::\d+)?)?/gi, "<path>")
    .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replaceAll(/\b[0-9a-f]{24,}\b/gi, "<id>")
    .replaceAll(/["'`][^"'`\n]{0,240}["'`]/g, "<value>")
    .replaceAll(/\b(?:port|pid)\s*[=:]?\s*\d+\b/gi, "<number>")
    .replaceAll(/:\d+(?::\d+)?\b/g, ":<location>")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

function failureMessage(value, kind, code) {
  const input = String(value ?? "");
  let message;

  if (kind === "missing-dependency") message = "A dependency could not be resolved";
  else if (kind === "incompatible-dependency") message = "A dependency export is incompatible";
  else if (kind === "timeout" || /\btimeout\b|timed out/i.test(input)) message = "The operation exceeded its timeout";
  else if (/vite config|configuration/i.test(input)) message = "The project configuration could not be loaded";
  else if (/syntax|parse|unexpected token/i.test(input)) message = "Source parsing failed";
  else if (/panic|panicked/i.test(input)) message = "The application reported a runtime panic";
  else if (/module/i.test(input)) message = "A project module could not be processed";
  else if (/css|stylesheet/i.test(input)) message = "A project stylesheet could not be processed";
  else if (/html|entry/i.test(input)) message = "A project entry could not be processed";
  else if (/plugin/i.test(input)) message = "A project plugin could not be processed";
  else if (/baseline unavailable/i.test(input)) message = "The compatibility baseline was unavailable";
  else message = "The compatibility check failed";

  return code ? `${message} (${code})` : message;
}

const publicDiagnosticSymbols = [
  ["rolldown", /\brolldown\b/i],
  ["@tanstack/router-generator", /@tanstack\/router-generator\b/i],
  ["@tanstack/react-start", /@tanstack\/react-start\b/i],
  ["@vitejs/plugin-react-swc", /@vitejs\/plugin-react-swc\b/i],
  ["@vitejs/plugin-react", /@vitejs\/plugin-react\b(?!-swc)/i],
  ["postcss", /\bpostcss\b/i],
  ["tailwindcss", /\btailwindcss\b/i],
];

const publicDiagnosticFrames = [
  ["vite-plugin-bridge", /\bvite-plugin-bridge\.mjs\b/i],
  ["rolldown-assets", /\brolldown-assets\.mjs\b/i],
  ["route-generator", /\bgenerate\.mjs\b/i],
  ["server-function-resolver", /\bgen-resolver\.mjs\b/i],
  ["client-bundle", /\bbundle-client\.mjs\b/i],
  ["package-resolver", /\bresolve-pkg\.mjs\b/i],
];

const publicDiagnosticMarkers = [
  ["plugin-transform", /plugin[^\n]{0,120}\btransform\b|\btransform\b[^\n]{0,120}plugin/i],
  ["plugin-resolve", /plugin[^\n]{0,120}\bresolve(?:id)?\b|\bresolve(?:id)?\b[^\n]{0,120}plugin/i],
  ["plugin-load", /plugin[^\n]{0,120}\bload\b|\bload\b[^\n]{0,120}plugin/i],
  ["plugin-build-start", /plugin[^\n]{0,120}\bbuildStart\b|\bbuildStart\b[^\n]{0,120}plugin/i],
  ["route-generation", /route tree generation|router.generator/i],
  ["property-of-nullish", /Cannot read propert(?:y|ies) of (?:undefined|null)/i],
  ["server-exited", /server exited|server reported a fatal startup error/i],
  ["config-load", /failed to load (?:vite )?config|configuration could not be loaded/i],
  ["virtual-module", /virtual module|\bvirtual:/i],
];

const publicNullishProperties = new Set([
  "map", "filter", "name", "options", "plugins", "routes", "config", "consumer", "resolve", "transform", "buildStart",
]);

function publicDiagnosticTaxonomy(check, summary) {
  const input = `${String(summary ?? "")}\n${String(check.output ?? "")}`;
  const errorClass = input.match(/\b(TypeError|ReferenceError|SyntaxError|RangeError|URIError|AggregateError|Error):/)?.[1];
  const markers = publicDiagnosticMarkers.filter(([, expression]) => expression.test(input)).map(([marker]) => marker);
  const publicSymbols = publicDiagnosticSymbols.filter(([, expression]) => expression.test(input)).map(([symbol]) => symbol);
  const internalFrames = publicDiagnosticFrames.filter(([, expression]) => expression.test(input)).map(([frame]) => frame);
  const candidateProperty = input.match(/Cannot read propert(?:y|ies) of (?:undefined|null)\s*\(reading ['"]([\w$]+)['"]\)/i)?.[1];
  const nullishProperty = publicNullishProperties.has(candidateProperty) ? candidateProperty : undefined;
  return {
    ...(errorClass ? { errorClass } : {}),
    ...(markers.length ? { markers } : {}),
    ...(publicSymbols.length ? { publicSymbols } : {}),
    ...(internalFrames.length ? { internalFrames } : {}),
    ...(nullishProperty ? { nullishProperty } : {}),
  };
}

function diagnostic(check, stage, projectKind) {
  if (check.ok) {
    return {
      ok: true,
      ...(Number.isFinite(check.durationMs) ? { durationMs: check.durationMs } : {}),
      ...(Number.isSafeInteger(check.modulesChecked) ? { modulesChecked: check.modulesChecked } : {}),
    };
  }

  const kind = check.diagnostic?.kind ?? "execution-failure";
  const rawMessage = check.diagnostic?.summary ?? check.output ?? "execution failed";
  const candidateCode = String(rawMessage).match(/\b(?:ERR_[A-Z_]+|E[A-Z]{3,}|HTTP\s+\d{3})\b/)?.[0] ?? "";
  const errorCode = stableErrorCodes.has(candidateCode) || /^HTTP\s+[1-5]\d{2}$/.test(candidateCode)
    ? candidateCode : "";
  const message = failureMessage(rawMessage, kind, errorCode);
  const taxonomy = publicDiagnosticTaxonomy(check, rawMessage);
  const structure = sanitize(rawMessage)
    .replaceAll(/\b0x[0-9a-f]+\b/gi, "<number>")
    .replaceAll(/\b\d+\b/g, "<number>")
    .toLowerCase();
  const canonical = [
    "v1", stage, projectKind ?? "unknown", kind, errorCode, message.toLowerCase(),
    ...(kind === "execution-failure" ? [structure, JSON.stringify(taxonomy)] : []),
  ].join("\u0000");
  return {
    ok: false,
    kind,
    message,
    fingerprint: digest(canonical).slice(0, 32),
    ...taxonomy,
    ...(errorCode ? { errorCode } : {}),
    ...(Number.isFinite(check.durationMs) ? { durationMs: check.durationMs } : {}),
  };
}

function readWorkerReport(filename) {
  let descriptor;
  try {
    const listed = fs.lstatSync(filename);
    if (!listed.isFile() || listed.size > maximumReportBytes) return undefined;
    if (typeof fs.constants.O_NOFOLLOW !== "number") return undefined;
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maximumReportBytes) return undefined;
    const content = fs.readFileSync(descriptor, { encoding: "utf8" });
    if (Buffer.byteLength(content) > maximumReportBytes) return undefined;
    return JSON.parse(content);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function invokeAgent(archive, options, baseline) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "oj-campaign-worker-"));
  const report = path.join(temporary, "report.json");
  const forwarded = ["--mode", baseline || options.mode, "--timeout-ms", String(options.timeoutMs)];
  if (baseline) forwarded.push("--baseline-only");
  else if (options.baseline) forwarded.push("--baseline-on-failure");
  let executable;
  let args;
  if (options.sandbox) {
    executable = "sudo";
    args = ["-n", process.execPath, options.sandbox, "--archive", archive, "--dependencies",
      options.dependencyLayers[0], "--output", temporary, "--oj", options.oj, "--", ...forwarded];
  } else {
    executable = process.execPath;
    args = [runner, "--project", archive, "--limit", "1", "--oj", options.oj, "--json", report, ...forwarded];
    for (const layer of options.dependencyLayers) args.push("--dependency-layer", layer);
  }

  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: { ...process.env, NO_COLOR: "1", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timeout = false;
    const capture = (chunk) => { output = (output + chunk.toString()).slice(-8192); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const checkBudget = baseline ? 2 : options.baseline && options.mode === "both" ? 4 :
      options.mode === "both" || (options.baseline && options.mode === "dev") ? 3 : 2;
    const deadline = setTimeout(() => {
      timeout = true;
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
      force.unref();
    }, options.timeoutMs * checkBudget + 10_000);

    let finished = false;
    const finish = (status, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      let parsed = readWorkerReport(report);
      let cleanupError;
      try {
        fs.rmSync(temporary, { recursive: true, force: true });
      } catch (failure) {
        cleanupError = failure;
        if (options.sandbox) {
          const recovered = spawnSync("sudo", ["-n", process.execPath, options.sandbox, "--cleanup-output", temporary], {
            stdio: "ignore",
            timeout: 10_000,
          });
          if (recovered.status === 0) {
            try {
              parsed ??= readWorkerReport(report);
              fs.rmSync(temporary, { recursive: true, force: true });
              cleanupError = undefined;
            } catch (retryFailure) {
              cleanupError = retryFailure;
            }
          }
        }
      }
      resolve({ status, timeout, report: cleanupError ? undefined : parsed,
        error: error?.message ?? cleanupError?.message, output });
    };

    child.once("error", (error) => finish(null, error));
    child.once("close", (status) => finish(status));
  });
}

function failedChecks(result) {
  return Object.entries(result.checks ?? {}).filter(([, check]) => !check.ok);
}

async function evaluate(project, options) {
  let execution;
  let attempt = 0;
  do {
    attempt += 1;
    execution = await invokeAgent(project.archive, options, false);
  } while (attempt <= options.retries && (execution.timeout || !execution.report?.projects?.[0]));

  const observed = execution.report?.projects?.[0];
  if (!observed) {
    const check = diagnostic({ ok: false, output: execution.timeout ? "worker timeout" : execution.error ?? execution.output },
      "worker", "unknown");
    return { id: project.id, status: "infrastructure-failure", attempts: attempt, checks: { worker: check } };
  }

  const checks = Object.fromEntries(Object.entries(observed.checks ?? {})
    .filter(([stage]) => stage !== "baseline")
    .map(([stage, check]) => [stage, diagnostic(check, stage, observed.kind)]));
  const failures = failedChecks({ checks });
  let status = failures.length === 0 ? "passed" : failures.some(([stage]) => stage === "install")
    ? "infrastructure-failure" : "oj-failure";
  const record = { id: project.id, kind: observed.kind, status, attempts: attempt, checks };

  if (status === "oj-failure" && options.baseline) {
    const baseline = observed.checks?.baseline;
    if (baseline) {
      record.baseline = diagnostic(baseline, "baseline", observed.kind);
      if (!baseline.ok) status = "baseline-failure";
    } else {
      record.baseline = diagnostic({ ok: false, output: "baseline unavailable" },
        "baseline", observed.kind);
      status = "infrastructure-failure";
    }
    record.status = status;
  }

  return record;
}

function batchManifests(projects, options) {
  const directory = path.join(options.output, "batches");
  fs.mkdirSync(directory, { recursive: true });
  for (let offset = 0; offset < projects.length; offset += options.batchSize) {
    const records = projects.slice(offset, offset + options.batchSize)
      .map((project, index) => JSON.stringify({ id: project.id, ordinal: offset + index }));
    atomicWrite(path.join(directory, `batch-${String(Math.floor(offset / options.batchSize) + 1).padStart(5, "0")}.jsonl`),
      records.join("\n") + "\n");
  }
}

function summarize(records, discovered) {
  const selected = [...records.values()].filter((record) => discovered.has(record.id));
  const counts = { passed: 0, ojFailures: 0, baselineFailures: 0, infrastructureFailures: 0 };
  const clusters = new Map();

  for (const record of selected) {
    if (record.status === "passed") counts.passed += 1;
    else if (record.status === "oj-failure") counts.ojFailures += 1;
    else if (record.status === "baseline-failure") counts.baselineFailures += 1;
    else counts.infrastructureFailures += 1;

    if (record.status !== "oj-failure") continue;
    for (const [stage, check] of failedChecks(record)) {
      const cluster = clusters.get(check.fingerprint) ?? {
        id: check.fingerprint,
        fingerprint: check.fingerprint,
        stage,
        kind: check.kind,
        message: check.message,
        ...(check.errorClass ? { errorClass: check.errorClass } : {}),
        ...(check.markers ? { markers: check.markers } : {}),
        ...(check.publicSymbols ? { publicSymbols: check.publicSymbols } : {}),
        ...(check.internalFrames ? { internalFrames: check.internalFrames } : {}),
        ...(check.nullishProperty ? { nullishProperty: check.nullishProperty } : {}),
        count: 0,
        occurrences: 0,
        projects: [],
      };
      cluster.count += 1;
      cluster.occurrences += 1;
      if (cluster.projects.length < 3) cluster.projects.push(record.id);
      clusters.set(check.fingerprint, cluster);
    }
  }

  return {
    summary: {
      schemaVersion: 1,
      discovered: discovered.size,
      completed: selected.length,
      pending: discovered.size - selected.length,
      ...counts,
      clusters: clusters.size,
    },
    clusters: {
      schemaVersion: 1,
      clusters: [...clusters.values()].sort((left, right) => right.count - left.count || left.id.localeCompare(right.id)),
    },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  fs.mkdirSync(options.output, { recursive: true });
  const projects = discoverArchives(options);
  const discovered = new Set(projects.map((project) => project.id));
  const journalPath = path.join(options.output, "results.jsonl");
  const records = restoreJournal(journalPath);
  const pending = projects.filter((project) => {
    const previous = records.get(project.id);
    return !previous || (options.retryFailures && previous.status !== "passed");
  });
  batchManifests(projects, options);

  let next = 0;
  const journal = fs.openSync(journalPath, "a");
  try {
    const workers = Array.from({ length: Math.min(options.workers, pending.length) }, async () => {
      while (next < pending.length) {
        const project = pending[next++];
        let record;
        try {
          record = await evaluate(project, options);
        } catch (error) {
          record = {
            id: project.id,
            status: "infrastructure-failure",
            attempts: 1,
            checks: { worker: diagnostic({ ok: false, output: error.message }, "worker", "unknown") },
          };
        }
        fs.writeSync(journal, JSON.stringify(record) + "\n");
        fs.fsyncSync(journal);
        records.set(project.id, record);
        process.stdout.write(`${record.id} ${record.status}\n`);
      }
    });
    await Promise.all(workers);
  } finally {
    fs.closeSync(journal);
    const { summary, clusters } = summarize(records, discovered);
    atomicWrite(path.join(options.output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    atomicWrite(path.join(options.output, "clusters.json"), JSON.stringify(clusters, null, 2) + "\n");
    console.log(`${summary.completed}/${summary.discovered} completed; ${summary.ojFailures} confirmed failures; ${summary.clusters} clusters`);
  }
}

main().catch((error) => {
  console.error(sanitize(error.message));
  process.exitCode = 1;
});
