// Port of the export string format in WeakAuras/Transmission.lua.
//
// A whole configuration (a display plus its children) travels as one string
// people paste into chat, Discord or a website: "!WA:2!<payload>". The
// prefix names the encoding version, so the decoder can still read every
// older format while new exports use the newest one. Decoding fails in
// labelled stages (decoding, decompressing, deserializing) so the user hears
// which part broke.
//
// This port uses JSON, the platform's deflate-raw CompressionStream and
// URL-safe base64, so it runs in browsers and Node 18+ with no libraries.

export interface Envelope<D> {
  /** The main document. */
  d: D;
  /** Child documents, for groups. */
  c?: D[];
  /** Exporter's data version, so the importer can migrate or refuse. */
  v: number;
}

type DecodeStage = "format" | "decoding" | "decompressing" | "deserializing";
export type DecodeResult<D> =
  | { ok: true; envelope: Envelope<D>; encoding: number }
  | { ok: false; stage: DecodeStage; error: string };

/** JSON with sorted keys: equal data always gives an equal string. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
    }
    return v;
  });
}

/** Remove fields that must not leave this machine, by a nested field map. */
export function stripFields<T>(doc: T, map: Record<string, true | Record<string, unknown>>): T {
  const out = structuredClone(doc) as Record<string, unknown>;
  for (const [key, rule] of Object.entries(map)) {
    if (rule === true) delete out[key];
    else if (out[key] && typeof out[key] === "object") {
      out[key] = stripFields(out[key], rule as Record<string, true | Record<string, unknown>>);
    }
  }
  return out as T;
}

const toBase64Url = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (s: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("Unexpected characters");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

interface Codec {
  encode(json: string): Promise<string>;
  decode(payload: string): Promise<{ stage: DecodeStage; json?: string; error?: string }>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Version 1: no compression. Kept so old strings still import. */
const v1: Codec = {
  encode: async (json) => toBase64Url(enc.encode(json)),
  async decode(payload) {
    try {
      return { stage: "deserializing", json: dec.decode(fromBase64Url(payload)) };
    } catch (e) {
      return { stage: "decoding", error: String(e) };
    }
  },
};

/** Version 2: deflate, the current format. */
const v2: Codec = {
  encode: async (json) => toBase64Url(await pipe(enc.encode(json), new CompressionStream("deflate-raw"))),
  async decode(payload) {
    let bytes: Uint8Array;
    try {
      bytes = fromBase64Url(payload);
    } catch (e) {
      return { stage: "decoding", error: String(e) };
    }
    try {
      return { stage: "deserializing", json: dec.decode(await pipe(bytes, new DecompressionStream("deflate-raw"))) };
    } catch (e) {
      return { stage: "decompressing", error: String(e) };
    }
  },
};

export class Transmission<D> {
  private readonly codecs = new Map<number, Codec>([[1, v1], [2, v2]]);
  private readonly pattern: RegExp;

  /** `tag` becomes the prefix, "!WA:2!" for tag "WA". */
  constructor(private readonly tag: string, private readonly encoding = 2) {
    this.pattern = new RegExp(`^!${tag}:(\\d+)!(.+)$`, "s");
  }

  async encode(envelope: Envelope<D>): Promise<string> {
    const codec = this.codecs.get(this.encoding);
    if (!codec) throw new Error(`No codec for encoding ${this.encoding}`);
    return `!${this.tag}:${this.encoding}!${await codec.encode(stableStringify(envelope))}`;
  }

  async decode(input: string): Promise<DecodeResult<D>> {
    const match = this.pattern.exec(input.trim());
    if (!match) return { ok: false, stage: "format", error: `Not a !${this.tag}: string` };
    const encoding = Number(match[1]);
    const codec = this.codecs.get(encoding);
    if (!codec) return { ok: false, stage: "format", error: `Unknown encoding ${encoding}; is this from a newer version?` };
    const step = await codec.decode(match[2] as string);
    if (step.json === undefined) return { ok: false, stage: step.stage, error: step.error ?? "Unknown error" };
    try {
      const envelope = JSON.parse(step.json) as Envelope<D>;
      if (!envelope || typeof envelope !== "object" || !("d" in envelope)) throw new Error("Missing document");
      return { ok: true, envelope, encoding };
    } catch (e) {
      return { ok: false, stage: "deserializing", error: String(e) };
    }
  }
}
