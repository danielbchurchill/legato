// The code a person reads off one screen and types (or scans) into another:
// the home server's setup code (server/src/auth/setupCode.ts), which is also
// the legato.fm pairing code that claims it (plan 02, "Claiming a headless
// server"). Every code starts on a server since #353, so this side only
// reads them. The two packages share no code, so this is a deliberate copy
// of the server's rules; a change here belongs there too.

// Crockford base32: digits plus the alphabet minus I, L, O and U. Eight
// characters is 40 bits, shown as K7QM-4XRD.
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

/**
 * What a person typed, in the K7QM-4XRD form, or null when it can't be a
 * code at all. Forgiving the way Crockford's own decoding is: any case, the
 * dash or spaces anywhere or nowhere, and O read as 0, I and L read as 1.
 */
export function normalizeCode(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  const code = candidate
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (code.length !== CODE_LENGTH || [...code].some((char) => !CODE_ALPHABET.includes(char))) return null;
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
