/**
 * `Content-Disposition` values for file downloads.
 *
 * A header value is a byte string, so a name carrying anything above U+00FF fails before a
 * single byte reaches the client: undici rejects it when the `Response` is constructed, and
 * Node rejects it again with `ERR_INVALID_CHAR` when the response is written out. The user
 * sees a 500 instead of a download. Names in the Latin-1 range do not throw but arrive
 * mangled, because the client reads the bytes back as UTF-8.
 *
 * RFC 6266 is the way out: an ASCII `filename` every client understands, plus a `filename*`
 * carrying the real name as percent-encoded UTF-8. The extended form is only appended when
 * the name needs it, so a plain ASCII download sends exactly the header it always did.
 */

/** Anything a quoted-string cannot carry, plus separators a client might read as a path. */
const NOT_HEADER_SAFE = /[^\x20-\x7E]|["\\/]/g;

/** RFC 5987 `ext-value`: percent-encoded UTF-8 restricted to `attr-char`. */
function encodeExtended(fileName: string): string {
    // `encodeURIComponent` leaves these four alone, and none of them is an `attr-char`.
    return encodeURIComponent(fileName).replace(
        /['()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    );
}

/** The name reduced to what a byte-string header can hold. */
function asciiFallback(fileName: string): string {
    const cleaned = fileName.replace(NOT_HEADER_SAFE, "_").trim();

    // A name that was entirely non-ASCII collapses to underscores and says nothing. The real
    // name still travels in `filename*`, so this one only has to be addressable.
    return /[A-Za-z0-9]/.test(cleaned) ? cleaned : "download";
}

/** Builds the `Content-Disposition` value that offers `fileName` as a download. */
export function attachmentDisposition(fileName: string): string {
    const fallback = asciiFallback(fileName);

    // Equal means the name was already header-safe, so no extended form is needed.
    if (fallback === fileName) return `attachment; filename="${fallback}"`;

    return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeExtended(fileName)}`;
}
