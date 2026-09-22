import { crc32, inflateRawSync } from "node:zlib";

/** One file of an archive, as an unzip tool would see it. */
export interface UnzippedEntry {
  name: string;
  data: Buffer;
  /** Unix permission bits, e.g. 0o755. */
  mode: number;
  method: number;
  utf8Name: boolean;
  /** High byte of "version made by": 3 = Unix. */
  madeBy: number;
  /** MS-DOS date and time fields. */
  dosDate: number;
  dosTime: number;
}

/**
 * A strict reader for the archives lib/zip.ts writes: walks the central
 * directory, checks every local header against it, inflates the data and
 * verifies each CRC. Throws on anything malformed.
 */
export function readZip(bytes: Uint8Array): UnzippedEntry[] {
  const zip = Buffer.from(bytes);
  const end = zip.length - 22;
  if (zip.readUInt32LE(end) !== 0x06054b50) throw new Error("no end of central directory record");
  const count = zip.readUInt16LE(end + 10);
  if (zip.readUInt16LE(end + 8) !== count) throw new Error("entry counts disagree");
  const directorySize = zip.readUInt32LE(end + 12);
  let at = zip.readUInt32LE(end + 16);
  if (at + directorySize !== end) throw new Error("central directory is not where the end record says");

  const entries: UnzippedEntry[] = [];
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad central header #${index}`);
    const madeBy = zip.readUInt16LE(at + 4);
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const dosTime = zip.readUInt16LE(at + 12);
    const dosDate = zip.readUInt16LE(at + 14);
    const checksum = zip.readUInt32LE(at + 16);
    const compressedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const external = zip.readUInt32LE(at + 38);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);

    if (zip.readUInt32LE(offset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const localNameLength = zip.readUInt16LE(offset + 26);
    const localExtraLength = zip.readUInt16LE(offset + 28);
    if (zip.toString("utf8", offset + 30, offset + 30 + localNameLength) !== name) {
      throw new Error(`local name differs for ${name}`);
    }
    if (zip.readUInt16LE(offset + 8) !== method || zip.readUInt32LE(offset + 14) !== checksum) {
      throw new Error(`local header disagrees with the directory for ${name}`);
    }

    const start = offset + 30 + localNameLength + localExtraLength;
    const body = zip.subarray(start, start + compressedSize);
    const data = method === 8 ? inflateRawSync(body) : method === 0 ? Buffer.from(body) : null;
    if (!data) throw new Error(`unsupported method ${method} for ${name}`);
    if (data.length !== size) throw new Error(`size mismatch for ${name}`);
    if (crc32(data) !== checksum) throw new Error(`CRC mismatch for ${name}`);

    entries.push({
      name,
      data,
      mode: (external >>> 16) & 0o7777,
      method,
      utf8Name: (flags & 0x0800) !== 0,
      madeBy: madeBy >> 8,
      dosDate,
      dosTime,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
