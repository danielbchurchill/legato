// The tunnel protocol: JSON control frames sent as WebSocket text messages
// in both directions over the single persistent /tunnel connection.
//
// Body bytes (request bodies and response chunks) travel as base64 inside
// those JSON frames rather than as raw binary WS frames. That costs ~33%
// size overhead, but it means every message on the wire is one self-describing
// JSON object — no separate binary channel to correlate against the control
// channel, no framing-within-framing. For a prototype whose whole point is
// getting requestId demultiplexing right, that simplicity is worth the bytes.
// If this becomes the real audio-streaming path, switching response-chunk to
// raw binary WS frames (prefixed with a fixed-width requestId) is the
// documented next step — the JSON control frames (auth/request/response-start/
// response-end) would stay as-is either way.

// The first frame on every tunnel. Sent again later on a signed-in tunnel,
// with the credential a credential frame brought, to move the tunnel onto
// it (issue #115).
export interface AuthFrame {
  type: "auth";
  secret: string;
}

export interface AuthOkFrame {
  type: "auth-ok";
}

export interface AuthErrorFrame {
  type: "auth-error";
  message: string;
}

// Sent by the relay down the tunnel when a mobile client's HTTP request
// arrives. `path` includes the query string. `body` is only present when
// the inbound request actually carried one (base64-encoded, buffered whole
// up to REQUEST_BODY_LIMIT in routes/relay.ts).
//
// `clientAddress` is the device's address as legato.fm saw it, so the home
// server's sign-in limits and logs tell one device from another rather
// than seeing every tunneled request come from its own loopback (server/
// src/auth/clientAddress.ts). A relay from before it sends none, and the
// server then counts the request as from "the tunnel".
export interface RequestFrame {
  type: "request";
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  clientAddress?: string;
}

// Sent by the relay when the device a request came from hangs up before
// its answer is over, or when the relay gives up on an answer it can't pass
// on. The home server stops working on it: it aborts its own request, which
// ends a file read, and a transcode with no one left to read it stops
// (server/src/stream/cache.ts). Nothing answers it, and a home server from
// before it ignores it.
export interface CancelFrame {
  type: "cancel";
  requestId: string;
}

export interface ResponseStartFrame {
  type: "response-start";
  requestId: string;
  status: number;
  headers: Record<string, string>;
}

export interface ResponseChunkFrame {
  type: "response-chunk";
  requestId: string;
  data: string; // base64
}

export interface ResponseEndFrame {
  type: "response-end";
  requestId: string;
}

// Sent by the home server when it can't fulfil a request at all (e.g. its
// own local target refused the connection). The relay turns this into a
// 502 for whichever HTTP response is still waiting.
export interface ResponseErrorFrame {
  type: "response-error";
  requestId: string;
  message: string;
}

// Rotation (issue #115). A credential lasts 90 days, and a server replaces
// it over the tunnel it signed in with, so it never has to be claimed or
// linked again for that. The server sends rotate; the relay answers with a
// credential frame, for the same account and server. The server stores
// it, then sends it back in an auth frame on the same tunnel, and that
// retires the old one (relay/src/pairing.ts). So a credential frame that
// never arrives, or one the server couldn't store, retires nothing. A
// relay from before rotation ignores rotate.
export interface RotateFrame {
  type: "rotate";
}

export interface CredentialFrame {
  type: "credential";
  credential: string;
  expiresAt: string;
}

export type TunnelFrame =
  | AuthFrame
  | AuthOkFrame
  | AuthErrorFrame
  | RotateFrame
  | CredentialFrame
  | RequestFrame
  | CancelFrame
  | ResponseStartFrame
  | ResponseChunkFrame
  | ResponseEndFrame
  | ResponseErrorFrame;

export function parseFrame(raw: string): TunnelFrame | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
      return parsed as TunnelFrame;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
