/**
 * Read the permission mode of the program out of a packed npm tarball.
 *
 * A published package is only usable if the program inside it is executable, and the only place that
 * becomes a fact is the packed tarball — copying the folder cannot see it, which is how
 * `@cntxt-labs/medha-*@0.5.0` shipped a program as 0644 and every install died with EACCES
 * (nimishph/medha#1).
 *
 * The mode is read from the tar header rather than from `tar -tvzf` output on purpose: the human
 * listing is a column layout that differs between GNU tar, bsdtar and the platforms, so a check
 * written against it is a check that quietly stops matching. The header field is fixed by the format.
 *
 * Parsing lives here, apart from the smoke test that runs it, so it can be tested against known
 * tarballs on any platform. A guard that cannot be exercised where you are is a guard that quietly
 * stops guarding.
 */
const BLOCK = 512;
const NAME_OFFSET = 0;
const NAME_LENGTH = 100;
const MODE_OFFSET = 100;
const MODE_LENGTH = 8;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
/** Byte offset of the typeflag, the one-character field saying what kind of entry this is. */
export const TYPEFLAG = 156;
const PREFIX_OFFSET = 345;
const PREFIX_LENGTH = 155;

/** A file's typeflag is '0', and an unset one means the same thing. */
function isFile(typeflag: string): boolean {
  return typeflag === '0' || typeflag === '\0' || typeflag === '';
}

/** `undefined` when the field is not octal digits, rather than a silent `NaN`. */
function octal(bytes: Uint8Array, offset: number, length: number): number | undefined {
  const text = new TextDecoder().decode(bytes.subarray(offset, offset + length));
  const trimmed = text.replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(trimmed)) return undefined;
  return Number.parseInt(trimmed, 8);
}

/** The path a header names, joining ustar's `prefix` field for names too long for `name` alone. */
function entryName(header: Uint8Array): string {
  const text = (from: number, length: number) =>
    new TextDecoder().decode(header.subarray(from, from + length)).replace(/\0.*$/, '');
  const name = text(NAME_OFFSET, NAME_LENGTH);
  const prefix = text(PREFIX_OFFSET, PREFIX_LENGTH);
  return prefix === '' ? name : `${prefix}/${name}`;
}

/** True when a 512-byte block is all zeros, which is how tar records the end of the archive. */
function isEmptyBlock(tarball: Uint8Array, at: number): boolean {
  for (let i = at; i < at + BLOCK; i += 1) {
    if (tarball[i] !== 0) return false;
  }
  return true;
}

/** True when the bytes start with gzip's magic number, which is what an npm `.tgz` does. */
function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * The mode of `package/bin/…` inside a packed tarball, or `undefined` when the archive holds no
 * such file. Returned in the numeric form (`0o755`) so a caller can compare it against what it needs.
 *
 * npm ships `.tgz`, so the bytes are gunzipped here. Accepting both means a caller can hand over
 * whatever it has rather than having to know which of the two it is holding.
 */
export function programMode(packed: Uint8Array): number | undefined {
  // gzip's magic number. Anything else is taken to be an uncompressed tar. `Uint8Array.from` copies
  // into a plain ArrayBuffer, which is the shape gunzipSync wants.
  const tarball = isGzip(packed)
    ? new Uint8Array(Bun.gunzipSync(Uint8Array.from(packed).buffer))
    : packed;
  let at = 0;
  while (at + BLOCK <= tarball.length) {
    if (isEmptyBlock(tarball, at)) return undefined;
    const header = tarball.subarray(at, at + BLOCK);
    const typeflag = String.fromCharCode(header[TYPEFLAG] as number);
    const size = octal(header, SIZE_OFFSET, SIZE_LENGTH) ?? 0;
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    // 'L'/'K' name the next entry and 'x'/'g' hold pax metadata: none of them is the program.
    if (!isFile(typeflag)) continue;
    if (entryName(header).startsWith('package/bin/')) {
      return octal(header, MODE_OFFSET, MODE_LENGTH);
    }
  }
  return undefined;
}

/**
 * Build the 512-byte header of a ustar entry, so a test can state a mode as the bytes npm would
 * write rather than as a listing line to be parsed back.
 */
export function ustarHeader(name: string, mode: number, size = 0): Uint8Array {
  const header = new Uint8Array(BLOCK);
  const writeText = (text: string, offset: number, length: number) => {
    header.set(new TextEncoder().encode(text).subarray(0, length), offset);
  };
  const octalField = (value: number, length: number) => value.toString(8).padStart(length - 1, '0');
  writeText(name, NAME_OFFSET, NAME_LENGTH);
  writeText(octalField(mode, MODE_LENGTH), MODE_OFFSET, MODE_LENGTH);
  writeText(octalField(0, 8), 108, 8); // uid
  writeText(octalField(0, 8), 116, 8); // gid
  writeText(octalField(size, SIZE_LENGTH), SIZE_OFFSET, SIZE_LENGTH);
  writeText(octalField(0, 12), 136, 12); // mtime
  header[TYPEFLAG] = '0'.charCodeAt(0);
  writeText('ustar\0', 257, 6);
  writeText('00', 263, 2);
  return header;
}
