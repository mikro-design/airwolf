// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// 5G NR SS/PBCH block (MIB) events from the native NR search. Every field is
// checked against the BCCH-BCH-Message bytes it describes and against the
// sync raster the receiver searched at this tuning (TS 38.101-1 5.4.3).
const NR_RATES = [16000000, 20000000];
const KEYS = [
  'nrChannel',
  'nrPci',
  'nrSfn',
  'nrHalfFrame',
  'nrSsbIndex',
  'nrScsKhz',
  'nrKSsb',
  'nrSsbFrequencyHz',
  'nrSnrDb',
  'nrRsrpDb',
  'nrContext',
];
const STATUS = ['nrSearches', 'nrUnconfirmed', 'nrSkippedSamples'];
function nrScsKhz(frequencyHz) {
  return frequencyHz >= 3000000000 ? 30 : 15;
}
// Largest SSB centre offset from the tuning that the receiver searches.
function nrSpanHz(frequencyHz) {
  return nrScsKhz(frequencyHz) === 15 ? 4900000 : 3100000;
}
function onRaster(hz) {
  if (!Number.isSafeInteger(hz) || hz <= 0) return false;
  if (hz < 3000000000) {
    const m = (hz % 1200000) / 50000;
    return hz % 50000 === 0 && hz >= 1200000 && [1, 3, 5].includes(m);
  }
  return (hz - 3000000000) % 1440000 === 0 && hz < 24250000000;
}
function validTuning(frequencyHz, sampleRateHz) {
  return (
    Number.isSafeInteger(frequencyHz) &&
    frequencyHz >= 400000000 &&
    frequencyHz <= 6000000000 &&
    NR_RATES.includes(sampleRateHz)
  );
}
function validateNrContext(context, frequencyHz) {
  if (
    !context ||
    typeof context !== 'object' ||
    Array.isArray(context) ||
    Object.keys(context).some((k) => !['pci', 'scsKhz', 'ssbFrequencyHz', 'cfoHz'].includes(k)) ||
    !Number.isInteger(context.pci) ||
    context.pci < 0 ||
    context.pci > 1007 ||
    ![15, 30].includes(context.scsKhz) ||
    !onRaster(context.ssbFrequencyHz) ||
    !Number.isFinite(context.cfoHz) ||
    Math.abs(context.cfoHz) > 200000 ||
    (frequencyHz !== undefined &&
      (context.scsKhz !== nrScsKhz(frequencyHz) ||
        Math.abs(context.ssbFrequencyHz - frequencyHz) > nrSpanHz(frequencyHz)))
  )
    throw new Error('Invalid NR receive context');
  return context;
}
// The MIB's SFN MSBs (bits 1-6) and kSSB LSBs (bits 8-11), from its bytes.
function mibFields(bytes) {
  const v = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  return { choice: v >> 23, sfnHigh: (v >> 17) & 63, kSsbLow: (v >> 12) & 15 };
}
function validateNrPacket(event) {
  const scs = nrScsKhz(event.frequencyHz);
  const fields = event.bytes?.length === 3 ? mibFields(event.bytes) : undefined;
  if (
    !validTuning(event.frequencyHz, event.sampleRateHz) ||
    event.channel !== 0 ||
    event.nrChannel !== 'bcch-bch' ||
    !fields ||
    fields.choice !== 0 ||
    !Number.isInteger(event.nrPci) ||
    event.nrPci < 0 ||
    event.nrPci > 1007 ||
    !Number.isInteger(event.nrSfn) ||
    event.nrSfn < 0 ||
    event.nrSfn > 1023 ||
    event.nrSfn >> 4 !== fields.sfnHigh ||
    typeof event.nrHalfFrame !== 'boolean' ||
    !Number.isInteger(event.nrSsbIndex) ||
    event.nrSsbIndex < 0 ||
    event.nrSsbIndex > 7 ||
    event.nrScsKhz !== scs ||
    !Number.isInteger(event.nrKSsb) ||
    event.nrKSsb < 0 ||
    event.nrKSsb > 23 ||
    (event.nrKSsb & 15) !== fields.kSsbLow ||
    !onRaster(event.nrSsbFrequencyHz) ||
    Math.abs(event.nrSsbFrequencyHz - event.frequencyHz) > nrSpanHz(event.frequencyHz) ||
    [
      ['nrSnrDb', -50, 100],
      ['nrRsrpDb', -200, 50],
    ].some(
      ([key, low, high]) =>
        event[key] !== undefined &&
        (!Number.isFinite(event[key]) || event[key] < low || event[key] > high),
    ) ||
    event.integrity !== 'valid'
  )
    throw new Error('Invalid NR radio metadata');
  if (event.nrContext !== undefined) {
    validateNrContext(event.nrContext, event.frequencyHz);
    if (
      event.nrContext.pci !== event.nrPci ||
      event.nrContext.scsKhz !== event.nrScsKhz ||
      event.nrContext.ssbFrequencyHz !== event.nrSsbFrequencyHz
    )
      throw new Error('NR receive context disagrees with packet metadata');
  }
}
function rejectNrMetadata(event) {
  if (KEYS.some((k) => event[k] !== undefined)) throw new Error('NR metadata requires NR decoding');
}
function validateNrStatus(event) {
  for (const key of STATUS)
    if (
      event[key] !== undefined &&
      (event.decoder !== 'nr' || !Number.isSafeInteger(event[key]) || event[key] < 0)
    )
      throw new Error('Invalid NR search statistics');
}
module.exports = {
  NR_RATES,
  nrScsKhz,
  nrSpanHz,
  onRaster,
  validTuning,
  validateNrContext,
  validateNrPacket,
  rejectNrMetadata,
  validateNrStatus,
};
