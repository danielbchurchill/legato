import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "bun:test";
import { stopWhenStdinCloses } from "./stdinLifeline.js";

// Issue #373: a server whose desktop app is gone stops, however the app went.

describe("stopWhenStdinCloses", () => {
  it("leaves stdin alone unless LEGATO_EXIT_ON_STDIN_CLOSE=1", () => {
    for (const value of [undefined, "", "0", "true"]) {
      const env = value === undefined ? {} : { LEGATO_EXIT_ON_STDIN_CLOSE: value };
      const stdin = new PassThrough();
      let stops = 0;
      expect(stopWhenStdinCloses(() => stops++, env, stdin)).toBe(false);
      // Never read, so a terminal's or Docker's stdin is untouched.
      expect(stdin.readableFlowing).toBeNull();
      stdin.destroy();
      expect(stops).toBe(0);
    }
  });

  it("stops once when stdin ends", async () => {
    const stdin = new PassThrough();
    let stops = 0;
    expect(stopWhenStdinCloses(() => stops++, { LEGATO_EXIT_ON_STDIN_CLOSE: "1" }, stdin)).toBe(true);
    stdin.write("anything the app might write is ignored");
    await Bun.sleep(10);
    expect(stops).toBe(0);
    stdin.end();
    await new Promise((resolve) => stdin.once("close", resolve));
    expect(stops).toBe(1);
  });

  it("stops once when stdin fails", async () => {
    const stdin = new PassThrough();
    let stops = 0;
    stopWhenStdinCloses(() => stops++, { LEGATO_EXIT_ON_STDIN_CLOSE: "1" }, stdin);
    stdin.destroy(new Error("EBADF"));
    await new Promise((resolve) => stdin.once("close", resolve));
    expect(stops).toBe(1);
  });

  // Stands in for the server: watches its stdin the way index.ts does.
  const serverLike = `
    import { stopWhenStdinCloses } from ${JSON.stringify(path.join(import.meta.dir, "stdinLifeline.ts"))};
    stopWhenStdinCloses(() => process.kill(process.pid, "SIGTERM"));
    setInterval(() => {}, 1000);
    console.log("watching " + process.pid);
  `;

  // The part the app relies on: a real pipe's other end closing reaches a
  // Bun process as the end of its stdin.
  const child = (env: Record<string, string>) => {
    const proc = Bun.spawn([process.execPath, "-e", serverLike], { stdin: "pipe", stdout: "pipe", env: { ...process.env, ...env } });
    const ready = proc.stdout.getReader().read();
    return { proc, ready };
  };

  // End to end: an app that starts the server the way server_process.rs
  // does, in a process group of its own with a piped stdin the app holds,
  // and is then SIGKILLed, as `tauri dev` does to rebuild. The server
  // inherits the test's end of the app's stdout, so that pipe ends when the
  // server is gone, whether or not anything has reaped it yet.
  async function killTheApp(variable: string) {
    const app = `
      import { spawn } from "node:child_process";
      spawn(process.execPath, ["-e", ${JSON.stringify(serverLike)}], {
        detached: true,
        stdio: ["pipe", "inherit", "inherit"],
        env: { ...process.env, LEGATO_EXIT_ON_STDIN_CLOSE: ${JSON.stringify(variable)} },
      });
      setInterval(() => {}, 1000);
    `;
    const parent = Bun.spawn([process.execPath, "-e", app], { stdin: "ignore", stdout: "pipe" });
    const reader = parent.stdout.getReader();
    const first = await reader.read();
    const serverPid = Number(new TextDecoder().decode(first.value).match(/watching (\d+)/)?.[1]);
    parent.kill("SIGKILL");
    await parent.exited;
    const killedAt = Date.now();
    const ended = (async () => {
      while (!(await reader.read()).done);
      return Date.now() - killedAt;
    })();
    return { serverPid, ended };
  }

  it("stops a server within 5 s of its app being SIGKILLed", async () => {
    const { serverPid, ended } = await killTheApp("1");
    try {
      expect(serverPid).toBeGreaterThan(0);
      const after = await Promise.race([ended, Bun.sleep(5_000).then(() => null)]);
      expect(after).not.toBeNull();
      expect(after!).toBeLessThan(5_000);
    } finally {
      try {
        process.kill(serverPid, "SIGKILL");
      } catch {}
    }
  });

  it("leaves a server without the variable running when its app is SIGKILLed", async () => {
    // So the pipe ending above is the server stopping, and not the app's
    // death closing it.
    const { serverPid, ended } = await killTheApp("");
    try {
      expect(serverPid).toBeGreaterThan(0);
      expect(await Promise.race([ended, Bun.sleep(1_000).then(() => null)])).toBeNull();
      expect(() => process.kill(serverPid, 0)).not.toThrow();
    } finally {
      try {
        process.kill(serverPid, "SIGKILL");
      } catch {}
      await ended;
    }
  });

  it("has a server take its stdin closing as a SIGTERM", async () => {
    const { proc, ready } = child({ LEGATO_EXIT_ON_STDIN_CLOSE: "1" });
    try {
      expect(new TextDecoder().decode((await ready).value)).toContain("watching");
      proc.stdin.end();
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
      expect(exited).toBe(true);
      expect(proc.signalCode).toBe("SIGTERM");
    } finally {
      proc.kill("SIGKILL");
    }
  });

  it("keeps a server running whose stdin closes without the variable", async () => {
    const { proc, ready } = child({ LEGATO_EXIT_ON_STDIN_CLOSE: "" });
    try {
      expect(new TextDecoder().decode((await ready).value)).toContain("watching");
      proc.stdin.end();
      await Bun.sleep(500);
      expect(proc.exitCode).toBeNull();
      expect(proc.signalCode).toBeNull();
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  });
});
