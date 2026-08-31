import { buildApp } from "./app.js";
import { PORT, SHARED_SECRET } from "./config.js";

if (!SHARED_SECRET) {
  console.warn("RELAY_SHARED_SECRET is not set — no home server will be able to authenticate a tunnel.");
}

const app = buildApp({ sharedSecret: SHARED_SECRET, logger: true });

app.listen({ port: PORT, host: "0.0.0.0" }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
