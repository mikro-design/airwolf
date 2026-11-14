# IQ timeline concept

Open `index.html` in a browser. This is an interaction prototype with illustrative
signals and frame metadata. It does not connect to a receiver or change decoding.

## Interpretation

Treat a recording like a session in a music editor. The sample clock is the
common horizontal axis. Frames are clips whose widths and positions correspond
to their original IQ intervals. Each clip contains a waveform thumbnail.
The original I and Q tracks and the spectrogram stay aligned with those clips.

Default lanes group frames by observed source, with separate lanes for
unattributed control frames, failed candidates and undecoded RF activity.
The **Lanes** control also demonstrates one row per frame. An ACK has no
transmitter address; the concept deliberately does not invent its sender.
The preview shows one fixed-frequency capture. Recordings of other protocols
are separate takes, not a claim that one HackRF captured disjoint bands at once.

The initial selected frame illustrates the selected state. Production must open
with no selection unless the user explicitly arrived through **View IQ** on a
selected packet. Incoming frames, scrolling and hovering must never select one.

## Interactions demonstrated

- Click a clip: highlight its original IQ interval and show its fields in the
  persistent inspector. Double-click or **Zoom to selection** for a closer view.
- Drag across a signal or lane: select arbitrary IQ, including an undecoded burst.
  Drag IN/OUT handles or edit exact sample numbers to trim the export region.
  This changes a selection; it does not move a received frame or modify samples.
- Shift-click clips: select a range covering them. Frame-edge snapping is optional.
- Zoom buttons or Ctrl/Cmd + wheel change the view. Pan mode or horizontal wheel
  moves through it. Space moves an inspection cursor; this is not RF transmission.
- Choose source lanes or individual frame lanes. Resize the inspector and bottom
  sample-detail panel using their dividers.
- Save opens a concrete export review. Actual export is disabled in this concept
  because no real RF samples are attached. The production native SigMF exporter
  remains the intended save path.

## UX decisions

1. Two working views: Live monitor for reception; IQ timeline for retained data.
   The timeline itself becomes the frame browser while reviewing IQ.
2. One inspector, on the right, updates only on explicit selection. No dissection
   engine selector, second decoding result or automatic latest-frame selection.
3. Original sample indices are the source of truth. The preview's ruler is in
   microseconds relative to the excerpt at 842 ms; IN/OUT are absolute indices
   in the take. OUT is exclusive. No visual stretching of short packets to make
   their labels fit; labels appear when zoom allows.
4. Receiver state stays in the bottom status bar. Recorded settings are read-only
   context; editing the timeline does not retune the radio. One primary Save action.
5. Failed checksums and undecoded RF remain visible and exportable. Activity
   intervals are estimates; packet boundaries may also have timing uncertainty.
   LTE MIB observations must show their acquisition context rather than claiming
   an exact packet waveform boundary.
6. Continuous samples and frame clips should use shared native data and cached
   drawing summaries. Opening the same samples in several lanes must not duplicate
   IQ buffers, run DSP in JavaScript or repeatedly dissect unselected frames.
7. An excerpt whose IQ has expired needs an explicit unavailable state. A frame
   imported without IQ must never get a fabricated waveform.

## Reception work this view supports

The UI is not a fix for poor decoding. It provides the missing comparison surface:
visible RF activity, candidates, checksum results and saved original samples on
one time axis. The next decoding work must be evaluated on the same recordings,
counting valid recoveries, false detections, failed checksums and native CPU cost.
Busy-channel legacy Wi-Fi CRC yield, live WPAN/Zigbee validation and LTE coverage
beyond MIB remain open. The prototype adds no new PHY support.

Checked in Chromium: good/failed/undecoded selection, linked sample bounds,
arbitrary range selection, zoom, both lane groupings, inspector resizing, clear
selection and the export-review dialog. Layouts were inspected at 1680×1050 and
1280×800. These are concept checks, not production app acceptance.

## Selected IQ → decoded result

The bottom pane now pairs the selected waveform with its decode result. Choosing
a clip or finishing an IN/OUT edit updates the illustrated result; **Decode
selection** repeats the check. The result shows recovered-frame count, bytes,
CRC outcome and whether the bytes match the recorded reference. A range can
contain several recovered frames, each selectable without changing the IQ range.

A coverage strip marks preamble, L-SIG and OFDM DATA intervals. It distinguishes
frame coverage from successful decoding. Cutting the known frame's beginning or
end shows what is missing; **Include complete frame** restores the bounds.
Undecoded RF and failed-CRC candidates do not receive a successful result.

**Prototype limitation:** these result states are simulated from the illustrative
frame intervals. No actual waveform decoding happens here. The MAC byte fixtures
have independently calculated FCS; the waveform drawing is still illustrative.
Production must rerun the exact selected original samples through the native PHY,
with any required acquisition context explicitly disclosed, before showing a
recovered frame or a byte-match claim. Merely intersecting a packet annotation
cannot establish that the selection decodes. Cancel stale work when the selection
changes and decode after the user finishes dragging, not on every pointer event.

The inspector labels the captured frame as a reference. It must not be mistaken
for the new selection's decode result. For coded/interleaved PHYs, byte-to-IQ
mapping must describe the actual contributing symbol intervals; do not draw
invented contiguous MAC-header/payload/FCS regions on a Wi-Fi waveform.

## Implemented editor

`implemented.png` shows the production Electron view replaying generated BLE
Coded IQ through the native receiver. Its waveforms and recovered bytes are real
fixture results; it is not a live-radio screenshot. The original HTML remains
an illustrative design reference. Production documentation is in the user guide.
