import type { Database } from "../sqlite.js";
import type { SessionUser } from "./sessions.js";

// The local owner (issue #112): one password account per server, stored
// only here, usable with no internet and no legato.fm account. Hashed with
// Bun.password, whose default is argon2id. It's built into Bun itself, so
// the compiled sidecar and the Pi's binary carry it with nothing extra to
// install or compile.

// Long enough to rule out "1234", short enough not to push anyone toward a
// sticky note. No composition rules: they make passwords worse, not better.
export const MIN_PASSWORD_LENGTH = 8;
// argon2 hashes any length, but an unbounded body is a free CPU burner for
// anyone who can reach the sign-in route.
export const MAX_PASSWORD_LENGTH = 1024;

export function ownerExists(db: Database): boolean {
  return db.prepare("SELECT 1 FROM users WHERE role = 'owner'").get() !== undefined;
}

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `The password can be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

const OWNER_COLUMNS = "id, provider, role, email, display_name, avatar_url";

// Returns null when an owner already exists: the partial unique index
// users_one_owner (0029) is what actually decides that, so two first-run
// requests racing past the route's own ownerExists() check still produce
// exactly one owner.
export async function createOwner(
  db: Database,
  password: string,
  displayName: string | null,
): Promise<SessionUser | null> {
  const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
  try {
    db.prepare(
      `INSERT INTO users (provider, provider_user_id, display_name, password_hash, role)
       VALUES ('local', 'owner', ?, ?, 'owner')`,
    ).run(displayName, passwordHash);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) return null;
    throw err;
  }
  return db.prepare(`SELECT ${OWNER_COLUMNS} FROM users WHERE role = 'owner'`).get() as SessionUser;
}

export async function verifyOwnerPassword(db: Database, password: string): Promise<SessionUser | null> {
  const row = db
    .prepare(`SELECT ${OWNER_COLUMNS}, password_hash FROM users WHERE role = 'owner'`)
    .get() as (SessionUser & { password_hash: string }) | undefined;
  if (!row || !(await Bun.password.verify(password, row.password_hash))) return null;
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(row.id);
  const { password_hash: _unused, ...user } = row;
  return user;
}
