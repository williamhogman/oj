// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "oj-agent-vm-contract-"));
const binaries = path.join(temporary, "bin");
const marker = path.join(temporary, "resolver-paused");
const resolver = path.join(temporary, "resolver-state");
const log = path.join(temporary, "commands.log");

function executable(name, source) {
  fs.writeFileSync(path.join(binaries, name), source, { mode: 0o755 });
}

function invoke(action, environment = {}) {
  return spawnSync(process.execPath, [path.join(root, "bench", "agent-vm.mjs"), action], {
    cwd: temporary,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binaries}${path.delimiter}${process.env.PATH}`,
      OJ_TEST_LOG: log,
      OJ_TEST_MARKER: marker,
      OJ_TEST_RESOLVER_STATE: resolver,
      ...environment,
    },
  });
}

function commands() {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
}

function reset(state = "active") {
  fs.rmSync(log, { force: true });
  fs.rmSync(marker, { force: true });
  fs.writeFileSync(resolver, state);
}

try {
  fs.mkdirSync(binaries);

  executable("ssh", `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const argument = process.argv.at(-1);
if (!argument.startsWith("bash -lc '") || !argument.endsWith("'")) process.exit(91);
const script = argument.slice(10, -1).replaceAll("'\\\\''", "'")
  .replaceAll("/run/oj-agent-systemd-resolved-paused", process.env.OJ_TEST_MARKER);
const result = spawnSync("/bin/bash", ["-c", script], { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
`);

  executable("sudo", "#!/bin/sh\nexec \"$@\"\n");
  executable("hostname", "#!/bin/sh\nprintf '%s\\n' localhost\n");
  executable("findmnt", "#!/bin/sh\nexit 1\n");
  executable("curl", "#!/bin/sh\nexit 1\n");
  executable("find", "#!/bin/sh\nif [ \"${OJ_TEST_ARCHIVES:-0}\" = 1 ]; then printf '%s\\n' staged.zip; fi\n");

  for (const firewall of ["iptables", "ip6tables"]) {
    executable(firewall, `#!/bin/sh\nprintf '%s %s\\n' '${firewall}' "$*" >> "$OJ_TEST_LOG"\nexit 0\n`);
  }

  executable("systemctl", `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.OJ_TEST_LOG, "systemctl " + args.join(" ") + "\\n");
const action = args[0];
if (action === "is-active") {
  const state = fs.readFileSync(process.env.OJ_TEST_RESOLVER_STATE, "utf8");
  process.exit(state === "active" ? 0 : state === "missing" ? 4 : 3);
}
if (action === "stop") {
  if (process.env.OJ_TEST_STOP_FAIL === "1") process.exit(1);
  fs.writeFileSync(process.env.OJ_TEST_RESOLVER_STATE, "inactive");
  process.exit(0);
}
if (action === "start") {
  if (process.env.OJ_TEST_START_FAIL === "1") process.exit(1);
  if (process.env.OJ_TEST_START_INACTIVE !== "1") {
    fs.writeFileSync(process.env.OJ_TEST_RESOLVER_STATE, "active");
  }
  process.exit(0);
}
process.exit(92);
`);

  reset();
  const isolated = invoke("isolate");
  assert.equal(isolated.status, 0, `isolation failed:\n${isolated.stdout}\n${isolated.stderr}`);
  const isolation = commands();
  assert.ok(isolation.includes("systemctl stop systemd-resolved.service"),
    "an active DNS resolver must stop while customer projects run without network access");
  assert.ok(fs.existsSync(marker), "resolver suspension must persist until networking is safely restored");
  assert.ok(isolation.findIndex((entry) => entry.startsWith("iptables -A OJ_AGENT_EGRESS -j REJECT"))
    < isolation.indexOf("systemctl stop systemd-resolved.service"),
  "IPv4 must already be blocked before stopping the resolver");
  assert.ok(isolation.findIndex((entry) => entry.startsWith("ip6tables -A OJ_AGENT_EGRESS -j REJECT"))
    < isolation.indexOf("systemctl stop systemd-resolved.service"),
  "IPv6 must already be blocked before stopping the resolver");

  fs.rmSync(log, { force: true });
  const restored = invoke("restore-network");
  assert.equal(restored.status, 0, `network restoration failed:\n${restored.stdout}\n${restored.stderr}`);
  const restoration = commands();
  assert.ok(restoration.includes("systemctl start systemd-resolved.service"),
    "trusted dependency downloads require the previously suspended DNS resolver");
  assert.ok(restoration.indexOf("systemctl is-active --quiet systemd-resolved.service")
    < restoration.findIndex((entry) => entry.startsWith("iptables -D OUTPUT")),
  "the resolver must be healthy before IPv4 egress is reopened");
  assert.ok(restoration.indexOf("systemctl is-active --quiet systemd-resolved.service")
    < restoration.findIndex((entry) => entry.startsWith("ip6tables -D OUTPUT")),
  "the resolver must be healthy before IPv6 egress is reopened");
  assert.ok(!fs.existsSync(marker), "successful restoration must clear the resolver suspension marker");

  for (const state of ["inactive", "missing"]) {
    reset(state);
    const unavailable = invoke("isolate");
    assert.equal(unavailable.status, 0,
      `isolation must tolerate an ${state} DNS resolver:\n${unavailable.stdout}\n${unavailable.stderr}`);
    assert.ok(!commands().some((entry) => entry.startsWith("systemctl stop")),
      `an ${state} resolver must not be stopped`);
    fs.rmSync(log, { force: true });
    const unchanged = invoke("restore-network");
    assert.equal(unchanged.status, 0,
      `restoration must tolerate an ${state} resolver:\n${unchanged.stdout}\n${unchanged.stderr}`);
    assert.ok(!commands().some((entry) => entry.startsWith("systemctl start")),
      `an ${state} resolver must retain its original state`);
  }

  fs.renameSync(path.join(binaries, "systemctl"), path.join(binaries, "systemctl.unavailable"));
  reset();
  const unmanaged = invoke("isolate");
  assert.equal(unmanaged.status, 0,
    `isolation must work without a service controller:\n${unmanaged.stdout}\n${unmanaged.stderr}`);
  const unmanagedRestore = invoke("restore-network");
  assert.equal(unmanagedRestore.status, 0,
    `restoration must work without a service controller:\n${unmanagedRestore.stdout}\n${unmanagedRestore.stderr}`);
  fs.renameSync(path.join(binaries, "systemctl.unavailable"), path.join(binaries, "systemctl"));

  reset();
  const failedStop = invoke("isolate", { OJ_TEST_STOP_FAIL: "1" });
  assert.notEqual(failedStop.status, 0, "resolver suspension failures must fail closed");
  assert.ok(commands().some((entry) => entry.startsWith("iptables -A OJ_AGENT_EGRESS -j REJECT")));
  assert.ok(commands().some((entry) => entry.startsWith("ip6tables -A OJ_AGENT_EGRESS -j REJECT")));
  assert.ok(!fs.existsSync(marker), "failed suspension must not leave a misleading restoration marker");

  for (const failure of [{ OJ_TEST_START_FAIL: "1" }, { OJ_TEST_START_INACTIVE: "1" }]) {
    reset("inactive");
    fs.writeFileSync(marker, "");
    const failedRestore = invoke("restore-network", failure);
    assert.notEqual(failedRestore.status, 0, "unhealthy DNS restoration must fail closed");
    assert.ok(fs.existsSync(marker), "failed restoration must preserve its retry marker");
    assert.ok(!commands().some((entry) => entry.startsWith("iptables -D")),
      "IPv4 egress must remain blocked when DNS restoration fails");
    assert.ok(!commands().some((entry) => entry.startsWith("ip6tables -D")),
      "IPv6 egress must remain blocked when DNS restoration fails");
  }

  reset("inactive");
  fs.writeFileSync(marker, "");
  const staged = invoke("restore-network", { OJ_TEST_ARCHIVES: "1" });
  assert.notEqual(staged.status, 0, "network restoration must refuse staged project archives");
  assert.ok(!commands().some((entry) => entry.startsWith("systemctl start")),
    "resolver restoration must not begin before customer archives are scrubbed");
  assert.ok(!commands().some((entry) => entry.startsWith("iptables -D") || entry.startsWith("ip6tables -D")),
    "both firewalls must stay enabled while customer archives remain");

  console.log("AGENT-VM E2E PASSED");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
