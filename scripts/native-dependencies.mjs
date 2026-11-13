import { openSync, closeSync, fstatSync, readSync } from 'node:fs';

// Read PE import directories directly. objdump expands epan's enormous unwind
// tables even when only DLL names are needed. No executable code is loaded.
// https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
export async function windowsDependencies(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const invalid = (reason) => new Error(`Invalid PE imports in ${file}: ${reason}`);
    const read = (offset, length) => {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(length) ||
        length < 0 ||
        length > 65536 ||
        offset + length > size
      )
        throw invalid('range outside file');
      const bytes = Buffer.alloc(length);
      if (readSync(fd, bytes, 0, length, offset) !== length) throw invalid('truncated file');
      return bytes;
    };
    const dos = read(0, 64);
    if (dos.readUInt16LE(0) !== 0x5a4d) throw invalid('missing DOS signature');
    const peOffset = dos.readUInt32LE(60);
    const pe = read(peOffset, 24);
    if (pe.readUInt32LE(0) !== 0x4550) throw invalid('missing PE signature');
    const sectionCount = pe.readUInt16LE(6);
    if (sectionCount > 96) throw invalid('too many sections');
    const optional = read(peOffset + 24, pe.readUInt16LE(20));
    const magic = optional.readUInt16LE(0);
    if (![0x10b, 0x20b].includes(magic)) throw invalid('unknown optional header');
    const directoryOffset = magic === 0x20b ? 112 : 96;
    if (optional.length < directoryOffset) throw invalid('short optional header');
    const directories = optional.readUInt32LE(directoryOffset - 4);
    const imageBase =
      magic === 0x20b ? optional.readBigUInt64LE(24) : BigInt(optional.readUInt32LE(28));
    const headersSize = optional.readUInt32LE(60);
    const sections = read(peOffset + 24 + optional.length, sectionCount * 40);
    const locate = (rva, length = 1) => {
      if (rva < headersSize && rva + length <= headersSize)
        return { offset: rva, available: Math.min(headersSize, size) - rva };
      for (let i = 0; i < sectionCount; i++) {
        const base = sections.readUInt32LE(i * 40 + 12);
        const rawSize = sections.readUInt32LE(i * 40 + 16);
        const rawOffset = sections.readUInt32LE(i * 40 + 20);
        const delta = rva - base;
        if (delta >= 0 && delta + length <= rawSize) {
          const offset = rawOffset + delta;
          return { offset, available: Math.min(rawSize - delta, size - offset) };
        }
      }
      throw invalid('unmapped RVA');
    };
    const names = new Set();
    for (const [index, stride, nameOffset] of [
      [1, 20, 12],
      [13, 32, 4],
    ]) {
      if (index >= directories) continue;
      const at = directoryOffset + index * 8;
      if (at + 8 > optional.length) throw invalid('missing import directory');
      const rva = optional.readUInt32LE(at),
        length = optional.readUInt32LE(at + 4);
      if (!rva && !length) continue;
      let terminated = false;
      for (let i = 0; i < Math.min(4096, Math.floor(length / stride)); i++) {
        const entry = read(locate(rva + i * stride, stride).offset, stride);
        if (entry.every((byte) => byte === 0)) {
          terminated = true;
          break;
        }
        let nameRva = entry.readUInt32LE(nameOffset);
        if (index === 13 && !(entry.readUInt32LE(0) & 1)) {
          const relative = BigInt(nameRva) - imageBase;
          if (relative < 0n || relative > 0xffffffffn) throw invalid('invalid delay-import VA');
          nameRva = Number(relative);
        }
        const location = locate(nameRva);
        const name = read(location.offset, Math.min(4096, location.available));
        const end = name.indexOf(0);
        if (end <= 0 || end > 255) throw invalid('invalid DLL name');
        const dll = name.subarray(0, end).toString('ascii');
        if (!/^[a-zA-Z0-9_.+-]+$/.test(dll)) throw invalid('invalid DLL name');
        names.add(dll);
      }
      if (!terminated) throw invalid('unterminated import directory');
    }
    return [...names];
  } finally {
    closeSync(fd);
  }
}
