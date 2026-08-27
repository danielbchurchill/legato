// Every desktop build (Tauri) and plain `npm run dev` talks to the
// server's loopback address unchanged. Set VITE_SERVER_HOST to reach a
// server bound to a different interface — e.g. previewing this app from
// another machine over Tailscale while Vite and the server both run here.
export const SERVER_HOST = import.meta.env.VITE_SERVER_HOST ?? '127.0.0.1'
