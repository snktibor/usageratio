import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createZip } from "@/lib/zip";
import { readZip } from "./read-zip";

describe("createZip", () => {
  it("round-trips text and binary entries in order", () => {
    const binary = randomBytes(300);
    const entries = readZip(
      createZip([
        { name: "notes.txt", data: "hello\n".repeat(50) },
        { name: "blob.bin", data: binary },
      ]),
    );

    expect(entries.map((entry) => entry.name)).toEqual(["notes.txt", "blob.bin"]);
    expect(entries[0]!.data.toString("utf8")).toBe("hello\n".repeat(50));
    expect(entries[1]!.data.equals(binary)).toBe(true);
  });

  it("deflates what compresses and stores what does not", () => {
    const [text, noise] = readZip(
      createZip([
        { name: "a.txt", data: "a".repeat(1000) },
        { name: "b.bin", data: randomBytes(64) },
      ]),
    );
    expect(text!.method).toBe(8);
    expect(noise!.method).toBe(0);
  });

  it("records Unix permissions, so unzip restores the executable bit", () => {
    const [script, config] = readZip(
      createZip([
        { name: "install.sh", data: "#!/bin/bash\n", executable: true },
        { name: "config", data: 'GROUP_ID="Work"\n' },
      ]),
    );
    expect(script!.madeBy).toBe(3);
    expect(script!.mode).toBe(0o755);
    expect(config!.mode).toBe(0o644);
  });

  it("flags names as UTF-8", () => {
    const [entry] = readZip(createZip([{ name: "olvass-el-ő.txt", data: "ű" }]));
    expect(entry!.name).toBe("olvass-el-ő.txt");
    expect(entry!.utf8Name).toBe(true);
    expect(entry!.data.toString("utf8")).toBe("ű");
  });

  it("stamps entries with the given time in MS-DOS format", () => {
    const [entry] = readZip(createZip([{ name: "x", data: "x" }], new Date("2026-09-22T14:30:08Z")));
    expect(entry!.dosDate).toBe(((2026 - 1980) << 9) | (9 << 5) | 22);
    expect(entry!.dosTime).toBe((14 << 11) | (30 << 5) | 4);
  });
});
