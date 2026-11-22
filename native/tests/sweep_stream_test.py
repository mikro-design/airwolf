"""Native wideband sweep through the production receiver and a fake HackRF.

The fake firmware delivers INTERLEAVED sweep blocks with emitters at known
frequencies; every emitter must appear where it was placed, nothing else may
stand out, and passes must keep coming."""
import base64, json, os, statistics, subprocess, sys

binary = sys.argv[1]
emitters = [(2437.0, 16.0, -40.0), (2426.0, 2.0, -45.0), (5180.0, 16.0, -42.0)]
env = dict(os.environ, AIRWOLF_FAKE_SWEEP=",".join(f"{c}:{w}:{db}" for c, w, db in emitters))
run = subprocess.run([binary, "--sweep", "2400:2500,5150:5250", "--lna", "32", "--vga", "24", "--duration-ms", "2500"],
                     env=env, capture_output=True, text=True, timeout=60)
assert run.returncode == 0, run.stderr
frames = [json.loads(line) for line in run.stdout.splitlines()]
assert len(frames) >= 3, f"expected a frame every 500 ms, got {len(frames)}"
assert all(f["type"] == "sweep" and f["rejectedBlocks"] == 0 for f in frames)
passes = [f["passes"] for f in frames]
assert passes == sorted(passes) and passes[-1] > passes[0], passes
assert (frames[-1]["lnaGain"], frames[-1]["vgaGain"]) == (32, 24)

last = frames[-1]
assert [(r["startHz"], r["stopHz"]) for r in last["ranges"]] == [(2400e6 - 4882.8, 2500e6), (5150e6 - 4882.8, 5250e6)], last["ranges"]
found = []
for r in last["ranges"]:
    peak = [q / 2 - 127.5 if q else None for q in base64.b64decode(r["peak"])][: r["bins"]]
    assert None not in peak, "a whole pass must measure every bin"
    floor = statistics.median(peak)
    hot = [i for i, v in enumerate(peak) if v > floor + 12]
    runs = []
    for i in hot:
        if runs and i - runs[-1][1] <= 6:
            runs[-1][1] = i
        else:
            runs.append([i, i])
    for a, z in runs:
        low = (r["startHz"] + a * last["binHz"]) / 1e6
        high = (r["startHz"] + (z + 1) * last["binHz"]) / 1e6
        found.append((low, high))
for center, width, _ in emitters:
    match = [f for f in found if abs((f[0] + f[1]) / 2 - center) < 0.2 and abs((f[1] - f[0]) - width) < 0.4]
    assert match, f"emitter at {center} MHz ({width} MHz) not found in {found}"
assert len(found) == len(emitters), f"unexpected emissions: {found}"
print(f"sweep: {passes[-1]} passes, emitters found at {[round((a + b) / 2, 2) for a, b in found]} MHz")
