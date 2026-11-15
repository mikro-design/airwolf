// Validate metadata identity only; demodulation and CRC calculation stay native.
function periodicAddress(bytes, coded = false) {
  if (!Array.isArray(bytes) || bytes.length < 4) return false;
  const aa = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
  const pop = (value) => {
    let n = 0;
    for (value >>>= 0; value; value = (value & (value - 1)) >>> 0) ++n;
    return n;
  };
  if (pop(aa ^ 0x8e89bed6) <= 1 || bytes.slice(0, 4).every((x) => x === bytes[0])) return false;
  let run = 1,
    transitions = 0,
    high = 0,
    low = 0;
  for (let bit = 1; bit < 32; bit++) {
    if (((aa >>> bit) & 1) === ((aa >>> (bit - 1)) & 1)) {
      if (++run > 6) return false;
    } else {
      run = 1;
      transitions++;
      if (bit >= 27) high++;
      if (bit < 16) low++;
    }
  }
  return transitions <= 24 && high >= 2 && (!coded || (pop(aa & 255) >= 3 && low <= 11));
}
function periodicCte(bytes) {
  if (
    !Array.isArray(bytes) ||
    bytes.length < 12 ||
    bytes[4] !== 7 ||
    bytes[5] + 9 !== bytes.length ||
    bytes[6] >> 6 ||
    (bytes[6] & 63) < 2 ||
    (bytes[6] & 63) + 1 > bytes[5] ||
    !(bytes[7] & 4) ||
    bytes[7] & 0xa3
  )
    return null;
  const fields = 2 + (bytes[7] & 8 ? 2 : 0) + (bytes[7] & 16 ? 3 : 0) + (bytes[7] & 64 ? 1 : 0);
  if ((bytes[6] & 63) < fields) return null;
  const cte = bytes[8];
  return cte & 0x20 || cte >> 6 === 3 || (cte & 31) < 2 || (cte & 31) > 20 ? null : (cte & 31) * 8;
}
module.exports = { periodicAddress, periodicCte };
