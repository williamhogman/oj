// SPDX-License-Identifier: MIT

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ojRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage: node bench/project-agent.mjs [--project PATH | --projects-dir PATH] [options]

  --project PATH             Test a project directory or ZIP archive; repeat as needed
  --projects-dir PATH        Discover project directories and ZIP archives
  --filter TEXT              Restrict discovered projects by name; repeat as needed
  --limit COUNT              Maximum discovered projects (default: 8)
  --mode build|dev|both      Compatibility checks to run (default: both)
  --install                  Install each project's actual npm dependencies
  --dependency-layer PATH    Reuse an existing node_modules directory
  --baseline                 Also run the project's Vite production build
  --baseline-only            Run only the matching Vite production build or dev server
  --baseline-on-failure      Verify failed OJ checks against Vite in the same project run
  --output-dir PATH          Write report.json and per-project diagnostic logs
  --oj PATH                  OJ executable (default: target/debug/oj)
  --workdir PATH             Keep staged projects in a stable directory
  --timeout-ms MS            Timeout per build/dev check (default: 90000)
  --install-timeout-ms MS    Timeout per npm installation (default: 480000)
  --probe-modules COUNT      Maximum dev modules to validate (default: 16)
  --json PATH                Write machine-readable compatibility results
  --keep                     Preserve temporary staged projects
  --list                     Only list discovered projects`;
}

function parseArgs(argv) {
  const options = {
    projects: [],
    projectsDirs: [],
    filters: [],
    dependencyLayers: [],
    limit: 8,
    mode: "both",
    timeoutMs: 90_000,
    installTimeoutMs: 480_000,
    probeModules: 16,
    install: false,
    baseline: false,
    baselineOnly: false,
    baselineOnFailure: false,
    keep: false,
    list: false,
    oj: path.join(ojRoot, "target", "debug", "oj"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next) throw new Error(`${flag} requires a value`);
      return next;
    };

    switch (flag) {
      case "--project": options.projects.push(path.resolve(value())); break;
      case "--projects-dir": options.projectsDirs.push(path.resolve(value())); break;
      case "--filter": options.filters.push(value()); break;
      case "--dependency-layer": options.dependencyLayers.push(path.resolve(value())); break;
      case "--limit": options.limit = Number(value()); break;
      case "--mode": options.mode = value(); break;
      case "--timeout-ms": options.timeoutMs = Number(value()); break;
      case "--install-timeout-ms": options.installTimeoutMs = Number(value()); break;
      case "--probe-modules": options.probeModules = Number(value()); break;
      case "--oj": options.oj = path.resolve(value()); break;
      case "--workdir": options.workdir = path.resolve(value()); break;
      case "--json": options.json = path.resolve(value()); break;
      case "--output-dir": options.outputDir = path.resolve(value()); break;
      case "--install": options.install = true; break;
      case "--baseline": options.baseline = true; break;
      case "--baseline-only": options.baseline = true; options.baselineOnly = true; break;
      case "--baseline-on-failure": options.baselineOnFailure = true; break;
      case "--keep": options.keep = true; break;
      case "--list": options.list = true; break;
      case "--help": console.log(usage()); process.exit(0);
      default: throw new Error(`unknown option: ${flag}`);
    }
  }

  if (options.projects.length === 0 && options.projectsDirs.length === 0) {
    throw new Error("at least one --project or --projects-dir is required");
  }
  if (options.baselineOnFailure && (options.baseline || options.baselineOnly)) {
    throw new Error("--baseline-on-failure cannot be combined with --baseline or --baseline-only");
  }
  if (!["build", "dev", "both"].includes(options.mode)) throw new Error(`invalid mode: ${options.mode}`);
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) throw new Error("--limit must be positive");
  if (!Number.isSafeInteger(options.probeModules) || options.probeModules < 1) {
    throw new Error("--probe-modules must be positive");
  }
  return options;
}

function classifyProject(directory) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  } catch {
    return null;
  }

  const config = ["vite.config.ts", "vite.config.mts", "vite.config.mjs", "vite.config.js"]
    .find((candidate) => fs.existsSync(path.join(directory, candidate)));
  if (!config) return null;

  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  if (dependencies["@tanstack/react-start"]) return "tanstack-start";
  if (dependencies["solid-js"] && !dependencies.react) return null;
  if (dependencies.react) return "react-vite";
  if (fs.existsSync(path.join(directory, "index.html"))) return "html-vite";
  return null;
}

function discoverProjects(options) {
  const inputs = options.projects.map((source) => ({ source, explicit: true }));
  for (const directory of options.projectsDirs) {
    if (!fs.existsSync(directory)) throw new Error(`projects directory not found: ${directory}`);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() || (entry.isFile() && entry.name.toLowerCase().endsWith(".zip"))) {
        inputs.push({ source: path.join(directory, entry.name), explicit: false });
      }
    }
  }

  const projects = inputs.map(({ source, explicit }) => {
      if (!fs.existsSync(source)) throw new Error(`project not found: ${source}`);
      const archive = fs.statSync(source).isFile();
      if (archive && !source.toLowerCase().endsWith(".zip")) {
        if (explicit) throw new Error(`unsupported project archive: ${source}`);
        return null;
      }
      const kind = archive ? "archive" : classifyProject(source);
      if (!kind) {
        if (explicit) throw new Error(`unsupported project directory: ${source}`);
        return null;
      }
      return { name: path.basename(source, archive ? path.extname(source) : undefined), source, kind, archive };
    })
    .filter(Boolean)
    .filter((project) => options.filters.length === 0 || options.filters.some((filter) => project.name.includes(filter)))
    .sort((left, right) => {
      const score = (project) => project.name.endsWith("_current") ? 0 : 1;
      return score(left) - score(right) || left.name.localeCompare(right.name);
    });

  return projects.slice(0, options.limit);
}

function extractArchive(archive, destination) {
  const listing = runCommand("unzip", ["-Z1", archive], { cwd: ojRoot, timeout: 30_000 });
  if (!listing.ok) throw new Error(`cannot inspect ZIP archive: ${listing.output}`);
  const entries = listing.output.split("\n").filter(Boolean);
  if (entries.length > 20_000) throw new Error(`ZIP archive contains too many entries: ${entries.length}`);

  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) {
      throw new Error(`unsafe ZIP archive entry: ${entry}`);
    }
  }

  const permissions = runCommand("unzip", ["-Z", "-l", archive], { cwd: ojRoot, timeout: 30_000 });
  if (!permissions.ok) throw new Error(`cannot inspect ZIP permissions: ${permissions.output}`);
  if (permissions.output.split("\n").some((line) => /^l[rwx-]{9}\s/.test(line))) {
    throw new Error("ZIP archives containing symbolic links are not supported");
  }
  const size = permissions.output.match(/(\d+)\s+bytes\s+uncompressed/);
  if (size && Number(size[1]) > 512 * 1024 * 1024) {
    throw new Error(`ZIP archive exceeds the 512 MiB uncompressed limit: ${size[1]} bytes`);
  }

  fs.mkdirSync(destination, { recursive: true });
  const extraction = runCommand("unzip", ["-qq", archive, "-d", destination], {
    cwd: ojRoot,
    timeout: 90_000,
  });
  if (!extraction.ok) throw new Error(`cannot extract ZIP archive: ${extraction.output}`);

  if (fs.existsSync(path.join(destination, "package.json"))) return destination;
  const children = fs.readdirSync(destination, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "__MACOSX");
  if (children.length === 1 && fs.existsSync(path.join(destination, children[0].name, "package.json"))) {
    return path.join(destination, children[0].name);
  }
  throw new Error("ZIP archive must contain one project with a package.json");
}

function linkDependency(source, destination) {
  if (fs.existsSync(destination)) return;
  let resolved;
  try {
    resolved = fs.realpathSync(source);
  } catch {
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(resolved, destination, "dir");
}

function linkDependencyLayers(destination, layers) {
  fs.mkdirSync(destination, { recursive: true });
  for (const layer of layers) {
    if (!fs.existsSync(layer)) continue;
    for (const entry of fs.readdirSync(layer, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".bin") continue;
      const source = path.join(layer, entry.name);
      if (entry.name.startsWith("@") && entry.isDirectory()) {
        for (const scoped of fs.readdirSync(source)) {
          linkDependency(path.join(source, scoped), path.join(destination, entry.name, scoped));
        }
      } else {
        linkDependency(source, path.join(destination, entry.name));
      }
    }
  }
}

function stageProject(project, workdir, options) {
  let destination = path.join(workdir, project.name);
  if (!fs.existsSync(destination)) {
    if (project.archive) {
      destination = extractArchive(project.source, destination);
    } else {
      fs.cpSync(project.source, destination, {
        recursive: true,
        filter: (source) => !["node_modules", ".git", ".oj-cache", "dist", ".output"]
          .includes(path.basename(source)),
      });
    }
  }

  if (project.archive) {
    project.kind = classifyProject(destination);
    if (!project.kind) throw new Error("ZIP archive does not contain a supported Vite project");
  }

  if (options.install) {
    if (!fs.existsSync(path.join(destination, "node_modules", ".package-lock.json"))) {
      const installation = runCommand("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline"], {
        cwd: destination,
        timeout: options.installTimeoutMs,
      });
      if (!installation.ok) throw new Error(`npm install failed: ${installation.output}`);
    }
  } else {
    if (options.dependencyLayers.length === 0) throw new Error("pass --install or at least one --dependency-layer");
    linkDependencyLayers(path.join(destination, "node_modules"), options.dependencyLayers);
  }

  return destination;
}

function runCommand(command, args, { cwd, timeout }) {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", CI: "1" },
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    signal: result.signal,
    durationMs: Math.round(performance.now() - started),
    output: [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n").trim(),
  };
}

function runBuild(project, directory, options) {
  const output = path.join(directory, ".oj-dist");
  const args = ["build", directory];
  if (project.kind !== "tanstack-start") args.push("--out", output);
  const result = runCommand(options.oj, args, { cwd: ojRoot, timeout: options.timeoutMs });
  const outputDirectory = project.kind === "tanstack-start" ? path.join(directory, "dist") : output;
  if (result.ok && !fs.existsSync(outputDirectory)) {
    result.ok = false;
    result.output += `\nexpected build output is missing: ${outputDirectory}`;
  }
  return result;
}

function runBaseline(directory, options) {
  return runCommand(path.join(directory, "node_modules", ".bin", "vite"), ["build", "--outDir", path.join(directory, ".vite-dist")], {
    cwd: directory,
    timeout: options.timeoutMs,
  });
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function importSpecifiers(source) {
  const matcher = /(?:\bimport\s*(?:[^;\n]*?\s+from\s*)?|\bexport\s+[^;\n]*?\s+from\s*|\bimport\s*\()\s*["']([^"']+)["']/g;
  return [...source.matchAll(matcher)].map((match) => match[1]);
}

async function probeModuleGraph(origin, entry, limit) {
  const queue = [new URL(entry, origin)];
  const visited = new Set();

  while (queue.length > 0 && visited.size < limit) {
    const current = queue.shift();
    if (current.origin !== origin.origin || visited.has(current.href)) continue;
    visited.add(current.href);

    const response = await fetch(current, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`module ${current.pathname} returned HTTP ${response.status}`);
    const source = await response.text();
    if (!source.trim()) throw new Error(`module ${current.pathname} was empty`);

    for (const specifier of importSpecifiers(source)) {
      if (/^(?:data:|blob:|node:|https?:\/\/)/.test(specifier)) continue;
      if (!specifier.startsWith("/") && !specifier.startsWith(".")) {
        throw new Error(`unresolved bare import ${JSON.stringify(specifier)} in ${current.pathname}`);
      }
      queue.push(new URL(specifier, current));
    }
  }

  return visited.size;
}

async function runDev(project, directory, options, baseline = false) {
  const started = performance.now();
  let port;
  try {
    port = await reservePort();
  } catch (error) {
    return { ok: false, durationMs: Math.round(performance.now() - started), output: error.message };
  }
  const executable = baseline ? path.join(directory, "node_modules", ".bin", "vite") : options.oj;
  const args = baseline
    ? ["--host", "127.0.0.1", "--port", String(port), "--strictPort"]
    : ["dev", directory, "--port", String(port), "--host=127.0.0.1"];
  const child = spawn(executable, args, {
    cwd: baseline ? directory : ojRoot,
    env: { ...process.env, NO_COLOR: "1", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  try {
    const deadline = Date.now() + options.timeoutMs;
    let response;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`dev server exited with status ${child.exitCode}`);
      try {
        response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3_000) });
        if (response.ok || response.status >= 500) break;
      } catch {}
      if (/SSR plugin bridge closed|failed to load Vite config/.test(output)) {
        throw new Error("dev server reported a fatal startup error");
      }
      await delay(150);
    }

    if (response && !response.ok) {
      throw new Error(`dev server returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    if (!response) throw new Error(`dev server did not become healthy within ${options.timeoutMs}ms`);
    const html = await response.text();
    if (!/<html\b/i.test(html)) throw new Error(`dev server did not return HTML: ${html.slice(0, 240)}`);

    let modulesChecked = 0;
    if (project.kind !== "tanstack-start") {
      const entry = html.match(/<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=["']([^"']+)["'])[^>]*>/i)?.[1];
      if (!entry) throw new Error("dev HTML does not contain a module script entry");
      modulesChecked = await probeModuleGraph(new URL(`http://127.0.0.1:${port}/`), entry, options.probeModules);
    }

    return { ok: true, durationMs: Math.round(performance.now() - started), modulesChecked, output: output.trim() };
  } catch (error) {
    return {
      ok: false,
      durationMs: Math.round(performance.now() - started),
      output: [error.message, output.trim()].filter(Boolean).join("\n"),
    };
  } finally {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

function summarizeFailure(output) {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /(?:Error:|error:|failed|cannot resolve|Could not resolve|not found)/i.test(line))
    ?? lines.at(-1)
    ?? "unknown failure";
}

function diagnose(result) {
  if (result.ok) return result;
  const output = result.output.replaceAll(/\u001b\[[0-9;]*m/g, "");
  const dependencies = new Set();
  for (const match of output.matchAll(/(?:Could not resolve(?: import)?|Cannot find package|Cannot find module|Can't resolve|unresolved bare import|failed to resolve import)\s+["']([^"']+)["']/gi)) {
    dependencies.add(match[1]);
  }
  const incompatible = output.includes("ERR_PACKAGE_PATH_NOT_EXPORTED");
  if (incompatible) {
    const match = output.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json/);
    if (match) dependencies.add(match[1]);
  }
  result.diagnostic = {
    kind: incompatible ? "incompatible-dependency" : dependencies.size > 0 ? "missing-dependency" : /timeout|timed out|within \d+ms/i.test(output) ? "timeout" : "execution-failure",
    summary: summarizeFailure(output),
    ...(dependencies.size > 0 ? { dependencies: [...dependencies].sort() } : {}),
  };
  return result;
}

function writeOutput(report, directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  for (const project of report.projects) {
    const safeName = project.name.replaceAll(/[^A-Za-z0-9._-]/g, "_");
    const projectDirectory = path.join(directory, "projects", safeName);
    fs.mkdirSync(projectDirectory, { recursive: true });
    for (const [name, result] of Object.entries(project.checks)) {
      fs.writeFileSync(path.join(projectDirectory, `${name}.log`), (result.output ?? "") + "\n");
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projects = discoverProjects(options);
  if (projects.length === 0) throw new Error("no compatible projects were discovered");

  if (options.list) {
    for (const project of projects) console.log(`${project.kind.padEnd(16)} ${project.name}`);
    return;
  }

  if (!fs.existsSync(options.oj)) throw new Error(`OJ binary not found: ${options.oj}; run cargo build -p oj`);

  const temporary = !options.workdir;
  const workdir = options.workdir ?? fs.mkdtempSync(path.join(os.tmpdir(), "oj-project-agent-"));
  fs.mkdirSync(workdir, { recursive: true });
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: `${os.platform()}/${os.arch()}`,
    oj: options.oj,
    workdir,
    projects: [],
  };

  console.log(`OJ project compatibility: ${projects.length} projects on ${report.platform}`);
  console.log(`Staging: ${workdir}`);

  try {
    for (const project of projects) {
      process.stdout.write(`\n${project.name} (${project.kind})\n`);
      const result = { name: project.name, kind: project.kind, checks: {} };
      report.projects.push(result);

      let directory;
      try {
        directory = stageProject(project, workdir, options);
      } catch (error) {
        result.checks.install = diagnose({ ok: false, output: error.message });
        console.log(`  FAIL install  ${summarizeFailure(error.message)}`);
        continue;
      }

      result.kind = project.kind;
      if (options.baseline) {
        result.checks.baseline = diagnose(
          options.baselineOnly && options.mode === "dev"
            ? await runDev(project, directory, options, true)
            : runBaseline(directory, options),
        );
        const baseline = result.checks.baseline;
        console.log(`  ${baseline.ok ? "PASS" : "FAIL"} vite   ${baseline.durationMs}ms${baseline.ok ? "" : `  ${summarizeFailure(baseline.output)}`}`);
      }

      if (!options.baselineOnly && options.mode !== "dev") {
        result.checks.build = diagnose(runBuild(project, directory, options));
        const build = result.checks.build;
        console.log(`  ${build.ok ? "PASS" : "FAIL"} build  ${build.durationMs}ms${build.ok ? "" : `  ${summarizeFailure(build.output)}`}`);
      }

      if (!options.baselineOnly && options.mode !== "build") {
        result.checks.dev = diagnose(await runDev(project, directory, options));
        const dev = result.checks.dev;
        console.log(`  ${dev.ok ? "PASS" : "FAIL"} dev    ${dev.durationMs}ms${dev.ok ? "" : `  ${summarizeFailure(dev.output)}`}`);
      }

      if (options.baselineOnFailure && Object.values(result.checks).some((check) => !check.ok)) {
        result.checks.baseline = diagnose(runBaseline(directory, options));
        if (result.checks.baseline.ok && project.kind === "tanstack-start" &&
          result.checks.dev?.ok === false && result.checks.build?.ok !== false) {
          result.checks.baseline = diagnose(await runDev(project, directory, options, true));
        }
        const baseline = result.checks.baseline;
        console.log(`  ${baseline.ok ? "PASS" : "FAIL"} vite   ${baseline.durationMs}ms${baseline.ok ? "" : `  ${summarizeFailure(baseline.output)}`}`);
      }
    }
  } finally {
    const checks = report.projects.flatMap((project) => Object.values(project.checks));
    report.summary = {
      projects: report.projects.length,
      checks: checks.length,
      passed: checks.filter((check) => check.ok).length,
      failed: checks.filter((check) => !check.ok).length,
    };

    if (options.json) {
      fs.mkdirSync(path.dirname(options.json), { recursive: true });
      fs.writeFileSync(options.json, JSON.stringify(report, null, 2) + "\n");
    }
    if (options.outputDir) writeOutput(report, options.outputDir);

    console.log(`\n${report.summary.passed}/${report.summary.checks} checks passed across ${report.summary.projects} projects`);
    if (temporary && !options.keep) fs.rmSync(workdir, { recursive: true, force: true });
    if (report.summary.failed > 0) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
