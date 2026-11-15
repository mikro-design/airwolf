// IEEE 802.11-2020 19.3.11.7.3–5. Integer-only HT20 metadata validation;
// no signal processing runs in JavaScript. The LDPC layout determines whether
// an extra symbol group is required by shortening/puncturing constraints.
function ldpcSymbolCount(psduLength, mcs, stbc = 0) {
  if (
    !Number.isInteger(psduLength) ||
    psduLength < 4 ||
    psduLength > 65535 ||
    !Number.isInteger(mcs) ||
    mcs < 0 ||
    mcs > 7 ||
    ![0, 1].includes(stbc)
  )
    throw new Error('Invalid HT20 LDPC layout');
  const bitsPerSubcarrier = [1, 2, 2, 4, 4, 6, 6, 6][mcs];
  const denominator = [2, 2, 4, 2, 4, 3, 4, 6][mcs];
  const numerator = denominator - 1;
  const coded = 52 * bitsPerSubcarrier;
  const group = stbc + 1;
  const payload = 8 * psduLength + 16;
  const dataBits = (coded * numerator) / denominator;
  let available = coded * group * Math.ceil(payload / (dataBits * group));
  const threshold = (n) =>
    available * denominator >= payload * denominator + n * (denominator - numerator);
  let words = 1,
    block = 1944;
  if (available <= 648) block = threshold(912) ? 1296 : 648;
  else if (available <= 1296) block = threshold(1464) ? 1944 : 1296;
  else if (available <= 1944) block = 1944;
  else if (available <= 2592) {
    words = 2;
    block = threshold(2916) ? 1944 : 1296;
  } else words = Math.ceil(payload / ((1944 * numerator) / denominator));
  const shortened = Math.max(0, (words * block * numerator) / denominator - payload);
  const parity = (words * block * (denominator - numerator)) / denominator;
  const punctured = Math.max(0, words * block - available - shortened);
  if (
    (10 * punctured > parity &&
      5 * shortened * (denominator - numerator) < 6 * punctured * numerator) ||
    10 * punctured > 3 * parity
  )
    available += coded * group;
  return available / coded;
}
module.exports = { ldpcSymbolCount };
