export const PORT = Number(process.env.RELAY_PORT ?? 8901);

// No default on purpose: an unset secret should mean "nothing can
// authenticate," not "authenticate with an empty string." See routes/tunnel.ts.
export const SHARED_SECRET = process.env.RELAY_SHARED_SECRET ?? "";
