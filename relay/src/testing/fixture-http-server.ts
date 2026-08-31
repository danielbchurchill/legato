import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface FixtureServerHandle {
  url: string;
  close(): Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

// A real HTTP server standing in for the "home server" role's own local
// target (the thing at localhost:8899 in the real architecture) — tests
// forward to this over a real socket rather than synthesizing a response
// in memory, so the whole chain (fixture -> fake home server -> tunnel ->
// relay -> mobile-client fetch) is exercised with real I/O throughout.
export function startFixtureServer(handler: Handler): Promise<FixtureServerHandle> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("fixture server failed to bind to a port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
