// Prints one new legato.fm token-signing key (issue #114), as the JSON
// entry RELAY_SIGNING_KEYS holds. See src/signing-keys.ts for the format
// and the rotation steps.
//
//   bun relay/scripts/generate-signing-key.ts
//
// First key: wrap the printed entry in [ ] and set that as the secret:
//   fly secrets set RELAY_SIGNING_KEYS='[<entry>]' --app legato-relay
// Rotation: append the entry second, wait over a day, then move it first.
//
// The private key goes to stdout only, for you to paste into the secret.
// Don't redirect it into a file in the repo.
import { generateKeyPairSync } from "node:crypto";
import { publicJwk } from "../src/signing-keys.js";

const { privateKey } = generateKeyPairSync("ed25519");
const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
console.log(JSON.stringify({ privateKey: pem }));
console.error(`kid ${publicJwk(privateKey).kid}`);
