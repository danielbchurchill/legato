#!/usr/bin/env node
// Checks that every way of stopping `npm run dev:instance` leaves nothing
// listening on the instance's server or Vite port (#373):
//
//   node scripts/check-dev-instance-stop.mjs --server-port 8908 --vite-port 5188 --data-dir scratch.local/instance --rebuild
//
// For each stop it starts the instance the way a terminal would, as a job
// in a process group of its own, waits until its server and Vite answer,
// and then sends one of:
//
//   npm     SIGTERM to the `npm run dev:instance` process alone
//   script  SIGTERM to the node script under it (tauri-dev-instance.mjs)
//   group   SIGTERM to the whole job's process group
//   ctrl-c  SIGINT to the job's process group, which is what Ctrl-C does
//
// It passes once npm has exited and neither port answers. --stop picks the
// stops (a comma-separated list; all four by default). --rebuild touches
// src-tauri/src/lib.rs first and waits for `tauri dev` to rebuild and
// restart the app, the way an edit does: the CLI kills the app outright to
// do that, and the server the old app started used to keep the port.
//
// It opens the instance's window each time, and the first run from a fresh
// checkout compiles the app. macOS and Linux only: Windows has no process
// groups or SIGTERM to check.

import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, mkdtempSync, utimesSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const STOPS = ["npm", "script", "group", "ctrl-c"];
const USAGE =
  "usage: node scripts/check-dev-instance-stop.mjs --server-port <port> --vite-port <port> --data-dir <dir>\n" +
  "         [--stop npm,script,group,ctrl-c] [--rebuild]";

function fail(message) {
  console.error(`check-dev-instance-stop: ${message}`);
  process.exit(2);
}

if (process.platform === "win32") fail("Windows has no process groups or SIGTERM to check");

let values;
try {
  ({ values } = parseArgs({
    options: {
      "server-port": { type: "string" },
      "vite-port": { type: "string" },
      "data-dir": { type: "string" },
      stop: { type: "string", default: STOPS.join(",") },
      rebuild: { type: "boolean", default: false },
      // The first run from a fresh checkout compiles the whole app.
      "start-timeout": { type: "string", default: "1200" },
    },
  }));
} catch (e) {
  fail(`${e.message}\n${USAGE}`);
}
for (const name of ["server-port", "vite-port", "data-dir"]) if (!values[name]) fail(`--${name} is missing\n${USAGE}`);
const serverPort = Number(values["server-port"]);
const vitePort = Number(values["vite-port"]);
const dataDir = path.resolve(values["data-dir"]);
const stops = values.stop.split(",").map((s) => s.trim());
for (const stop of stops) if (!STOPS.includes(stop)) fail(`--stop ${stop} isn't one of ${STOPS.join(", ")}`);
const startTimeoutMs = Number(values["start-timeout"]) * 1000;
const logDir = mkdtempSync(path.join(tmpdir(), "legato-dev-instance-stop-"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function answers(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function until(what, timeoutMs, check) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(500);
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
}

// The node script, wherever it sits under npm: npm runs it through `sh -c`,
// which may or may not exec it.
function scriptPid(npmPid) {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
  const below = new Set([npmPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (below.has(row.ppid) && !below.has(row.pid)) {
        below.add(row.pid);
        grew = true;
      }
    }
  }
  const script = rows.find((row) => below.has(row.pid) && row.pid !== npmPid && row.command.includes("tauri-dev-instance.mjs"));
  if (!script) throw new Error(`no tauri-dev-instance.mjs under npm (pid ${npmPid})`);
  return script.pid;
}

async function check(stop) {
  for (const port of [serverPort, vitePort]) {
    if (await answers(port)) throw new Error(`something is already listening on 127.0.0.1:${port} before the instance started`);
  }
  const logFile = path.join(logDir, `${stop}.log`);
  const log = createWriteStream(logFile);
  let output = "";
  // A job of its own, as a terminal starts it: npm leads the process group.
  const job = spawn(
    "npm",
    ["run", "dev:instance", "--", "--server-port", String(serverPort), "--vite-port", String(vitePort), "--data-dir", dataDir],
    { cwd: REPO_ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = new Promise((resolve) => job.once("exit", (code, signal) => resolve({ code, signal })));
  let gone = false;
  exited.then(() => (gone = true));
  for (const stream of [job.stdout, job.stderr]) {
    stream.on("data", (chunk) => {
      log.write(chunk);
      output += chunk.toString();
    });
  }
  const spawns = () => output.split("[server] spawning legato-server").length - 1;
  const running = async (what) => {
    if (gone) throw new Error(`the instance exited while waiting for ${what}; see ${logFile}`);
    return true;
  };

  const problems = [];
  try {
    await until("the instance's server and Vite", startTimeoutMs, async () => {
      await running("it to start");
      return spawns() >= 1 && (await answers(serverPort)) && (await answers(vitePort));
    });
    console.log(`  ${stop}: running (npm pid ${job.pid})`);

    if (values.rebuild) {
      const lib = path.join(REPO_ROOT, "src-tauri", "src", "lib.rs");
      const now = new Date();
      utimesSync(lib, now, now);
      await until("the rebuilt app's server", 600_000, async () => {
        await running("the rebuild");
        return spawns() >= 2 && (await answers(serverPort));
      });
      // Long enough for a server that can't listen to say so.
      await sleep(5_000);
      // The stop is still checked: what it leaves behind is the point.
      if (output.includes(`Is port ${serverPort} in use?`)) {
        problems.push(`after the rebuild, the new app's server couldn't listen: the old app's server still held ${serverPort}`);
      }
      console.log(`  ${stop}: rebuilt and restarted${problems.length ? `, but ${problems[0]}` : ""}`);
    }

    const target = { npm: job.pid, script: scriptPid(job.pid), group: -job.pid, "ctrl-c": -job.pid }[stop];
    const signal = stop === "ctrl-c" ? "SIGINT" : "SIGTERM";
    process.kill(target, signal);
    const result = await Promise.race([exited, sleep(30_000).then(() => null)]);
    if (!result) throw new Error(`npm hadn't exited 30 s after the ${signal}`);

    const left = [];
    for (const [name, port] of [["server", serverPort], ["Vite", vitePort]]) {
      // A listener that's on its way out can take a moment to close.
      const deadline = Date.now() + 5_000;
      while ((await answers(port)) && Date.now() < deadline) await sleep(250);
      if (await answers(port)) left.push(`the ${name} port, ${port}`);
    }
    if (left.length) problems.push(`something still listens on ${left.join(" and ")} after the ${signal}`);
    if (problems.length) throw new Error(`${problems.join("; ")}; see ${logFile}`);
    console.log(`  ${stop}: PASS (npm exited ${result.signal ?? result.code}, both ports free)`);
    return true;
  } catch (e) {
    console.log(`  ${stop}: FAIL: ${e.message}`);
    // Whatever of the job is still running is stopped, so the next check
    // starts clean. A server that outlived its app isn't in this group, and
    // is reported above for whoever runs this to find.
    if (!gone) {
      try {
        process.kill(-job.pid, "SIGTERM");
      } catch {}
      await Promise.race([exited, sleep(10_000)]);
    }
    return false;
  } finally {
    log.end();
  }
}

const rebuilding = values.rebuild ? ", rebuilding first" : "";
console.log(`check-dev-instance-stop: server ${serverPort}, Vite ${vitePort}, data dir ${dataDir}${rebuilding}`);
console.log(`  logs in ${logDir}`);
let failed = 0;
for (const stop of stops) if (!(await check(stop))) failed++;
const summary = failed ? `${failed} of ${stops.length} failed` : `all ${stops.length} passed`;
console.log(`check-dev-instance-stop: ${summary}`);
process.exit(failed ? 1 : 0);
