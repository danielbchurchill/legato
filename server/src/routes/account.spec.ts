import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { FastifyInstance } from "fastify";
import { installPictures, Pictures } from "../account/pictures.js";
import { makeImage } from "../account/test-images.js";
import { fakeLegatoFetch, makeTestKey, signTestToken, testClaims, TEST_ISSUER, type LegatoReport } from "../auth/legato-test-keys.js";
import { installLegatoIdentity, LegatoIdentity } from "../auth/legatoIdentity.js";
import { buildTestApp, createOwnerForTest } from "../auth/test-app.js";
import { openDb } from "../db.js";
import { MAX_DISPLAY_NAME_LENGTH } from "./account.js";

// Issue #470: the Account panel's routes (the name, an uploaded picture),
// and the Google or GitHub picture legato.fm sends a linked server, in its
// tokens and its answer to a link report, which the server fetches and
// serves itself.

const GOOGLE = "https://lh3.googleusercontent.com/a/owner=s96-c";
const GITHUB = "https://avatars.githubusercontent.com/u/42?v=4";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

type Picture = { hash: string; source: "upload" | "legato" } | null;

// A legato.fm that answers a link report the way `answer` says: by default
// the way one from before the picture did, with no picture at all.
async function setup(options: { answer?: (report: LegatoReport) => Response | Error } = {}) {
  const db = openDb(":memory:");
  const key = makeTestKey();
  const legato = fakeLegatoFetch(() => [key], options.answer);
  const identity = new LegatoIdentity(db, { origin: TEST_ISSUER, fetch: legato.impl });
  installLegatoIdentity(db, identity);
  cleanups.push(() => identity.stop());

  const dir = mkdtempSync(path.join(tmpdir(), "legato-account-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const pictureFetches: string[] = [];
  const store = new Pictures(db, {
    dir,
    fetch: (async (input: string | URL | Request) => {
      pictureFetches.push(String(input));
      return new Response(makeImage(96, 96), { headers: { "Content-Type": "image/jpeg" } });
    }) as typeof fetch,
  });
  installPictures(db, store);

  const { app } = await buildTestApp(db);
  cleanups.push(() => void app.close());
  const { token: owner, mediaTicket } = await createOwnerForTest(app);
  const now = () => Math.floor(Date.now() / 1000);
  const token = (overrides: Record<string, unknown> = {}) =>
    signTestToken(key, testClaims(identity.serverId(), now(), { jti: crypto.randomUUID(), ...overrides }));
  const status = async (bearer = owner) =>
    (await app.inject({ method: "GET", url: "/api/v1/auth/status", headers: { authorization: `Bearer ${bearer}` } })).json() as {
      user: { id: number; displayName: string | null; picture: Picture; avatarUrl?: unknown } | null;
    };
  const ownerId = (await status()).user!.id;
  return { db, app, legato, identity, store, dir, pictureFetches, owner, mediaTicket, token, status, ownerId };
}

type Harness = Awaited<ReturnType<typeof setup>>;

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function link(h: Harness, overrides: Record<string, unknown> = {}) {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/v1/auth/legato/link",
    headers: bearer(h.owner),
    payload: { token: h.token({ scope: "link", ...overrides }) },
  });
  if (res.statusCode !== 200) throw new Error(`link failed: ${res.body}`);
  // The picture is fetched in the background; this waits for it.
  await h.store.sync(h.ownerId);
}

function uploadPicture(app: FastifyInstance, owner: string, bytes: Buffer, contentType = "image/png") {
  return app.inject({
    method: "PUT",
    url: "/api/v1/account/picture",
    headers: { ...bearer(owner), "content-type": contentType },
    payload: bytes,
  });
}

// A legato.fm answering a link report with the account's picture, as one
// with issue #470 does.
const answerWith = (picture: string | null) => (report: LegatoReport) =>
  report.url.endsWith("/linked-servers")
    ? Response.json({ linked: { accountId: "42", serverId: "x", picture } })
    : Response.json({ ok: true });

describe("PATCH /account", () => {
  it("changes the signed-in user's name, and /auth/status says the new one", async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: "PATCH",
      url: "/api/v1/account",
      headers: bearer(h.owner),
      payload: { displayName: "  Ada Lovelace  " },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.displayName).toBe("Ada Lovelace");
    expect((await h.status()).user!.displayName).toBe("Ada Lovelace");
  });

  it("takes an empty name as none, so the initials fall back", async () => {
    const h = await setup();
    const res = await h.app.inject({ method: "PATCH", url: "/api/v1/account", headers: bearer(h.owner), payload: { displayName: "   " } });
    expect(res.json().user.displayName).toBeNull();
  });

  it("refuses a name that's too long, or isn't text", async () => {
    const h = await setup();
    for (const displayName of ["x".repeat(MAX_DISPLAY_NAME_LENGTH + 1), 42, null, undefined]) {
      const res = await h.app.inject({ method: "PATCH", url: "/api/v1/account", headers: bearer(h.owner), payload: { displayName } });
      expect(res.statusCode).toBe(400);
    }
    expect((await h.status()).user!.displayName).toBeNull();
  });

  it("needs a session: nobody signed out, and never a media ticket", async () => {
    const h = await setup();
    const signedOut = await h.app.inject({ method: "PATCH", url: "/api/v1/account", payload: { displayName: "Mallory" } });
    expect(signedOut.statusCode).toBe(401);
    const ticket = await h.app.inject({ method: "PATCH", url: `/api/v1/account?t=${h.mediaTicket}`, payload: { displayName: "Mallory" } });
    expect(ticket.statusCode).toBe(401);
    expect((await h.status()).user!.displayName).toBeNull();
  });
});

describe("an uploaded picture", () => {
  it("is stored on this server, and an <img> loads it with the media ticket", async () => {
    const h = await setup();
    const res = await uploadPicture(h.app, h.owner, makeImage(400, 300));
    expect(res.statusCode).toBe(200);
    const picture = res.json().user.picture as Picture;
    expect(picture).toEqual({ hash: expect.stringMatching(/^[0-9a-f]{40}$/), source: "upload" });
    expect((await h.status()).user!.picture).toEqual(picture);
    expect(existsSync(h.store.path(picture!.hash))).toBe(true);

    const img = await h.app.inject({ method: "GET", url: `/api/v1/account/pictures/${picture!.hash}?t=${h.mediaTicket}` });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/jpeg");
    expect(img.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(img.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it("is never served to someone signed out", async () => {
    const h = await setup();
    const { hash } = (await uploadPicture(h.app, h.owner, makeImage(64, 64))).json().user.picture;
    expect((await h.app.inject({ method: "GET", url: `/api/v1/account/pictures/${hash}` })).statusCode).toBe(401);
  });

  it("refuses something that isn't a picture, or nothing at all", async () => {
    const h = await setup();
    const garbage = await uploadPicture(h.app, h.owner, Buffer.from("definitely not a png"));
    expect(garbage.statusCode).toBe(400);
    expect(garbage.json().reason).toBe("not_a_picture");
    const json = await h.app.inject({ method: "PUT", url: "/api/v1/account/picture", headers: bearer(h.owner), payload: { picture: "x" } });
    expect(json.statusCode).toBe(400);
    expect((await h.status()).user!.picture).toBeNull();
  });

  it("is removed, file and all, and its hash then finds nothing", async () => {
    const h = await setup();
    const { hash } = (await uploadPicture(h.app, h.owner, makeImage(64, 64))).json().user.picture;
    const res = await h.app.inject({ method: "DELETE", url: "/api/v1/account/picture", headers: bearer(h.owner) });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.picture).toBeNull();
    expect(existsSync(h.store.path(hash))).toBe(false);
    expect((await h.app.inject({ method: "GET", url: `/api/v1/account/pictures/${hash}`, headers: bearer(h.owner) })).statusCode).toBe(404);
  });

  it("answers 400 for a hash that isn't one", async () => {
    const h = await setup();
    const res = await h.app.inject({ method: "GET", url: "/api/v1/account/pictures/..%2F..%2Fsecret", headers: bearer(h.owner) });
    expect(res.statusCode).toBe(400);
  });

  it("never goes to legato.fm, even from a linked server", async () => {
    const h = await setup({ answer: answerWith(GOOGLE) });
    await link(h);
    const contacted = h.legato.calls.length;
    await uploadPicture(h.app, h.owner, makeImage(64, 64));
    expect(h.legato.calls).toHaveLength(contacted);
    expect(h.pictureFetches).toEqual([GOOGLE]);
  });
});

describe("legato.fm's picture", () => {
  it("comes with the link report's answer, and the server serves its own copy", async () => {
    const h = await setup({ answer: answerWith(GOOGLE) });
    await link(h, { picture: GITHUB });
    // The answer is legato.fm's picture as it is now, so it wins over the
    // link token's, signed a moment before.
    expect(h.pictureFetches).toEqual([GOOGLE]);
    const { picture, avatarUrl } = (await h.status()).user!;
    expect(picture).toEqual({ hash: expect.stringMatching(/^[0-9a-f]{40}$/), source: "legato" });
    // The device is never handed the Google address to load.
    expect(avatarUrl).toBeUndefined();
    const img = await h.app.inject({ method: "GET", url: `/api/v1/account/pictures/${picture!.hash}?t=${h.mediaTicket}` });
    expect(img.statusCode).toBe(200);
  });

  it("comes from the link token's claim when the answer doesn't say", async () => {
    const h = await setup();
    await link(h, { picture: GITHUB });
    expect(h.pictureFetches).toEqual([GITHUB]);
    expect((await h.status()).user!.picture?.source).toBe("legato");
  });

  it("follows the access tokens: a new address is fetched, the same one isn't", async () => {
    const h = await setup({ answer: answerWith(GOOGLE) });
    await link(h);
    const me = (bearerToken: string) => h.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: bearer(bearerToken) });

    expect((await me(h.token({ picture: GOOGLE }))).statusCode).toBe(200);
    await h.store.sync(h.ownerId);
    expect(h.pictureFetches).toEqual([GOOGLE]);

    expect((await me(h.token({ picture: GITHUB }))).statusCode).toBe(200);
    await h.store.sync(h.ownerId);
    expect(h.pictureFetches).toEqual([GOOGLE, GITHUB]);

    // An account that took its picture away has none here either.
    await me(h.token({ picture: null }));
    await h.store.sync(h.ownerId);
    expect((await h.status()).user!.picture).toBeNull();
  });

  it("loses to an uploaded picture, and shows again once that's removed", async () => {
    const h = await setup({ answer: answerWith(GOOGLE) });
    await link(h);
    const remote = (await h.status()).user!.picture!;
    const uploaded = (await uploadPicture(h.app, h.owner, makeImage(64, 64))).json().user.picture;
    expect(uploaded.source).toBe("upload");
    expect((await h.status()).user!.picture).toEqual(uploaded);

    await h.app.inject({ method: "DELETE", url: "/api/v1/account/picture", headers: bearer(h.owner) });
    expect((await h.status()).user!.picture).toEqual(remote);
  });

  it("goes when the server is unlinked; an uploaded picture stays", async () => {
    const h = await setup({ answer: answerWith(GOOGLE) });
    await link(h);
    const remote = (await h.status()).user!.picture!;
    const res = await h.app.inject({ method: "DELETE", url: "/api/v1/auth/legato/link", headers: bearer(h.owner) });
    expect(res.statusCode).toBe(200);
    expect((await h.status()).user!.picture).toBeNull();
    expect(existsSync(h.store.path(remote.hash))).toBe(false);

    await link(h);
    const uploaded = (await uploadPicture(h.app, h.owner, makeImage(64, 64))).json().user.picture;
    await h.app.inject({ method: "DELETE", url: "/api/v1/auth/legato/link", headers: bearer(h.owner) });
    expect((await h.status()).user!.picture).toEqual(uploaded);
  });
});

describe("a legato.fm from before the picture", () => {
  it("links, and its tokens open the server, with initials and no fetch", async () => {
    const h = await setup();
    await link(h);
    const me = await h.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: bearer(h.token()) });
    expect(me.statusCode).toBe(200);
    await h.store.sync(h.ownerId);
    expect(h.pictureFetches).toEqual([]);
    expect((await h.status()).user!.picture).toBeNull();
  });

  it("leaves a picture the server already has alone", async () => {
    const h = await setup();
    await link(h, { picture: GOOGLE });
    const before = (await h.status()).user!.picture;
    expect(before?.source).toBe("legato");
    // A token without the claim: legato.fm rolled back, or a stale token.
    await h.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: bearer(h.token()) });
    await h.store.sync(h.ownerId);
    expect((await h.status()).user!.picture).toEqual(before);
  });
});

describe("a server that never links", () => {
  it("shows its uploaded picture, and never fetches one", async () => {
    const h = await setup();
    expect((await h.status()).user!.picture).toBeNull();
    const uploaded = (await uploadPicture(h.app, h.owner, makeImage(64, 64))).json().user.picture;
    expect((await h.status()).user!.picture).toEqual(uploaded);
    expect(h.pictureFetches).toEqual([]);
    expect(h.legato.calls).toEqual([]);
  });
});
