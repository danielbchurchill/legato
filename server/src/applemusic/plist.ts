// An XML property list reader, for the Library.xml Apple Music writes
// (#133). That file is a plist of one dict: a "Tracks" dict of one dict per
// track, and a "Playlists" array. A library of 100,000 tracks is about
// 150 MB of it, so this reads the text in one pass by indexOf, without a
// DOM, and keeps only the values.
//
// It reads what plists hold: dict, array, string, integer, real, date (kept
// as its ISO text), data (kept as its base64 text), true and false. Music
// escapes text with numeric references (&#38; for "&"), which are decoded
// with the five named ones.

export type PlistValue = string | number | boolean | PlistValue[] | PlistDict;
export type PlistDict = { [key: string]: PlistValue };

export class PlistError extends Error {}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXmlText(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

type Open = { kind: "dict"; value: PlistDict; key: string | null } | { kind: "array"; value: PlistValue[] };

const SCALARS = new Set(["string", "integer", "real", "date", "data", "key"]);

export function parsePlist(xml: string): PlistValue {
  const stack: Open[] = [];
  let root: PlistValue | undefined;
  let sawPlist = false;
  let pos = 0;

  const deliver = (value: PlistValue) => {
    const top = stack[stack.length - 1];
    if (!top) {
      if (root !== undefined) throw new PlistError("A property list holds one value at its top.");
      root = value;
    } else if (top.kind === "array") {
      top.value.push(value);
    } else {
      if (top.key === null) throw new PlistError("A dict value came without its key.");
      top.value[top.key] = value;
      top.key = null;
    }
  };

  while (true) {
    const lt = xml.indexOf("<", pos);
    if (lt === -1) break;
    // Text between elements is only whitespace in a plist; scalars' own
    // text is read with their element below.
    if (xml.startsWith("<?", lt)) {
      pos = endOf(xml, "?>", lt);
      continue;
    }
    if (xml.startsWith("<!--", lt)) {
      pos = endOf(xml, "-->", lt);
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      pos = endOf(xml, ">", lt);
      continue;
    }
    const gt = xml.indexOf(">", lt);
    if (gt === -1) throw new PlistError("The file ends inside a tag.");
    const inside = xml.slice(lt + 1, gt);
    pos = gt + 1;
    const closing = inside.startsWith("/");
    const selfClosing = inside.endsWith("/");
    const name = inside.replace(/^\//, "").replace(/\/$/, "").trim().split(/\s/)[0]!;

    if (name === "plist") {
      sawPlist = true;
      continue;
    }
    if (!sawPlist) throw new PlistError("This isn't a property list.");

    if (closing) {
      const top = stack.pop();
      if (!top || top.kind !== name) throw new PlistError(`An unexpected </${name}>.`);
      if (top.kind === "dict" && top.key !== null) throw new PlistError(`The key "${top.key}" has no value.`);
      deliver(top.value);
      continue;
    }

    switch (name) {
      case "dict":
        if (selfClosing) deliver(Object.create(null) as PlistDict);
        else stack.push({ kind: "dict", value: Object.create(null) as PlistDict, key: null });
        continue;
      case "array":
        if (selfClosing) deliver([]);
        else stack.push({ kind: "array", value: [] });
        continue;
      case "true":
      case "false":
        deliver(name === "true");
        continue;
    }

    if (!SCALARS.has(name)) throw new PlistError(`<${name}> isn't part of a property list.`);
    let text = "";
    if (!selfClosing) {
      const close = `</${name}>`;
      const end = xml.indexOf(close, pos);
      if (end === -1) throw new PlistError(`A <${name}> is never closed.`);
      text = xml.slice(pos, end);
      pos = end + close.length;
    }

    if (name === "key") {
      const top = stack[stack.length - 1];
      if (!top || top.kind !== "dict") throw new PlistError("A <key> outside a dict.");
      top.key = decodeXmlText(text);
      continue;
    }
    if (name === "integer" || name === "real") {
      const number = Number(text.trim());
      if (!Number.isFinite(number)) throw new PlistError(`"${text.trim()}" isn't a number.`);
      deliver(number);
    } else if (name === "data") {
      deliver(text.replace(/\s+/g, ""));
    } else if (name === "date") {
      deliver(text.trim());
    } else {
      deliver(decodeXmlText(text));
    }
  }

  if (stack.length > 0) throw new PlistError(`The file ends inside a <${stack[stack.length - 1]!.kind}>.`);
  if (root === undefined)
    throw new PlistError(sawPlist ? "The property list is empty." : "This isn't a property list.");
  return root;
}

function endOf(xml: string, marker: string, from: number): number {
  const end = xml.indexOf(marker, from);
  if (end === -1) throw new PlistError("The file ends inside a declaration.");
  return end + marker.length;
}
