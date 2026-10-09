import { createHash } from "node:crypto";

// A Content-Security-Policy source that names one inline <script> or <style>
// by its hash (issue #324): the element's text, exactly as the page has it.
export function hashSource(text: string): string {
  return `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
}
