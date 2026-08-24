// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = {
  archive: undefined,
  dependencies: undefined,
  output: undefined,
  binary: path.join(root, "target", "debug", "oj"),
  uid: 65534,
  gid: 65534,
  timeoutSeconds: 120,
  workspaceMB: 768,
  memoryMB: 1536,
  forwarded: [],
};

function usage() {
  return `Usage: sudo node bench/project-sandbox.mjs --archive FILE --dependencies DIR --output DIR [options] [-- RUNNER_ARGS]

Run one anonymous project archive inside an unprivileged Linux filesystem,
process, and network namespace with immutable runtime and dependency mounts.

  --archive PATH           Anonymous ZIP archive
  --dependencies PATH      Read-only dependency layer
  --output PATH            Private result directory
  --oj PATH                OJ executable
  --uid NUMBER             Unprivileged execution UID (default: 65534)
  --gid NUMBER             Unprivileged execution GID (default: 65534)
  --timeout-seconds NUMBER Whole-project hard timeout (default: 120)
  --workspace-mb NUMBER    Temporary project memory/filesystem limit (default: 768)
  --memory-mb NUMBER       Hard per-project memory limit (default: 1536)
  -- RUNNER_ARGS           Additional arguments passed to project-agent.mjs`;
}

function value(index, flag) {
  const result = process.argv[index + 1];
  if (!result) throw new Error(`${flag} requires a value`);
  return result;
}

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--help" || argument === "-h") {
    console.log(usage());
    process.exit(0);
  }
  if (argument === "--") {
    options.forwarded.push(...process.argv.slice(index + 1));
    break;
  }
  const selected = value(index, argument);
  index += 1;
  if (argument === "--archive") options.archive = path.resolve(selected);
  else if (argument === "--dependencies") options.dependencies = path.resolve(selected);
  else if (argument === "--output") options.output = path.resolve(selected);
  else if (argument === "--oj") options.binary = path.resolve(selected);
  else if (argument === "--uid") options.uid = Number(selected);
  else if (argument === "--gid") options.gid = Number(selected);
  else if (argument === "--timeout-seconds") options.timeoutSeconds = Number(selected);
  else if (argument === "--workspace-mb") options.workspaceMB = Number(selected);
  else if (argument === "--memory-mb") options.memoryMB = Number(selected);
  else throw new Error(`unexpected argument: ${argument}`);
}

function validate() {
  if (process.platform !== "linux") throw new Error("project sandboxing requires Linux");
  if (process.getuid?.() !== 0) throw new Error("run the sandbox supervisor as root; project code is executed without privileges");
  for (const [name, filename] of [["archive", options.archive], ["dependencies", options.dependencies], ["output", options.output]]) {
    if (!filename) throw new Error(`--${name} is required`);
  }
  if (!options.archive.endsWith(".zip")) throw new Error("project input must be a ZIP archive");
  if (!fs.statSync(options.archive).isFile()) throw new Error("archive is not a regular file");
  if (!fs.statSync(options.dependencies).isDirectory()) throw new Error("dependency layer is not a directory");
  if (!fs.statSync(options.binary).isFile()) throw new Error("OJ executable is not a regular file");
  if (fs.lstatSync(options.archive).isSymbolicLink()) throw new Error("archive must not be a symbolic link");
  if (fs.lstatSync(options.dependencies).isSymbolicLink()) throw new Error("dependency layer must not be a symbolic link");
  if (path.basename(fs.realpathSync(options.dependencies)) !== "node_modules") {
    throw new Error("dependency layer must be a dedicated node_modules directory");
  }
  for (const [name, number] of [["uid", options.uid], ["gid", options.gid]]) {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be an unprivileged numeric identifier`);
  }
  if (!Number.isSafeInteger(options.timeoutSeconds) || options.timeoutSeconds < 1) {
    throw new Error("--timeout-seconds must be a positive integer");
  }
  if (!Number.isSafeInteger(options.workspaceMB) || options.workspaceMB < 64 || options.workspaceMB > 4096) {
    throw new Error("--workspace-mb must be between 64 and 4096");
  }
  if (!Number.isSafeInteger(options.memoryMB) || options.memoryMB < 256 || options.memoryMB > 8192) {
    throw new Error("--memory-mb must be between 256 and 8192");
  }
  for (let index = 0; index < options.forwarded.length; index += 1) {
    const argument = options.forwarded[index];
    if (argument === "--baseline") continue;
    if (["--mode", "--timeout-ms", "--probe-modules"].includes(argument)) {
      if (!options.forwarded[++index]) throw new Error(`${argument} requires a value`);
      continue;
    }
    throw new Error(`runner option is not permitted inside the sandbox: ${argument}`);
  }
}

const setup = String.raw`
set -euo pipefail
mount --make-rprivate /
mount -t tmpfs -o "size=$OJ_WORKSPACE_MB"m,nosuid,nodev tmpfs "$OJ_JAIL"
mkdir -p "$OJ_JAIL"/{usr,etc,dev,proc,tmp,work,output,input,runtime/bench,opt/node_modules,opt/bin}

mount --bind /usr "$OJ_JAIL/usr"
mount -o remount,bind,ro "$OJ_JAIL/usr"
for directory in bin sbin lib lib64; do
  if [ -L "/$directory" ]; then
    ln -s "$(readlink "/$directory")" "$OJ_JAIL/$directory"
  elif [ -d "/$directory" ]; then
    mkdir -p "$OJ_JAIL/$directory"
    mount --bind "/$directory" "$OJ_JAIL/$directory"
    mount -o remount,bind,ro "$OJ_JAIL/$directory"
  fi
done

for device in null zero random urandom; do
  touch "$OJ_JAIL/dev/$device"
  mount --bind "/dev/$device" "$OJ_JAIL/dev/$device"
done
chmod 1777 "$OJ_JAIL/tmp"
mkdir -p "$OJ_JAIL/work/home" "$OJ_JAIL/work/tmp"
chown -R "$OJ_UID:$OJ_GID" "$OJ_JAIL/work" "$OJ_JAIL/tmp"

printf 'agent:x:%s:%s:Project Agent:/work/home:/usr/sbin/nologin\n' "$OJ_UID" "$OJ_GID" > "$OJ_JAIL/etc/passwd"
printf 'agent:x:%s:\n' "$OJ_GID" > "$OJ_JAIL/etc/group"
printf '127.0.0.1 localhost\n' > "$OJ_JAIL/etc/hosts"
touch "$OJ_JAIL/etc/resolv.conf"
if [ -d /etc/ssl/certs ]; then
  mkdir -p "$OJ_JAIL/etc/ssl/certs"
  mount --bind /etc/ssl/certs "$OJ_JAIL/etc/ssl/certs"
  mount -o remount,bind,ro "$OJ_JAIL/etc/ssl/certs"
fi

touch "$OJ_JAIL/input/project.zip" "$OJ_JAIL/runtime/bench/project-agent.mjs" "$OJ_JAIL/opt/bin/oj"
mount --bind "$OJ_ARCHIVE" "$OJ_JAIL/input/project.zip"
mount -o remount,bind,ro "$OJ_JAIL/input/project.zip"
mount --bind "$OJ_RUNNER" "$OJ_JAIL/runtime/bench/project-agent.mjs"
mount -o remount,bind,ro "$OJ_JAIL/runtime/bench/project-agent.mjs"
mount --bind "$OJ_BINARY" "$OJ_JAIL/opt/bin/oj"
mount -o remount,bind,ro "$OJ_JAIL/opt/bin/oj"
mount --bind "$OJ_DEPENDENCIES" "$OJ_JAIL/opt/node_modules"
mount -o remount,bind,ro "$OJ_JAIL/opt/node_modules"
mount --bind "$OJ_OUTPUT" "$OJ_JAIL/output"

mount -t proc -o nosuid,nodev,noexec proc "$OJ_JAIL/proc"
ip link set lo up
ulimit -u 256
ulimit -n 1024
ulimit -f 524288
ulimit -t "$OJ_CPU_LIMIT"

exec chroot "$OJ_JAIL" /usr/bin/setpriv \
  --reuid "$OJ_UID" --regid "$OJ_GID" --clear-groups --no-new-privs \
  --inh-caps=-all --ambient-caps=-all --bounding-set=-all \
  /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/work/home \
  TMPDIR=/work/tmp CI=1 NO_COLOR=1 \
  "$OJ_NODE" /runtime/bench/project-agent.mjs \
  --project /input/project.zip --dependency-layer /opt/node_modules \
  --oj /opt/bin/oj --workdir /work/staged --output-dir /output "$@"
`;

function main() {
  validate();
  const outputParent = fs.realpathSync(path.dirname(options.output));
  const temporaryRoots = [os.tmpdir(), "/var/tmp"].map((directory) => fs.realpathSync(directory));
  if (!temporaryRoots.some((directory) => outputParent === directory || outputParent.startsWith(`${directory}/`))) {
    throw new Error("sandbox output must be an existing private directory below a temporary root");
  }
  const invokingUid = process.env.SUDO_UID ? Number(process.env.SUDO_UID) : undefined;
  const invokingGid = process.env.SUDO_GID ? Number(process.env.SUDO_GID) : undefined;
  if (!fs.existsSync(options.output)) {
    fs.mkdirSync(options.output, { mode: 0o700 });
    if (invokingUid !== undefined && invokingGid !== undefined) {
      fs.chownSync(options.output, invokingUid, invokingGid);
    }
  }
  if (fs.lstatSync(options.output).isSymbolicLink()) throw new Error("sandbox output must not be a symbolic link");
  const owner = fs.statSync(options.output);
  if (invokingUid !== undefined && owner.uid !== invokingUid) {
    throw new Error("sandbox output must belong to the invoking unprivileged user");
  }
  if ((owner.mode & 0o077) !== 0 || fs.readdirSync(options.output).length > 0) {
    throw new Error("sandbox output must be an empty private directory");
  }
  const output = fs.realpathSync(options.output);
  const dependenciesPath = fs.realpathSync(options.dependencies);
  if (output === dependenciesPath || output.startsWith(`${dependenciesPath}/`) || dependenciesPath.startsWith(`${output}/`)) {
    throw new Error("sandbox output must not overlap the dependency layer");
  }
  fs.chownSync(options.output, options.uid, options.gid);
  let jail;
  let input;
  try {
    const dependencies = fs.statSync(options.dependencies);
    if ((dependencies.mode & 0o005) !== 0o005) {
      fs.chmodSync(options.dependencies, dependencies.mode | 0o005);
    }
    jail = fs.mkdtempSync(path.join(os.tmpdir(), "oj-project-jail-"));
    input = fs.mkdtempSync(path.join(os.tmpdir(), "oj-project-input-"));
    const stagedArchive = path.join(input, "archive.zip");
    fs.copyFileSync(options.archive, stagedArchive);
    fs.chmodSync(stagedArchive, 0o444);
    const result = spawnSync("systemd-run", [
      "--scope", "--quiet", `--property=MemoryMax=${options.memoryMB}M`, "--property=TasksMax=256",
      "timeout",
      "--signal=TERM", "--kill-after=5s", `${options.timeoutSeconds}s`,
      "unshare", "--mount", "--pid", "--net", "--uts", "--ipc", "--fork", "--kill-child",
      "/bin/bash", "-c", setup, "oj-project-sandbox", ...options.forwarded,
    ], {
      stdio: "inherit",
      env: {
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        OJ_JAIL: jail,
        OJ_ARCHIVE: stagedArchive,
        OJ_DEPENDENCIES: fs.realpathSync(options.dependencies),
        OJ_OUTPUT: fs.realpathSync(options.output),
        OJ_RUNNER: path.join(root, "bench", "project-agent.mjs"),
        OJ_BINARY: fs.realpathSync(options.binary),
        OJ_NODE: process.execPath,
        OJ_UID: String(options.uid),
        OJ_GID: String(options.gid),
        OJ_CPU_LIMIT: String(options.timeoutSeconds),
        OJ_WORKSPACE_MB: String(options.workspaceMB),
      },
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    function reclaim(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) reclaim(filename);
        fs.lchownSync(filename, owner.uid, owner.gid);
      }
    }
    reclaim(options.output);
    fs.chownSync(options.output, owner.uid, owner.gid);
    fs.chmodSync(options.output, owner.mode & 0o777);
    if (jail) fs.rmSync(jail, { recursive: true, force: true });
    if (input) fs.rmSync(input, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
