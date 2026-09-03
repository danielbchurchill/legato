import { buildApp } from "./app.js";
import { PORT } from "./config.js";
import { openDb } from "./db.js";

const db = openDb();
const app = buildApp({ db, logger: true });

app.listen({ port: PORT, host: "0.0.0.0" }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
