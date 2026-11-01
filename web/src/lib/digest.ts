// SHA-256 digests, as the server writes them (lower-case hex). No `@/` imports: unit tested with
// node --test.

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/** SHA-256 hex of `data` (a string: its UTF-8 encoding). Throws where crypto.subtle is missing
 * (not a secure context). */
export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("This browser context has no WebCrypto (needs http://127.0.0.1).");
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** Like sha256Hex, but null instead of an error (no crypto.subtle, or the digest failed). */
export async function sha256HexOrNull(data: string | ArrayBuffer | Uint8Array): Promise<string | null> {
  try {
    return await sha256Hex(data);
  } catch {
    return null;
  }
}
