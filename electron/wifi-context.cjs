// Receiver observations, validated independently of MAC dissection. A valid
// HT-SIG is necessary but never substitutes for an MPDU's own captured FCS.
function validateWifi(event) {
  if (event.sampleRateHz !== 20000000) throw new Error('Invalid Wi-Fi sample rate');
  if (event.wifiPhy === 'ht') {
    const h = event.wifiHt;
    const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
    if (
      !h ||
      !integer(h.mcs, 0, 7) ||
      ![400, 800].includes(h.guardNs) ||
      !['bcc', 'ldpc'].includes(h.coding) ||
      !['mixed', 'greenfield'].includes(h.format) ||
      !integer(h.stbc, 0, 1) ||
      !integer(h.extensionStreams, 0, 3 - h.stbc) ||
      !integer(h.psduLength, 4, 65535) ||
      !integer(h.symbols, 1, 20166) ||
      (h.stbc && h.symbols % 2) ||
      (h.format === 'greenfield' && h.guardNs !== 800) ||
      event.wifiPreamble !== undefined
    )
      throw new Error('Invalid HT20 PHY context');
    const dataBits = [26, 52, 78, 104, 156, 208, 234, 260][h.mcs];
    const rate = dataBits / (h.guardNs === 400 ? 3.6 : 4);
    const stride = h.guardNs === 400 ? 72 : 80;
    const preamble =
      (h.format === 'greenfield' ? 480 : 720) +
      80 * (h.stbc + (h.extensionStreams === 3 ? 4 : h.extensionStreams));
    if (
      preamble + stride * h.symbols > (h.format === 'greenfield' ? 200000 : 109680) ||
      !Number.isFinite(event.wifiRateMbps) ||
      Math.abs(event.wifiRateMbps - rate) > 0.001 ||
      event.endSample - event.firstSample !== preamble + stride * h.symbols ||
      (h.coding === 'bcc' &&
        h.symbols !==
          (h.stbc ? 2 : 1) * Math.ceil((16 + 8 * h.psduLength + 6) / ((h.stbc ? 2 : 1) * dataBits)))
    )
      throw new Error('Inconsistent HT20 timing or rate');
    if (
      h.aggregateOffset === undefined
        ? h.psduLength !== event.bytes.length
        : !integer(h.aggregateOffset, 0, h.psduLength - event.bytes.length - 4) ||
          h.aggregateOffset % 4
    )
      throw new Error('Invalid HT20 aggregate member');
    return event;
  }
  const dsss = [1, 2].includes(event.wifiRateMbps),
    cck = [5.5, 11].includes(event.wifiRateMbps);
  if (
    event.wifiHt !== undefined ||
    ![1, 2, 5.5, 11, 6, 9, 12, 18, 24, 36, 48, 54].includes(event.wifiRateMbps) ||
    ((dsss || cck) &&
      (event.frequencyHz >= 3000000000 ||
        event.wifiPhy !== (dsss ? 'dsss' : 'cck') ||
        !['long', 'short'].includes(event.wifiPreamble))) ||
    (!dsss &&
      !cck &&
      ((event.wifiPhy !== undefined && event.wifiPhy !== 'ofdm') ||
        event.wifiPreamble !== undefined)) ||
    (event.wifiRateMbps === 1 && event.wifiPreamble === 'short')
  )
    throw new Error('Invalid Wi-Fi PHY context');
  return event;
}
module.exports = { validateWifi };
