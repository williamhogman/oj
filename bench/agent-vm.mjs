// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ojRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = {
  instance: process.env.OJ_VM_INSTANCE ?? "oj-project-agent",
  guestRepo: "oj-project-agent",
  manifests: [],
  archives: [],
  packages: [],
  store: undefined,
  dependencySet: "default",
  output: undefined,
  guestOutput: "/tmp/oj-agent-results",
  forwarded: [],
};

function usage() {
  console.log(`Usage: node bench/agent-vm.mjs ACTION [options] [-- HARNESS_ARGS]

Actions:
  create           Create an Ubuntu VM without host filesystem mounts
  provision        Install the Linux build toolchain and clone OJ
  prepare          Install registry dependencies from sanitized manifests
  isolate          Remove host mounts and block IPv4/IPv6 network egress
  seed             Copy locally cached packages into the isolated VM
  run              Build OJ and test one or more anonymous ZIP archives
  collect          Retrieve a compatibility report and diagnostic logs
  scrub            Delete staged archives before restoring network access
  restore-network  Restore networking after all staged inputs are removed
  doctor           Verify the VM toolchain and filesystem isolation
  sync             Synchronize the current OJ checkout into the VM

Options:
  --instance NAME       Lima instance name (default: oj-project-agent)
  --guest-repo PATH     Guest checkout directory (default: oj-project-agent)
  --manifest PATH       Dependency manifest; repeat as needed
  --archive PATH        Project ZIP archive; repeat as needed
  --package PATH        Locally cached package directory; repeat as needed
  --store PATH          Local pnpm links store for offline package seeding
  --deps NAME           Guest dependency set (default: default)
  --output PATH         Local report output directory
  --guest-output PATH   Guest report output directory
  -- HARNESS_ARGS       Additional arguments passed to project-agent.mjs`);
}

function quote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function command(binary, args, overrides = {}) {
  const result = spawnSync(binary, args, { stdio: "inherit", ...overrides });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${binary} exited with status ${result.status ?? result.signal}`);
}

function sshConfig() {
  return path.join(os.homedir(), ".lima", options.instance, "ssh.config");
}

function remote(script) {
  command("ssh", ["-F", sshConfig(), `lima-${options.instance}`, `bash -lc ${quote(script)}`]);
}

function safeIdentifier(value) {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`unsafe identifier: ${value}`);
  return value;
}

function create() {
  command("limactl", [
    "start", "--name", options.instance, "--vm-type", "vz", "--arch", "aarch64",
    "--cpus", "4", "--memory", "6", "--disk", "30", "--containerd", "none",
    "--mount-none", "--tty=false",
    "template:ubuntu-24.04",
  ]);
}

function provision() {
  remote([
    "set -euo pipefail",
    "sudo apt-get update",
    "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential cmake pkg-config libssl-dev nodejs npm unzip",
    "if ! command -v cargo >/dev/null 2>&1; then curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.95.0; fi",
    "if [ \"$(node -p 'process.versions.node.split(\".\")[0]')\" -lt 22 ]; then sudo npm install -g n; sudo n 24; fi",
    `if [ ! -d ${quote(options.guestRepo)}/.git ]; then git clone https://github.com/raphamorim/oj.git ${quote(options.guestRepo)}; fi`,
  ].join("\n"));
}

function sanitizedManifest() {
  if (options.manifests.length === 0) throw new Error("at least one --manifest is required");
  const dependencies = {};
  const overrides = {};
  for (const filename of options.manifests) {
    const manifest = JSON.parse(fs.readFileSync(filename, "utf8"));
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (typeof version !== "string" || /(?:https?:|git\+|git:|ssh:|file:|link:|workspace:|catalog:)/i.test(version)) {
        throw new Error(`dependency ${name} is not a registry-only version: ${version}`);
      }
      dependencies[name] = version;
    }
    for (const [name, version] of Object.entries(manifest.overrides ?? {})) {
      if (typeof version !== "string" || /(?:https?:|git\+|git:|ssh:|file:|link:|workspace:|catalog:)/i.test(version)) {
        throw new Error(`override ${name} is not a registry-only version: ${version}`);
      }
      overrides[name] = version;
    }
  }
  return JSON.stringify({ name: "project-agent-dependencies", version: "1.0.0", private: true, dependencies, overrides }, null, 2) + "\n";
}

function dependencyDirectory() {
  return `${options.guestRepo}/.agent-deps/${safeIdentifier(options.dependencySet)}`;
}

function packageDirectory(name, requirement) {
  if (!options.store) return null;
  const parts = name.startsWith("@") ? name.split("/") : ["@", name];
  const directory = path.join(options.store, ...parts);
  if (!fs.existsSync(directory)) return null;

  const wantedMajor = requirement?.match(/\d+/)?.[0];
  const versions = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  const ordered = wantedMajor
    ? [...versions.filter((version) => version.startsWith(`${wantedMajor}.`)), ...versions.filter((version) => !version.startsWith(`${wantedMajor}.`))]
    : versions;

  for (const version of ordered) {
    const versionDirectory = path.join(directory, version);
    for (const hash of fs.readdirSync(versionDirectory, { withFileTypes: true })) {
      if (!hash.isDirectory()) continue;
      const candidate = path.join(versionDirectory, hash.name, "node_modules", ...name.split("/"));
      if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    }
  }
  return null;
}

function dependencyClosure() {
  const queue = [];
  for (const filename of options.manifests) {
    const manifest = JSON.parse(fs.readFileSync(filename, "utf8"));
    queue.push(...Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }));
  }
  for (const directory of options.packages) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    queue.push([manifest.name, manifest.version, directory]);
  }

  const selected = new Map();
  const missing = new Set();
  while (queue.length > 0) {
    const [name, requirement, provided] = queue.shift();
    if (selected.has(name)) continue;
    const directory = provided ? fs.realpathSync(provided) : packageDirectory(name, requirement);
    if (!directory) {
      missing.add(name);
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    if (Array.isArray(manifest.os)) {
      const allowed = manifest.os.filter((platform) => !platform.startsWith("!"));
      if (manifest.os.includes("!linux") || (allowed.length > 0 && !allowed.includes("linux"))) {
        continue;
      }
    }
    selected.set(name, directory);
    for (const dependency of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (!selected.has(dependency[0])) queue.push(dependency);
    }
    if (selected.size > 1_500) throw new Error("dependency closure exceeds 1500 packages");
  }
  return { selected, missing };
}

function seed() {
  if (options.manifests.length === 0 && options.packages.length === 0) {
    throw new Error("at least one --manifest or --package is required");
  }
  assertIsolated();
  const { selected, missing } = dependencyClosure();
  if (selected.size === 0) throw new Error("no locally cached packages matched the requested inputs");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "oj-agent-seed-"));

  try {
    for (const [name, directory] of selected) {
      const destination = path.join(temporary, ...name.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(directory, destination, "dir");
    }
    remote(`mkdir -p ${quote(`${dependencyDirectory()}/node_modules`)}`);
    command("rsync", [
      "-azL", "--ignore-existing", "--exclude", "node_modules", "--exclude", ".git",
      "-e", `ssh -F ${quote(sshConfig())}`, `${temporary}/`,
      `lima-${options.instance}:${dependencyDirectory()}/node_modules/`,
    ]);
    console.log(`Seeded ${selected.size} cached package(s) into the offline VM.`);
    if (missing.size > 0) console.log(`${missing.size} package(s) were absent from the local cache.`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function prepare() {
  const checkout = fs.realpathSync(ojRoot);
  for (const filename of options.manifests) {
    const relative = path.relative(checkout, fs.realpathSync(filename));
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("network dependency preparation only accepts checkout manifests; use seed for external manifests");
    }
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "oj-agent-manifest-"));
  try {
    const manifest = path.join(temporary, "package.json");
    fs.writeFileSync(manifest, sanitizedManifest());
    remote([
      "set -euo pipefail",
      "if findmnt -rn -t virtiofs | grep -q .; then echo 'detach host mounts before preparing dependencies' >&2; exit 1; fi",
      `if find ${quote(`${options.guestRepo}/.agent-inputs`)} -type f -print -quit 2>/dev/null | grep -q .; then echo 'remove staged project archives before network dependency preparation' >&2; exit 1; fi`,
      `mkdir -p ${quote(dependencyDirectory())}`,
    ].join("\n"));
    command("rsync", ["-az", "-e", `ssh -F ${quote(sshConfig())}`, manifest,
      `lima-${options.instance}:${dependencyDirectory()}/package.json`]);
    remote([
      "set -euo pipefail",
      `cd ${quote(dependencyDirectory())}`,
      "npm install --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org",
    ].join("\n"));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function isolate() {
  remote([
    "set -euo pipefail",
    "guest_hostname=\"$(hostname)\"",
    "if ! grep -Fq \" $guest_hostname\" /etc/hosts; then sudo sed -i \"s/^127\\.0\\.0\\.1[[:space:]]\\+localhost$/& $guest_hostname/\" /etc/hosts; fi",
    "while IFS= read -r mounted; do sudo umount \"$mounted\"; done < <(findmnt -rn -t virtiofs -o TARGET)",
    "for firewall in iptables ip6tables; do",
    "  sudo $firewall -N OJ_AGENT_EGRESS 2>/dev/null || true",
    "  sudo $firewall -F OJ_AGENT_EGRESS",
    "  sudo $firewall -A OJ_AGENT_EGRESS -o lo -j RETURN",
    "  sudo $firewall -A OJ_AGENT_EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN",
    "  sudo $firewall -A OJ_AGENT_EGRESS -j REJECT",
    "  sudo $firewall -C OUTPUT -j OJ_AGENT_EGRESS 2>/dev/null || sudo $firewall -I OUTPUT 1 -j OJ_AGENT_EGRESS",
    "done",
    "if curl --max-time 3 -fsS https://registry.npmjs.org/ >/dev/null 2>&1; then echo 'external egress is still available' >&2; exit 1; fi",
    "echo 'Project isolation enabled: host mounts removed; IPv4 and IPv6 egress blocked.'",
  ].join("\n"));
}

function restoreNetwork() {
  remote([
    "set -euo pipefail",
    `if find ${quote(`${options.guestRepo}/.agent-inputs`)} -type f -print -quit 2>/dev/null | grep -q .; then echo 'refusing network restoration while project archives remain in the VM' >&2; exit 1; fi`,
    "for firewall in iptables ip6tables; do",
    "  sudo $firewall -D OUTPUT -j OJ_AGENT_EGRESS 2>/dev/null || true",
    "  sudo $firewall -F OJ_AGENT_EGRESS 2>/dev/null || true",
    "  sudo $firewall -X OJ_AGENT_EGRESS 2>/dev/null || true",
    "done",
    "echo 'External network access restored; project mounts remain detached.'",
  ].join("\n"));
}

function scrub() {
  assertIsolated();
  remote([
    "set -euo pipefail",
    `rm -rf ${quote(`${options.guestRepo}/.agent-inputs`)}`,
    "find /tmp -maxdepth 1 -type d -name 'oj-project-agent-*' -exec rm -rf {} +",
    "echo 'Private project archives and staged workspaces removed.'",
  ].join("\n"));
}

function assertIsolated() {
  remote([
    "set -euo pipefail",
    "sudo iptables -C OUTPUT -j OJ_AGENT_EGRESS",
    "sudo ip6tables -C OUTPUT -j OJ_AGENT_EGRESS",
    "if findmnt -rn -t virtiofs | grep -q .; then echo 'host project mounts are still attached' >&2; exit 1; fi",
    "if curl --max-time 3 -fsS https://registry.npmjs.org/ >/dev/null 2>&1; then echo 'external egress is still available' >&2; exit 1; fi",
  ].join("\n"));
}

function stageArchives() {
  if (options.archives.length === 0) throw new Error("at least one --archive is required");
  assertIsolated();
  remote(`mkdir -p ${quote(`${options.guestRepo}/.agent-inputs`)}`);
  const projects = [];
  for (const archive of options.archives) {
    if (!archive.toLowerCase().endsWith(".zip")) throw new Error(`expected a ZIP archive: ${archive}`);
    const filename = safeIdentifier(path.basename(archive));
    command("rsync", ["-az", "-e", `ssh -F ${quote(sshConfig())}`, archive,
      `lima-${options.instance}:${options.guestRepo}/.agent-inputs/${filename}`]);
    projects.push(`.agent-inputs/${filename}`);
  }
  return projects;
}

function sync() {
  if (!fs.existsSync(sshConfig())) throw new Error(`VM SSH config not found: ${sshConfig()}`);
  command("rsync", [
    "-az", "--delete", "--exclude", ".git", "--exclude", "target", "--exclude", "node_modules",
    "--exclude", ".oj-cache", "--exclude", ".agent-deps", "--exclude", ".agent-inputs",
    "-e", `ssh -F ${quote(sshConfig())}`,
    `${ojRoot}/`, `lima-${options.instance}:${options.guestRepo}/`,
  ]);
}

function doctor() {
  remote([
    "set -euo pipefail",
    "uname -sm",
    "node --version",
    "npm --version",
    ". \"$HOME/.cargo/env\"",
    "cargo --version",
    "if findmnt -rn -t virtiofs | grep -q .; then echo 'unexpected host mount detected' >&2; exit 1; fi",
    "df -h /",
  ].join("\n"));
}

function run() {
  sync();
  const projects = stageArchives().flatMap((archive) => ["--project", archive]);
  const dependencyLayer = ["--dependency-layer", `.agent-deps/${safeIdentifier(options.dependencySet)}/node_modules`];
  const outputArgs = ["--output-dir", options.guestOutput];
  const projectArgs = [...projects, ...dependencyLayer, ...outputArgs].map(quote).join(" ");
  const args = options.forwarded.map(quote).join(" ");
  let failure;
  try {
    remote([
      "set -euo pipefail",
      ". \"$HOME/.cargo/env\"",
      `cd ${quote(options.guestRepo)}`,
      "cargo build -p oj -j 3",
      `node bench/project-agent.mjs ${projectArgs} ${args}`,
    ].join("\n"));
  } catch (error) {
    failure = error;
  }
  if (options.output) collect();
  if (failure) throw failure;
}

function collect() {
  if (!options.output) throw new Error("--output is required to collect results");
  fs.mkdirSync(options.output, { recursive: true });
  command("rsync", ["-az", "-e", `ssh -F ${quote(sshConfig())}`,
    `lima-${options.instance}:${options.guestOutput}/`, `${options.output}/`]);
}

let action;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--help" || argument === "-h") {
    usage();
    process.exit(0);
  }
  else if (argument === "--instance") options.instance = process.argv[++index];
  else if (argument === "--guest-repo") options.guestRepo = process.argv[++index];
  else if (argument === "--manifest") options.manifests.push(path.resolve(process.argv[++index]));
  else if (argument === "--archive") options.archives.push(path.resolve(process.argv[++index]));
  else if (argument === "--package") options.packages.push(path.resolve(process.argv[++index]));
  else if (argument === "--store") options.store = path.resolve(process.argv[++index]);
  else if (argument === "--deps") options.dependencySet = process.argv[++index];
  else if (argument === "--output") options.output = path.resolve(process.argv[++index]);
  else if (argument === "--guest-output") options.guestOutput = process.argv[++index];
  else if (argument === "--") options.forwarded.push(...process.argv.slice(++index));
  else if (!action) action = argument;
  else throw new Error(`unexpected argument: ${argument}`);
  if (argument === "--") break;
}

try {
  if (action === "create") create();
  else if (action === "provision") provision();
  else if (action === "prepare") prepare();
  else if (action === "seed") seed();
  else if (action === "isolate") isolate();
  else if (action === "restore-network") restoreNetwork();
  else if (action === "scrub") scrub();
  else if (action === "collect") collect();
  else if (action === "sync") sync();
  else if (action === "doctor") doctor();
  else if (action === "run") run();
  else usage();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
