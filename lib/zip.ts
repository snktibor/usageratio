import { crc32, deflateRawSync } from "node:zlib";

/**
 * A minimal ZIP writer for the setup packages: a handful of small text files,
 * so no ZIP64, no streaming and no dependency. Entries are deflated when that
 * saves space, names are flagged UTF-8, and Unix permissions are recorded, so
 * macOS Archive Utility and unzip restore the executable bit of the scripts.
 * Windows Explorer ignores the permissions and extracts the same files.
 */

export interface ZipEntry {
  /** Path inside the archive, with forward slashes. */
  name: string;
  data: string | Uint8Array;
  executable?: boolean;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const VERSION = 20; // 2.0: deflate
const UTF8_NAMES = 0x0800;
const MADE_BY_UNIX = (3 << 8) | VERSION;

/** MS-DOS date and time fields; the format has no zone, UTC stands in. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

export function createZip(entries: ZipEntry[], modifiedAt: Date = new Date()): Uint8Array<ArrayBuffer> {
  const { time, date } = dosDateTime(modifiedAt);
  const records: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : Buffer.from(entry.data);
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const checksum = crc32(data);
    const mode = entry.executable ? 0o100755 : 0o100644;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    records.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(MADE_BY_UNIX, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // 30–37: extra field, comment, disk number, internal attributes: all zero.
    central.writeUInt32LE((mode << 16) >>> 0, 38); // Unix permissions live in the high half
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const directorySize = directory.reduce((size, part) => size + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(entries.length, 8); // entries on this disk
  end.writeUInt16LE(entries.length, 10); // entries in total
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);

  // Copied into a plain ArrayBuffer-backed array: what Response bodies accept.
  return new Uint8Array(Buffer.concat([...records, ...directory, end]));
}
