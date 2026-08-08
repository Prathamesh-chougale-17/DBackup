/**
 * JSON payloads carried in a query string.
 *
 * `btoa` takes a byte string, so it throws `InvalidCharacterError` on any code point above
 * U+00FF. A payload holding a Chinese job name, a Cyrillic source name or an emoji in a path
 * therefore blows up inside the click handler that built it, before any navigation happens,
 * which looks to the user like the button does nothing at all.
 *
 * Encoding to UTF-8 bytes first removes the limit. ASCII payloads come out byte-identical to
 * what plain `btoa` produced, so links already sitting in a history entry keep resolving.
 */

/** Chunk size for the byte-to-binary-string conversion, small enough to stay off the stack limit. */
const CHUNK_SIZE = 0x8000;

/**
 * Encodes a value as base64 for use in a query string.
 *
 * The result is standard base64 and still contains `+`, `/` and `=`, so callers must pass it
 * through `encodeURIComponent` before putting it in a URL.
 */
export function encodeUrlPayload(value: unknown): string {
    const bytes = new TextEncoder().encode(JSON.stringify(value));

    // Built in chunks rather than one spread into `String.fromCharCode`, which overflows the
    // call stack once the payload passes a few tens of kilobytes.
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE));
    }

    return btoa(binary);
}

/** Reads a payload back, or null when the parameter is missing, truncated or not valid JSON. */
export function decodeUrlPayload<T>(encoded: string | null | undefined): T | null {
    if (!encoded) return null;

    try {
        const binary = atob(encoded);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch {
        return null;
    }
}
