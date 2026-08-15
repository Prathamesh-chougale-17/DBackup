/**
 * File extensions whose content is already compressed.
 *
 * Shipped as code rather than as configuration, for the same reason the curated exclude
 * groups are: a release can extend the list and it reaches every existing job at once, with
 * no migration and nothing for a user to re-check. There is also nothing here worth
 * configuring - nobody wants to spend CPU recompressing an MP4 for a tenth of a percent.
 *
 * Matching is by extension alone. A content probe would catch unknown formats too, but it
 * costs CPU on every file to answer a question the extension already answers for the cases
 * that matter, and it makes the result depend on file content rather than on something a
 * user can predict from the filename.
 */

/**
 * Extensions stored as-is, lowercase and without the leading dot.
 *
 * Anything listed here is expected to gain at most a fraction of a percent from a second
 * compression pass. Formats that merely *often* arrive compressed do not belong here - see
 * the deliberate omissions below.
 */
export const INCOMPRESSIBLE_EXTENSIONS: ReadonlySet<string> = new Set([
    // Video. Every one of these is a lossy codec in a container.
    "3gp", "avi", "flv", "m2ts", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "mts", "ts", "vob", "webm", "wmv",

    // Audio. FLAC and APE are lossless but still compressed, so gzip gains nothing on them either.
    "aac", "ape", "flac", "m4a", "mka", "mp3", "oga", "ogg", "opus", "wma",

    // Images.
    "avif", "gif", "heic", "heif", "jp2", "jpeg", "jpg", "jxl", "png", "webp",

    // Archives and standalone compressed streams.
    "7z", "br", "bz2", "cab", "gz", "lz4", "lzma", "rar", "tbz2", "tgz", "txz", "xz", "zip", "zst",

    // ZIP containers under another name. Office documents, Java and mobile packages, Python
    // wheels, browser and editor extensions, Azure SQL data-tier exports - all deflate inside.
    "apk", "bacpac", "docx", "epub", "ipa", "jar", "nupkg", "odp", "ods", "odt", "pptx", "vsix", "war", "whl", "xlsx", "xpi",

    // Web fonts. WOFF and WOFF2 are the compressed forms of TTF and OTF.
    "woff", "woff2",

    // Encrypted payloads. Ciphertext is indistinguishable from random to a compressor.
    "age", "enc", "gpg", "pgp",

    // Disk images that are compressed by construction.
    "dmg",
]);

/*
 * Deliberately NOT on the list, so nobody adds them later believing it was an oversight:
 *
 *   pdf         Mixed. Streams inside a PDF may or may not be Flate-compressed, and an
 *               uncompressed one compresses very well.
 *   tif, tiff   Frequently uncompressed or LZW, both of which still gain from gzip.
 *   bmp         Uncompressed by definition.
 *   exe, dll    A PE image is code, data and resources, none of it compressed. Measured
 *               51-67% with gzip on equivalent native binaries. Installers and packed
 *               executables are compressed, but they are the minority and guessing wrong
 *               towards "skip" wastes half the storage on every binary, every run.
 *   iso         A filesystem image compresses like whatever is inside it: 81% measured on
 *               a data ISO, near zero on a distro image whose payload is already squashfs.
 *   msi         An OLE compound file whose embedded cabinets usually are compressed, but
 *               the metadata streams around them are not, and neither is an uncompressed
 *               cabinet. Too close to call by name.
 *   ttf, otf    Uncompressed font tables. WOFF is the compressed variant and is listed.
 *   sqlite, db  Page-oriented and full of repetition. One of the best gzip cases there is.
 *   svg         XML text.
 *   asc         ASCII-armored, i.e. base64. Encoding overhead means roughly a quarter is
 *               still recoverable, unlike the raw .gpg it wraps.
 *   vmdk,qcow2  Either sparse-but-raw or already compressed, with no way to tell by name.
 *   parquet,orc Usually compressed, but the codec is per-file and may be none.
 */

/**
 * True when a path's extension names a format that is already compressed.
 *
 * Extension-only, case-insensitive, and only the last one - `archive.tar.gz` is matched as
 * `gz`. A leading dot with nothing before it is a dotfile, not an extension, so `.gitignore`
 * is not treated as a file of type "gitignore".
 */
export function isIncompressible(filePath: string): boolean {
    const lastSeparator = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
    const lastDot = filePath.lastIndexOf(".");
    if (lastDot <= lastSeparator + 1) return false;
    return INCOMPRESSIBLE_EXTENSIONS.has(filePath.slice(lastDot + 1).toLowerCase());
}
