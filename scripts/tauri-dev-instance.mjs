#!/usr/bin/env node
// Runs `npx tauri dev` on a server port, a Vite port and a data dir the
// caller picks, so a second desktop app can run beside a default one (8899,
// 5173 and the app data dir) without touching its server, database or
// stored session (#336):
//
//   npm run dev:instance -- --server-port 8906 --vite-port 5186 --data-dir scratch.local/instance
//
// The shell takes the server port and data dir from LEGATO_PORT and
// LEGATO_DATA_DIR (src-tauri/src/instance.rs), which it reads only in dev,
// and the frontend finds the server through VITE_SERVER_HOST and
// VITE_SERVER_PORT (src/config/serverHost.ts). The Vite port is in
// tauri.conf.json's devUrl, so this overrides that with `tauri dev
// --config`, together with the beforeDevCommand that starts Vite on it.
// Tauri compiles that config into the binary: starting an instance with a
// different Vite port than the last run from this checkout rebuilds the app
// crate, and nothing else.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const USAGE = "usage: npm run dev:instance -- --server-port <port> --vite-port <port> --data-dir <dir>";

function fail(message) {
  console.error(`dev:instance: ${message}`);
  process.exit(1);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      "server-port": { type: "string" },
      "vite-port": { type: "string" },
      "data-dir": { type: "string" },
    },
  }));
} catch (e) {
  fail(`${e.message}\n${USAGE}`);
}

function port(name) {
  const value = values[name];
  if (value === undefined) fail(`--${name} is missing\n${USAGE}`);
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) fail(`--${name} ${value} isn't a port`);
  return number;
}

const serverPort = port("server-port");
const vitePort = port("vite-port");
if (serverPort === vitePort) fail("the server and Vite need a port each");
if (!values["data-dir"]) fail(`--data-dir is missing\n${USAGE}`);
// npm runs a script from the repo root. INIT_CWD is where it was called
// from, so a relative --data-dir means the directory the caller meant.
const dataDir = path.resolve(process.env.INIT_CWD ?? process.cwd(), values["data-dir"]);

// A second listener on a port that's already held can start without an
// error and still lose 127.0.0.1's requests to the first, so this instance
// would quietly talk to someone else's server or Vite. Checked up front.
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
for (const [name, number] of [["server", serverPort], ["Vite", vitePort]]) {
  if (await answers(number)) fail(`something is already listening on 127.0.0.1:${number}, the ${name} port. Pick another.`);
}

const conf = JSON.parse(readFileSync(path.join(REPO_ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
const { beforeDevCommand } = conf.build;
if (!beforeDevCommand.endsWith("npm run dev")) {
  fail(`tauri.conf.json's beforeDevCommand doesn't end in \`npm run dev\` any more, so Vite's port can't be added to it: ${beforeDevCommand}`);
}
const config = {
  build: {
    devUrl: `http://127.0.0.1:${vitePort}`,
    // --strictPort: a taken port fails rather than moving Vite on to the
    // next one, which may be another instance's.
    beforeDevCommand: `${beforeDevCommand} -- --port ${vitePort} --strictPort`,
  },
};

console.log(`dev:instance: server on ${serverPort}, Vite on ${vitePort}, data dir ${dataDir}`);

// A stop signal has to reach the CLI, Vite and the app together, the way
// Ctrl-C in a terminal reaches the whole job. Sent to the CLI alone, it
// stops Vite but leaves the app, and so the server, running on their ports.
// So the CLI gets a process group of its own, and every stop signal this
// script receives goes to all of it. stdin is left out because a process
// group in the background that reads the terminal is stopped. Windows has
// no process groups, and Ctrl-C there already reaches every process on the
// console.
const ownGroup = process.platform !== "win32";

// The CLI's own entry point, run with this Node: no npx, and so no shell
// on Windows to re-quote the JSON.
const tauri = path.join(REPO_ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js");
const child = spawn(process.execPath, [tauri, "dev", "--config", JSON.stringify(config)], {
  cwd: REPO_ROOT,
  detached: ownGroup,
  stdio: [ownGroup ? "ignore" : "inherit", "inherit", "inherit"],
  env: {
    ...process.env,
    LEGATO_PORT: String(serverPort),
    LEGATO_DATA_DIR: dataDir,
    // The host as well as the port: a .env.local can point Vite at another
    // machine's server, and the process environment beats it.
    VITE_SERVER_HOST: "127.0.0.1",
    VITE_SERVER_PORT: String(serverPort),
  },
});
child.on("error", (e) => fail(`couldn't start the Tauri CLI: ${e.message}`));
// False once nothing in the group is left to signal.
function signalGroup(signal) {
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

if (ownGroup) {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => signalGroup(signal));
}

child.on("exit", async (code, signal) => {
  // The CLI can exit while the app is still stopping its server, or leave
  // Vite behind. Whatever's left of the instance is stopped and waited for,
  // so the ports are free by the time this script returns.
  if (ownGroup && signalGroup("SIGTERM")) {
    for (let i = 0; i < 50 && signalGroup(0); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.exit(code ?? (signal ? 1 : 0));
});
