// Field text is a view of the original bytes. Never replace bytes or decode ciphertext.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const printable = (text: string) => !/[\p{C}\p{Zl}\p{Zp}]/u.test(text);
export function utf8Text(bytes: number[]): string | null {
  try {
    const value = utf8.decode(new Uint8Array(bytes));
    return [...value]
      .map((c) => (printable(c) ? c : `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}`))
      .join('');
  } catch {
    return null;
  }
}
export function textRuns(bytes: number[], offset: number) {
  const result: { value: string; offset: number; length: number; inferred: boolean }[] = [];
  let start = 0,
    value = '';
  const flush = (end: number) => {
    // Four printable code points and a letter/digit limit accidental binary matches.
    if ([...value].length >= 4 && /[\p{L}\p{N}]/u.test(value))
      result.push({ value, offset: offset + start, length: end - start, inferred: true });
    value = '';
  };
  for (let i = 0; i < bytes.length;) {
    const byte = bytes[i];
    const size =
      byte < 0x80
        ? 1
        : byte >= 0xc2 && byte <= 0xdf
          ? 2
          : byte >= 0xe0 && byte <= 0xef
            ? 3
            : byte >= 0xf0 && byte <= 0xf4
              ? 4
              : 0;
    let char = '';
    try {
      if (size && i + size <= bytes.length)
        char = utf8.decode(new Uint8Array(bytes.slice(i, i + size)));
    } catch {
      /* Binary boundary. */
    }
    if (char && printable(char)) {
      if (!value) start = i;
      value += char;
      i += size;
    } else {
      flush(i);
      i++;
    }
  }
  flush(bytes.length);
  return result;
}
