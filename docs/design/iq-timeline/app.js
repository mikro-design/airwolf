// Interaction-only design study. All signal geometry and frame metadata below
// are illustrative. This page neither receives IQ nor runs a radio decoder.
const $ = (selector) => document.querySelector(selector);
const frames = [
  {
    id: 181,
    start: 75,
    end: 183,
    type: 'Data',
    source: 'Device A',
    bytes: 256,
    status: 'valid',
    lane: 'device',
  },
  {
    id: 182,
    start: 199,
    end: 227,
    type: 'ACK',
    source: 'Unattributed control',
    bytes: 14,
    status: 'valid',
    lane: 'control',
  },
  {
    id: 184,
    start: 390,
    end: 530,
    type: 'Data',
    source: 'Device A',
    bytes: 356,
    status: 'valid',
    lane: 'device',
  },
  {
    id: 185,
    start: 546,
    end: 574,
    type: 'ACK',
    source: 'Unattributed control',
    bytes: 14,
    status: 'valid',
    lane: 'control',
  },
  {
    id: 'B7',
    start: 695,
    end: 770,
    type: 'RF burst',
    source: 'Unknown',
    bytes: null,
    status: 'unknown',
    lane: 'activity',
  },
  {
    id: 187,
    start: 830,
    end: 950,
    type: 'Candidate',
    source: 'Untrusted fields',
    bytes: 290,
    status: 'bad',
    lane: 'failed',
  },
  {
    id: 188,
    start: 966,
    end: 994,
    type: 'ACK',
    source: 'Unattributed control',
    bytes: 14,
    status: 'valid',
    lane: 'control',
  },
];
const groups = [
  { id: 'device', name: 'Device A', sub: 'Observed transmitter', icon: '⌁', color: 'cyan' },
  {
    id: 'control',
    name: 'Control frames',
    sub: 'No transmitter address',
    icon: '↔',
    color: 'cyan',
  },
  {
    id: 'failed',
    name: 'Failed candidates',
    sub: 'Untrusted decoded fields',
    icon: '!',
    color: 'amber',
  },
  { id: 'activity', name: 'RF activity', sub: 'No frame recovered', icon: '∿', color: 'amber' },
];
const origin = 16_840_000; // 842 ms into a 20 MS/s illustrative take.
// Fixed illustrative MAC bytes, generated offline with independently checked
// FCS. These are not output from decoding the illustrative waveform geometry.
const previewHex = {
  181: {
    hex: '0800000002000000000202000000000102000000000310057624313e4b586572202d3a4754616e7b293643505d6a7725323f4c596673212e3b4855626f7c2a3744515e6b782633404d5a6774222f3c495663707d2b3845525f6c792734414e5b687523303d4a5764717e2c394653606d7a2835424f5c697624313e4b586572202d3a4754616e7b293643505d6a7725323f4c596673212e3b4855626f7c2a3744515e6b782633404d5a6774222f3c495663707d2b3845525f6c792734414e5b687523303d4a5764717e2c394653606d7a2835424f5c697624313e4b586572202d3a4754616e7b293643505d6a7725323f4c596673212e3b4855626f7ca8637583',
    calculated: 'a8637583',
    received: 'a8637583',
  },
  182: { hex: 'd4000000020000000001d8d6bf8f', calculated: 'd8d6bf8f', received: 'd8d6bf8f' },
  184: {
    hex: '080000000200000000020200000000010200000000034005792734414e5b687523303d4a5764717e2c394653606d7a2835424f5c697624313e4b586572202d3a4754616e7b293643505d6a7725323f4c596673212e3b4855626f7c2a3744515e6b782633404d5a6774222f3c495663707d2b3845525f6c792734414e5b687523303d4a5764717e2c394653606d7a2835424f5c697624313e4b586572202d3a4754616e7b293643505d6a7725323f4c596673212e3b4855626f7c2a3744515e6b782633404d5a6774222f3c495663707d2b3845525f6c792734414e5b687523303d4a5764717e2c394653606d7a2835424f5c697624313e4b586572202d3a4754616e7b293643505d6a7725323f4c596673212e3b4855626f7c2a3744515e6b782633404d5a6774222f3c495663707d2b3845525f6c792734414e5b687523303d4a5764717e2c394653606d7a2835424f5c697624313e4b586572202d3a4754614b2f2d13',
    calculated: '4b2f2d13',
    received: '4b2f2d13',
  },
  185: { hex: 'd4000000020000000001d8d6bf8f', calculated: 'd8d6bf8f', received: 'd8d6bf8f' },
  187: {
    hex: '0800000002000000000202000000000102000000000370057c2a3744515e6b782633404d5a6774222f3c495663707d2b3845525f6c792734414e5b687523303d4a5764717e2c394653606d7a2835424f5c697624313e4b586572202d3a4754616e7b293643505d6a7725323f4c596673212e3b4855626f7c2a3744515e6b782633404d5a6774222f3c495663707d2b3845525f6c792734414e5b687523303d4a5764717e2c394653606d7a2835424f5c697624313e4b586572202d3a4754616e7b293643505d6a7725323f4c596673212e3b4855626f7c2a3744515e6b782633404d5a6774222f3c495663707d2b3845525f6c792734414e5b687523303d4a5764717e2c394653606d7a2835424f5c697624313e4b586572202d3a475461851556a9',
    calculated: '841556a9',
    received: '851556a9',
  },
  188: { hex: 'd4000000020000000001d8d6bf8f', calculated: 'd8d6bf8f', received: 'd8d6bf8f' },
};
const state = {
  view: [0, 1100],
  selection: [390, 530],
  selected: 184,
  cursor: 620,
  tool: 'select',
  detail: 'iq',
  playing: false,
  decoded: null,
};
const total = 1100;
let drag = null;
let repaint = null;
let lastPlayback = 0;
const fmt = (n) => n.toLocaleString('en-US');
const sample = (us) => origin + Math.round(us * 20);
const microseconds = (n) => (n - origin) / 20;
const clamp = (n, lo = 0, hi = total) => Math.min(hi, Math.max(lo, n));
const selectedFrame = () => frames.find((frame) => frame.id === state.selected);
const labelWidth = () =>
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lane'));
const plotWidth = () => $('#timeline').clientWidth - labelWidth();
const xAt = (t, width = plotWidth()) =>
  ((t - state.view[0]) / (state.view[1] - state.view[0])) * width;
const timeAt = (clientX) =>
  state.view[0] +
  ((clientX - $('#timeline').getBoundingClientRect().left - labelWidth()) / plotWidth()) *
    (state.view[1] - state.view[0]);

function canvasContext(canvas) {
  const width = canvas.clientWidth,
    height = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, width, height };
}
function energy(t) {
  let value = 0.015;
  for (const frame of frames) {
    if (t < frame.start || t > frame.end) continue;
    const fraction = (t - frame.start) / (frame.end - frame.start);
    const edge = Math.min(1, fraction * 30, (1 - fraction) * 30);
    const level =
      frame.status === 'unknown'
        ? 0.29
        : frame.status === 'bad'
          ? 0.38
          : frame.type === 'ACK'
            ? 0.42
            : 0.6;
    value +=
      edge * level * (0.65 + 0.18 * Math.sin(t * 0.31) ** 2 + 0.17 * Math.sin(t * 0.87) ** 2);
  }
  return value;
}
function drawWave(canvas, kind, first, end, thumbnail = false) {
  const { ctx, width, height } = canvasContext(canvas);
  if (!width || !height) return;
  const center = height / 2;
  if (!thumbnail) {
    ctx.strokeStyle = '#29404d80';
    ctx.lineWidth = 1;
    for (const fraction of [0.15, 0.5, 0.85]) {
      ctx.beginPath();
      ctx.moveTo(0, height * fraction + 0.5);
      ctx.lineTo(width, height * fraction + 0.5);
      ctx.stroke();
    }
  }
  const color = kind === 'q' ? '#dab17a' : '#80c6d3';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.globalAlpha = thumbnail ? 0.8 : 0.85;
  ctx.beginPath();
  for (let x = 0; x < width; x += 1) {
    const t = first + (x / width) * (end - first);
    const a = energy(t) * height * (thumbnail ? 0.65 : 0.65);
    const jitter =
      0.25 + 0.75 * Math.abs(Math.sin(t * 4.71 + (kind === 'q' ? 1.57 : 0)) * Math.cos(t * 1.23));
    ctx.moveTo(x + 0.5, center - a * jitter);
    ctx.lineTo(x + 0.5, center + a * (0.3 + 0.7 * jitter));
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  if (!thumbnail) {
    ctx.fillStyle = '#69889b';
    ctx.font = '9px monospace';
    ctx.fillText('+1', 5, 10);
    ctx.fillText('−1', 5, height - 4);
  }
}
function drawSpectrogram() {
  const { ctx, width, height } = canvasContext($('#spectrogram canvas'));
  const columns = Math.ceil(width / 3),
    rows = Math.ceil(height / 3);
  for (let x = 0; x < columns; x++)
    for (let y = 0; y < rows; y++) {
      const t = state.view[0] + (x / columns) * (state.view[1] - state.view[0]);
      const band = Math.exp(-(((y / rows - 0.5) * 2.5) ** 8));
      const texture = 0.5 + 0.5 * Math.sin(x * 17.31 + y * 6.29) * Math.cos(x * 2.77 - y * 1.34);
      const value = energy(t) * band * (0.55 + 0.45 * texture);
      ctx.fillStyle = `rgb(${Math.round(15 + value * 145)},${Math.round(29 + value * 190)},${Math.round(38 + value * 110)})`;
      ctx.fillRect(x * 3, y * 3, 3, 3);
    }
}
function tickStep() {
  const target = (state.view[1] - state.view[0]) / 10;
  const scale = 10 ** Math.floor(Math.log10(target));
  return [1, 2, 5, 10].map((x) => x * scale).find((x) => x >= target);
}
function drawRuler() {
  const first = state.view[0],
    end = state.view[1],
    step = tickStep();
  $('#ruler').replaceChildren();
  for (let time = Math.ceil(first / step) * step; time < end; time += step) {
    const tick = document.createElement('span');
    tick.style.left = `${((time - first) / (end - first)) * 100}%`;
    tick.textContent = time.toFixed(step < 1 ? 2 : step < 10 ? 1 : 0);
    $('#ruler').append(tick);
  }
  for (const track of document.querySelectorAll('.frame-track .track-content')) {
    track.style.backgroundSize = `${(step / (end - first)) * 100}% 100%`;
    track.style.backgroundImage = 'linear-gradient(to right,#27354080 1px,transparent 1px)';
    track.style.backgroundPositionX = `${-((first % step) / step) * ((step / (end - first)) * plotWidth())}px`;
  }
}
function buildTracks() {
  const byFrame = $('#group').value === 'frame';
  const rows = byFrame
    ? frames.map((f) => ({
        id: String(f.id),
        name: `${f.status === 'unknown' ? 'Burst' : 'Frame'} #${f.id}`,
        sub: f.type,
        icon: f.status === 'bad' ? '!' : '⌁',
        color: f.status === 'valid' ? 'cyan' : 'amber',
        frames: [f],
      }))
    : groups.map((g) => ({ ...g, frames: frames.filter((f) => f.lane === g.id) }));
  $('#frame-tracks').innerHTML = rows
    .map(
      (row) =>
        `<div class="track frame-track"><div class="lane-label"><span class="track-icon ${row.color}">${row.icon}</span><div><b>${row.name}</b><small>${row.sub}</small></div><span class="lane-unit">${row.frames.length}</span></div><div class="track-content selectable">${row.frames.map((f) => `<button class="clip ${f.status === 'valid' ? '' : f.status}" data-id="${f.id}" aria-label="Select ${f.status === 'unknown' ? 'burst' : 'frame'} ${f.id}" title="#${f.id} · ${f.type} · ${f.start}–${f.end} µs · ${f.status === 'valid' ? 'FCS valid' : f.status === 'bad' ? 'FCS failed' : 'No decoded frame'}"><span class="clip-title"></span><canvas></canvas><span class="clip-note"></span></button>`).join('')}</div></div>`,
    )
    .join('');
}
function updateClips() {
  for (const element of document.querySelectorAll('.clip')) {
    const frame = frames.find((f) => String(f.id) === element.dataset.id);
    const first = Math.max(frame.start, state.view[0]),
      end = Math.min(frame.end, state.view[1]);
    element.hidden = end <= first;
    element.style.left = `${xAt(first)}px`;
    element.style.width = `${Math.max(2, xAt(end) - xAt(first))}px`;
    element.classList.toggle('selected', frame.id === state.selected);
    element.setAttribute('aria-pressed', String(frame.id === state.selected));
    const width = xAt(end) - xAt(first);
    element.querySelector('.clip-title').innerHTML =
      width > 100 ? `<b>#${frame.id}</b>${frame.type}` : width > 34 ? frame.type : '';
    element.querySelector('.clip-note').textContent =
      width > 105
        ? frame.status === 'unknown'
          ? 'undecoded'
          : frame.status === 'bad'
            ? 'FCS failed'
            : `${frame.bytes} B · ✓`
        : '';
    drawWave(element.querySelector('canvas'), 'i', first, end, true);
  }
}
const spacedHex = (value) => value.match(/.{2}/g)?.join(' ').toUpperCase() ?? '';
function detailsMarkup(frame) {
  const duration = (state.selection[1] - state.selection[0]).toFixed(3);
  if (!frame)
    return `<div class="inspector-content"><div class="frame-title"><h2>IQ selection</h2><span class="crc unknown">Raw samples</span></div><p class="frame-subtitle">A sample range can be saved and inspected without a decoded frame.</p><div class="section-label">SELECTED INTERVAL</div><dl class="field-list"><dt>Duration</dt><dd>${duration} µs</dd><dt>Samples</dt><dd>${fmt(sample(state.selection[1]) - sample(state.selection[0]))}</dd><dt>Capture</dt><dd>Take 014</dd><dt>Channel center</dt><dd>5300.000 MHz</dd></dl><div class="divider"></div><p class="frame-subtitle">Drag either edge to trim the selection. Zoom in to examine the waveform; the source recording stays intact.</p></div>`;
  const unknown = frame.status === 'unknown',
    bad = frame.status === 'bad';
  const heading = unknown ? `Burst #${frame.id}` : `Frame #${frame.id}`;
  const status = unknown ? 'Undecoded' : bad ? 'FCS failed' : 'FCS valid';
  return `<div class="inspector-content"><div class="frame-title"><h2>${heading}</h2><span class="crc ${bad ? 'bad' : unknown ? 'unknown' : ''}">${status}</span></div><p class="frame-subtitle">${unknown ? 'RF activity · no frame recovered' : bad ? 'Wi-Fi candidate · decoded fields untrusted' : `Wi-Fi · ${frame.type} · non-HT OFDM`}<br>${unknown ? 'Select the burst’s IQ to investigate it.' : `Channel 60 · 5300.000 MHz`}</p>
    <div class="section-label">CAPTURE INTERVAL</div><dl class="field-list"><dt>Start in take</dt><dd>${(842 + frame.start / 1000).toFixed(3)} ms</dd><dt>Duration</dt><dd>${(frame.end - frame.start).toFixed(3)} µs</dd><dt>Samples</dt><dd>${fmt((frame.end - frame.start) * 20)}</dd><dt>Sample rate</dt><dd>20 MS/s</dd>${unknown ? '' : `<dt>PHY rate</dt><dd>24 Mb/s</dd><dt>Frame length</dt><dd>${frame.bytes} bytes</dd>`}</dl>
    <div class="divider"></div>${
      unknown
        ? '<p class="frame-subtitle">Energy was detected in this interval. No packet type, address or checksum is known.</p><p class="frame-subtitle">The burst remains visible and exportable even though decoding failed.</p>'
        : `
    <div class="section-label">DECODED FRAME</div><details class="layer" open><summary>MAC header <small>${frame.type === 'ACK' ? 'Control' : 'Data'}</small></summary><dl class="field-list"><dt>Type</dt><dd>${frame.type}${bad ? ' (untrusted)' : ''}</dd><dt>Transmitter</dt><dd>${frame.type === 'ACK' ? 'Not present' : bad ? 'Untrusted' : 'Device A'}</dd><dt>Receiver</dt><dd>${bad ? 'Untrusted' : 'Device B'}</dd>${frame.type === 'ACK' ? '' : `<dt>Sequence number</dt><dd>${frame.id - 100}</dd><dt>Retry</dt><dd>No</dd>`}</dl></details>
    <details class="layer"><summary>Payload <small>${Math.max(0, frame.bytes - 28)} B</small></summary><p class="frame-subtitle">Payload bytes and any available decoded fields stay tied to this explicitly selected frame.</p></details>
    <details class="layer" open><summary>Frame check sequence <small>CRC-32</small></summary><dl class="field-list"><dt>Received</dt><dd>${spacedHex(previewHex[frame.id].received)}</dd><dt>Calculated</dt><dd>${spacedHex(previewHex[frame.id].calculated)}</dd><dt>Result</dt><dd class="${bad ? 'bad' : 'good'}">${bad ? 'Mismatch' : 'Match'}</dd></dl></details>
    <div class="section-label">BYTES <span style="float:right;letter-spacing:0">0–${Math.min(23, frame.bytes - 1)} of ${frame.bytes}</span></div><div class="hex"><span class="highlight">${spacedHex(previewHex[frame.id].hex.slice(0, 8))}</span> ${spacedHex(previewHex[frame.id].hex.slice(8, 48))}</div><div class="hex-caption">Illustrative bytes for this layout preview</div>`
    }</div>`;
}
function signature() {
  return state.selection ? state.selection.map(sample).join(':') : '';
}
function overlappingFrames() {
  return state.selection
    ? frames.filter((f) => f.end > state.selection[0] && f.start < state.selection[1])
    : [];
}
function renderPhySections() {
  const frame = selectedFrame() ?? overlappingFrames().find((f) => f.status !== 'unknown');
  const bar = $('#phy-sections'),
    coverage = $('#coverage');
  coverage.classList.remove('cut');
  if (!state.selection || !frame || frame.status === 'unknown') {
    bar.innerHTML = '<span class="no-phy">No known PHY boundaries in this selection</span>';
    coverage.textContent = state.selection
      ? 'Original IQ · selection can be saved without a decode'
      : 'Select a frame or an IQ range';
    return;
  }
  const [first, end] = state.selection,
    span = end - first;
  const sections = [
    {
      start: frame.start,
      end: frame.start + 16,
      text: 'Preamble',
      title: 'Preamble · STF + LTF · 16 µs',
      style: '',
    },
    {
      start: frame.start + 16,
      end: frame.start + 20,
      text: 'PHY',
      title: 'L-SIG · PHY rate and length · 4 µs',
      style: 'phy-header',
    },
    {
      start: frame.start + 20,
      end: frame.end,
      text: `DATA · ${Math.round((frame.end - frame.start - 20) / 4)} symbols`,
      title: 'OFDM data symbols · MAC bytes are coded and interleaved',
      style: 'phy-data',
    },
  ];
  bar.innerHTML = sections
    .filter((s) => s.end > first && s.start < end)
    .map(
      (s) =>
        `<button class="${s.style}" title="${s.title}" data-phy-start="${s.start}" data-phy-end="${s.end}" style="left:${Math.max(0, (s.start - first) / span) * 100}%;width:${((Math.min(end, s.end) - Math.max(first, s.start)) / span) * 100}%">${s.text}</button>`,
    )
    .join('');
  const missingStart = Math.max(0, first - frame.start),
    missingEnd = Math.max(0, frame.end - end);
  if (missingStart || missingEnd) {
    coverage.classList.add('cut');
    coverage.innerHTML = `<span>⚠ Frame cut · ${missingStart ? `${missingStart.toFixed(3)} µs missing at start` : `${missingEnd.toFixed(3)} µs missing at end`}</span><button data-restore="${frame.id}">Include complete frame</button>`;
  } else {
    coverage.innerHTML = '<span>✓ Preamble included</span><span>✓ Frame end included</span>';
  }
}
function renderDecode() {
  const panel = $('#selection-decode');
  $('#decode-selection').disabled = !state.selection;
  if (!state.selection) {
    panel.innerHTML =
      '<div class="decode-title unknown">No IQ selected</div><p class="decode-summary">Select samples to see what they decode to.</p>';
    return;
  }
  if (!state.decoded || state.decoded.signature !== signature()) {
    panel.innerHTML =
      '<div class="decode-title unknown">Selection changed<span class="decode-stamp">PREVIEW</span></div><p class="decode-summary">Release the selection to check these samples.</p>';
    return;
  }
  const recovered = state.decoded.frames;
  if (!recovered.length) {
    const partial = overlappingFrames().find((f) => f.status !== 'unknown');
    panel.innerHTML = `<div class="decode-title unknown">${partial ? 'Incomplete frame selection' : '0 frames recovered'}<span class="decode-stamp">PREVIEW RESULT</span></div><p class="decode-summary">${partial ? `The range cuts frame #${partial.id}. Include its start and end, then check again.` : 'RF activity remains selectable. These samples produced no decoded frame in this example.'}</p><div class="decode-footer">No verified bytes · IQ can still be saved</div>`;
    return;
  }
  const frame = recovered.find((f) => f.id === state.selected) ?? recovered[0];
  const good = recovered.filter((f) => f.status === 'valid').length;
  const bytes = previewHex[frame.id];
  const firstBytes = spacedHex(bytes.hex.slice(0, 32));
  panel.innerHTML = `<div class="decode-title ${frame.status === 'bad' ? 'bad' : ''}">${recovered.length === 1 ? (frame.status === 'bad' ? '1 candidate · FCS failed' : '✓ 1 frame · FCS valid') : `${recovered.length} frames · ${good} FCS valid`}<span class="decode-stamp">PREVIEW RESULT</span></div>
    <div class="decode-summary">#${frame.id} ${frame.type} · ${frame.bytes} bytes · 24 Mb/s</div>
    <div class="decode-bytes" aria-label="Recovered bytes"><b>${firstBytes}</b><span>…</span></div>
    <div class="decode-footer">${frame.status === 'valid' ? `<strong>Bytes match captured #${frame.id}</strong>` : 'Checksum mismatch · fields untrusted'}<span>FCS ${spacedHex(bytes.received)}</span></div>
    ${recovered.length > 1 ? `<div class="decode-frame-list">${recovered.map((f) => `<button data-result="${f.id}">#${f.id} ${f.type}</button>`).join('')}</div>` : ''}`;
}
function decodeSelection() {
  // This models result states only. Production must run the selected original
  // IQ through the native PHY and compare recovered bytes/CRC, not infer success
  // from annotation overlap as this explicitly illustrative prototype does.
  state.decoded = state.selection
    ? {
        signature: signature(),
        frames: frames.filter(
          (f) =>
            f.status !== 'unknown' && f.start >= state.selection[0] && f.end <= state.selection[1],
        ),
      }
    : null;
  renderDecode();
}
$('#decode-selection').onclick = decodeSelection;
$('#phy-sections').onclick = (event) => {
  const section = event.target.closest('[data-phy-start]');
  if (!section) return;
  state.selection = [Number(section.dataset.phyStart), Number(section.dataset.phyEnd)];
  render();
  decodeSelection();
};
$('#coverage').onclick = (event) => {
  const button = event.target.closest('[data-restore]');
  if (!button) return;
  selectFrame(frames.find((f) => String(f.id) === button.dataset.restore));
};
$('#selection-decode').onclick = (event) => {
  const button = event.target.closest('[data-result]');
  if (!button) return;
  const frame = frames.find((f) => String(f.id) === button.dataset.result);
  state.selected = frame.id;
  state.cursor = frame.start;
  render();
};
function drawDetail() {
  const { ctx, width, height } = canvasContext($('#detail'));
  if (!width || !height) return;
  const [first, end] = state.selection ?? state.view;
  ctx.strokeStyle = '#2c405180';
  ctx.lineWidth = 1;
  for (let y = height * 0.25; y < height; y += height * 0.25) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
    ctx.stroke();
  }
  for (let x = width / 10; x < width; x += width / 10) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();
  }
  for (const [kind, color] of state.detail === 'iq'
    ? [
        ['i', '#7ecbd5'],
        ['q', '#e3b278'],
      ]
    : [[state.detail, '#7ecbd5']]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.15;
    ctx.globalAlpha = kind === 'q' ? 0.7 : 0.95;
    ctx.beginPath();
    for (let x = 0; x < width; x++) {
      const t = first + (x / width) * (end - first),
        a = energy(t);
      const phase = Math.sin(t * 0.85) * Math.cos(t * 0.03) * 3;
      const value =
        kind === 'amplitude'
          ? a
          : kind === 'phase'
            ? phase / 4
            : a * Math.sin(t * 2.4 + (kind === 'q' ? Math.PI / 2 : 0));
      const y = height * 0.53 - value * height * 0.55;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#7594a7';
  ctx.font = '9px monospace';
  ctx.fillText(`${first.toFixed(3)} µs`, 10, height - 5);
  const last = `${end.toFixed(3)} µs`;
  ctx.fillText(last, width - ctx.measureText(last).width - 10, height - 5);
}
function updateSelection() {
  const element = $('#selection');
  element.hidden = !state.selection;
  if (state.selection) {
    const [first, end] = state.selection;
    const left = clamp(xAt(first), 0, plotWidth()),
      right = clamp(xAt(end), 0, plotWidth());
    element.style.left = `${labelWidth() + left}px`;
    element.style.width = `${Math.max(0, right - left)}px`;
    element.hidden = end <= state.view[0] || first >= state.view[1];
    for (const handle of element.children)
      handle.hidden =
        handle.dataset.handle === 'start' ? first < state.view[0] : end > state.view[1];
    $('#in-sample').value = sample(first);
    $('#out-sample').value = sample(end);
    const count = sample(end) - sample(first);
    $('#selection-length').textContent = `${(end - first).toFixed(3)} µs`;
    $('#sample-count').textContent =
      `${fmt(count)} samples · ${((count * 2) / 1000).toFixed(1)} kB`;
  } else {
    $('#selection-length').textContent = 'No selection';
    $('#sample-count').textContent = 'Click a frame or drag across a track';
  }
  for (const id of ['#in-sample', '#out-sample', '#save', '#zoom-selection'])
    $(id).disabled = !state.selection;
  $('#frame-bounds').disabled = !selectedFrame();
  $('#detail-name').textContent = selectedFrame()
    ? `/ ${selectedFrame().status === 'unknown' ? 'Burst' : 'Frame'} #${state.selected}`
    : state.selection
      ? '/ IQ selection'
      : '/ No selection';
}
function updateCursor() {
  const cursor = $('#playhead');
  cursor.style.left = `${labelWidth() + xAt(state.cursor)}px`;
  cursor.hidden = state.cursor < state.view[0] || state.cursor > state.view[1];
  $('#cursor-time').textContent = `Cursor ${state.cursor.toFixed(3)} µs`;
}
function render(updateInspector = true) {
  drawRuler();
  updateClips();
  for (const track of document.querySelectorAll('[data-wave]'))
    drawWave(track.querySelector('canvas'), track.dataset.wave, ...state.view);
  drawSpectrogram();
  updateSelection();
  updateCursor();
  drawDetail();
  renderPhySections();
  renderDecode();
  if (updateInspector)
    $('#inspector-content').innerHTML = state.selection
      ? detailsMarkup(selectedFrame())
      : '<div class="empty-inspector">Select a frame to inspect its fields and IQ.<br><br>Or drag across a track to select an undecoded interval.</div>';
}
function requestRender() {
  if (repaint) return;
  repaint = requestAnimationFrame(() => {
    repaint = null;
    render(false);
  });
}
function setView(first, span) {
  span = clamp(span, 2, total);
  first = clamp(first, 0, total - span);
  state.view = [first, first + span];
  render(false);
}
function zoom(factor, anchor = (state.view[0] + state.view[1]) / 2) {
  const old = state.view[1] - state.view[0],
    span = clamp(old * factor, 2, total);
  setView(anchor - ((anchor - state.view[0]) / old) * span, span);
}
function snap(t) {
  t = Math.round(clamp(t) * 20) / 20;
  if (!$('#snap').checked) return t;
  const threshold = ((state.view[1] - state.view[0]) * 7) / plotWidth();
  const edges = frames.flatMap((frame) => [frame.start, frame.end]);
  const nearest = edges.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
  return Math.abs(nearest - t) < threshold ? nearest : t;
}
function selectFrame(frame, extend = false) {
  state.selection =
    extend && state.selection
      ? [Math.min(frame.start, state.selection[0]), Math.max(frame.end, state.selection[1])]
      : [frame.start, frame.end];
  state.selected = extend ? null : frame.id;
  state.cursor = frame.start;
  render();
  decodeSelection();
}
$('#frame-tracks').addEventListener('click', (event) => {
  const clip = event.target.closest('.clip');
  if (clip)
    selectFrame(
      frames.find((f) => String(f.id) === clip.dataset.id),
      event.shiftKey,
    );
});
$('#frame-tracks').addEventListener('dblclick', (event) => {
  if (event.target.closest('.clip')) zoomToSelection();
});
$('#timeline').addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('.clip') || event.target.closest('.lane-label'))
    return;
  if (event.clientX < $('#timeline').getBoundingClientRect().left + labelWidth()) return;
  const handle = event.target.closest('[data-handle]');
  drag = {
    mode: handle?.dataset.handle ?? (state.tool === 'pan' ? 'pan' : 'new'),
    at: snap(timeAt(event.clientX)),
    clientX: event.clientX,
    selection: state.selection ? [...state.selection] : null,
    view: [...state.view],
  };
  if (drag.mode === 'new') {
    state.selected = null;
    state.selection = [drag.at, Math.min(total, drag.at + 0.05)];
    render();
  }
  $('#timeline').setPointerCapture(event.pointerId);
  event.preventDefault();
});
$('#timeline').addEventListener('pointermove', (event) => {
  if (!drag) return;
  const t = snap(timeAt(event.clientX));
  if (drag.mode === 'pan') {
    setView(
      drag.view[0] - ((event.clientX - drag.clientX) / plotWidth()) * (drag.view[1] - drag.view[0]),
      drag.view[1] - drag.view[0],
    );
    return;
  }
  if (drag.mode === 'start')
    state.selection = [Math.min(t, state.selection[1] - 0.05), state.selection[1]];
  else if (drag.mode === 'end')
    state.selection = [state.selection[0], Math.max(t, state.selection[0] + 0.05)];
  else state.selection = [Math.min(t, drag.at), Math.max(t, drag.at + 0.05)];
  render();
});
$('#timeline').addEventListener('pointerup', () => {
  drag = null;
  decodeSelection();
});
$('#timeline').addEventListener('pointercancel', () => {
  drag = null;
});
$('#timeline-scroll').addEventListener(
  'wheel',
  (event) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      zoom(event.deltaY > 0 ? 1.2 : 0.8, clamp(timeAt(event.clientX), ...state.view));
    } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      event.preventDefault();
      setView(
        state.view[0] +
          ((event.deltaX || event.deltaY) / plotWidth()) * (state.view[1] - state.view[0]),
        state.view[1] - state.view[0],
      );
    }
  },
  { passive: false },
);
$('#group').onchange = () => {
  buildTracks();
  render(false);
};
$('#zoom-in').onclick = () => zoom(0.5);
$('#zoom-out').onclick = () => zoom(2);
$('#fit').onclick = () => setView(0, total);
function zoomToSelection() {
  if (state.selection) {
    const span = state.selection[1] - state.selection[0];
    setView(state.selection[0] - span * 0.12, span * 1.24);
  }
}
$('#zoom-selection').onclick = zoomToSelection;
$('#select-tool').onclick = () => {
  state.tool = 'select';
  $('#select-tool').classList.add('active');
  $('#pan-tool').classList.remove('active');
};
$('#pan-tool').onclick = () => {
  state.tool = 'pan';
  $('#pan-tool').classList.add('active');
  $('#select-tool').classList.remove('active');
};
$('#frame-bounds').onclick = () => {
  if (selectedFrame()) selectFrame(selectedFrame());
};
function clearSelection() {
  state.selected = null;
  state.selection = null;
  render();
}
$('#clear').onclick = clearSelection;
for (const [index, selector] of [
  [0, '#in-sample'],
  [1, '#out-sample'],
]) {
  $(selector).onchange = () => {
    const value = Number($(selector).value);
    if (!Number.isFinite(value) || !state.selection) return;
    state.selection[index] = clamp(
      microseconds(value),
      index === 0 ? 0 : state.selection[0] + 0.05,
      index === 0 ? state.selection[1] - 0.05 : total,
    );
    render();
    decodeSelection();
  };
}
for (const button of document.querySelectorAll('[data-detail]'))
  button.onclick = () => {
    state.detail = button.dataset.detail;
    document
      .querySelectorAll('[data-detail]')
      .forEach((b) => b.classList.toggle('active', b === button));
    $('#detail-legend').innerHTML =
      state.detail === 'iq'
        ? '<span class="cyan">━ I</span><span class="amber">━ Q</span><span>Normalized amplitude</span>'
        : `<span class="cyan">━ ${state.detail === 'phase' ? 'Phase / radians' : 'Magnitude / full scale'}</span>`;
    drawDetail();
  };
function playback(now) {
  if (!state.playing) return;
  const delta = lastPlayback ? Math.min(now - lastPlayback, 100) : 0;
  lastPlayback = now;
  state.cursor += (delta * (state.view[1] - state.view[0])) / 5000;
  if (state.cursor > state.view[1]) state.cursor = state.view[0];
  updateCursor();
  requestAnimationFrame(playback);
}
$('#play').onclick = () => {
  state.playing = !state.playing;
  $('#play').textContent = state.playing ? 'Ⅱ' : '▶';
  $('#play').setAttribute('aria-label', state.playing ? 'Pause timeline scan' : 'Scan timeline');
  lastPlayback = 0;
  if (state.playing) requestAnimationFrame(playback);
};
document.addEventListener('keydown', (event) => {
  if (event.target.closest('input,select,dialog')) return;
  if (event.key === 'Escape') clearSelection();
  if (event.code === 'Space') {
    event.preventDefault();
    $('#play').click();
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    state.cursor = clamp(
      state.cursor + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 0.05),
    );
    updateCursor();
  }
});
$('#save').onclick = () => {
  if (!state.selection) return;
  const frame = selectedFrame(),
    count = sample(state.selection[1]) - sample(state.selection[0]);
  $('#export-name').value = `wifi-ch60-${frame ? `frame-${frame.id}` : 'selection'}`;
  $('#export-summary').innerHTML =
    `<span>First sample</span><b>${fmt(sample(state.selection[0]))}</b><span>End sample</span><b>${fmt(sample(state.selection[1]))}</b><span>Selection</span><b>${fmt(count)} samples</b><span>Duration</span><b>${(count / 20).toFixed(3)} µs</b><span>Sample rate</span><b>20 MS/s · ci8</b>`;
  $('#export-dialog').showModal();
};
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').style.display = 'block';
  setTimeout(() => {
    $('#toast').style.display = 'none';
  }, 4000);
}
$('#open-capture').onclick = () =>
  toast('Layout preview: open a recorded take here. No file is loaded in this concept.');
$('#collapse').onclick = () => {
  document.body.classList.toggle('collapsed');
  requestRender();
};
function separator(selector, axis) {
  const element = $(selector);
  let start = null;
  element.onpointerdown = (event) => {
    start = {
      x: event.clientX,
      y: event.clientY,
      size: axis === 'x' ? $('.inspector').clientWidth : $('.sample-detail').clientHeight,
    };
    element.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  element.onpointermove = (event) => {
    if (!start) return;
    const size =
      axis === 'x'
        ? clamp(start.size + start.x - event.clientX, 240, 450)
        : clamp(start.size + start.y - event.clientY, 125, 340);
    document.documentElement.style.setProperty(
      axis === 'x' ? '--inspector' : '--detail',
      `${size}px`,
    );
    requestRender();
  };
  element.onpointerup = () => {
    start = null;
  };
  element.onpointercancel = () => {
    start = null;
  };
  element.onkeydown = (event) => {
    const increase = axis === 'x' ? 'ArrowLeft' : 'ArrowUp',
      decrease = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    if (event.key !== increase && event.key !== decrease) return;
    event.preventDefault();
    const current = axis === 'x' ? $('.inspector').clientWidth : $('.sample-detail').clientHeight;
    document.documentElement.style.setProperty(
      axis === 'x' ? '--inspector' : '--detail',
      `${clamp(current + (event.key === increase ? 20 : -20), axis === 'x' ? 240 : 125, axis === 'x' ? 450 : 340)}px`,
    );
    requestRender();
  };
}
separator('#inspector-divider', 'x');
separator('#detail-divider', 'y');
function drawOverview() {
  const { ctx, width, height } = canvasContext($('#overview'));
  ctx.strokeStyle = '#486577';
  for (let x = 0; x < width; x += 2) {
    const amp = 3 + Math.abs(Math.sin(x * 0.23) * Math.cos(x * 0.071)) * height * 0.4;
    ctx.beginPath();
    ctx.moveTo(x, height / 2 - amp);
    ctx.lineTo(x, height / 2 + amp);
    ctx.stroke();
  }
}
$('.timebar .lane-label span').textContent = 'µs +842 ms';
buildTracks();
render();
decodeSelection();
drawOverview();
new ResizeObserver(() => {
  requestRender();
  drawOverview();
}).observe($('.editor'));
// Exposed only for interaction verification of this standalone concept.
window.timelinePreview = { state, frames, render };
