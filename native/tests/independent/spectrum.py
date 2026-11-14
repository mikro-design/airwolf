"""Independent FFT/PSD/Parseval oracle, plus burst position and chunk invariance.

Uses NumPy FFT and SciPy periodogram, not the production FFT or generator.
No hardware calibration is implied by agreement in normalized digital units.
"""
import pathlib
import subprocess
import sys
import tempfile
import numpy as np
from scipy.signal import periodogram

binary = sys.argv[1]
n, hop = 2048, 1024
window = np.hanning(n)
enbw_bins = n * np.sum(window**2) / np.sum(window)**2
rng = np.random.default_rng(441)
worst = 0

with tempfile.TemporaryDirectory() as directory:
    path = pathlib.Path(directory) / 'signal.iq'

    def run(x, chunk=1018):
        iq = np.column_stack((np.round(x.real), np.round(x.imag))).clip(-128, 127).astype(np.int8)
        path.write_bytes(iq.tobytes())
        lines = subprocess.check_output([binary, str(path), str(chunk)], text=True).splitlines()
        bounds = list(map(int, lines[0].split()))
        quantized = (iq[:, 0].astype(float) + 1j * iq[:, 1]) / 128
        actual = np.loadtxt(lines[1:])
        return quantized, bounds, actual

    t = np.arange(n * 19 + 337)
    signals = [
        np.zeros(len(t), complex),
        20 + 13j + 45 * np.exp(2j*np.pi*127.35*t/n) + 19*np.exp(-2j*np.pi*501.7*t/n),
        60*np.exp(2j*np.pi*1023*t/n),
        60*np.exp(-2j*np.pi*1024*t/n),
        rng.integers(-31, 32, len(t)) + 1j*rng.integers(-31, 32, len(t)),
    ]
    for x in signals:
        quantized, bounds, actual = run(x)
        frames = np.lib.stride_tricks.sliding_window_view(quantized, n)[::hop]
        power = np.abs(np.fft.fftshift(np.fft.fft(frames*window, axis=1), axes=1))**2 / window.sum()**2
        expected = np.column_stack((power.max(axis=0), power.mean(axis=0)))
        expected_db = np.maximum(-120, 10*np.log10(expected+1e-12))
        worst = max(worst, float(np.max(np.abs(actual-expected_db))))
        # Single-precision FFT cancellation near -110 dBFS needs an absolute
        # power tolerance; meaningful bins must still agree to 0.025 dB.
        error = np.abs(actual-expected_db)
        assert np.max(error) < .08, (np.unravel_index(np.argmax(error), error.shape), np.max(error))
        assert np.all(error[expected_db > -100] < .025)
        assert bounds == [0, (len(frames)-1)*hop+n, len(frames), hop]
        assert np.array_equal(actual, run(x, 262144)[2]), 'USB chunk boundaries change spectrum'
        # Parseval in normalized complex power, correcting coherent gain ENBW.
        integrated = expected[:, 1].sum()/enbw_bins
        weighted_time_power = np.mean(np.sum(np.abs(frames*window)**2, axis=1)/np.sum(window**2))
        assert np.isclose(integrated, weighted_time_power, rtol=1e-12, atol=1e-15)
        for rate in [8000000, 10000000, 16000000, 20000000]:
            _, psd = periodogram(frames, rate, window=window, detrend=False,
                                 return_onesided=False, scaling='density', axis=1)
            native_density = np.maximum(0, 10**(actual[:, 1]/10)-1e-12)/(enbw_bins*rate/n)
            reference = np.fft.fftshift(psd.mean(axis=0))
            assert np.max(np.abs(native_density-reference)) < max(1e-15, reference.max()*1e-5)

    # A 64-sample tone moved through every window phase in 16-sample steps.
    # Nonoverlapping Hann windows varied by >50 dB on this fixture.
    peaks = []
    for offset in range(0, n, 16):
        x = np.zeros(n*4, complex)
        at = n+offset
        x[at:at+64] = 64*np.exp(2j*np.pi*128*np.arange(64)/n)
        _, _, actual = run(x)
        peaks.append(actual[1152, 0])
    variation = max(peaks)-min(peaks)
    assert variation < 6.1, variation
    print(f'All FFT bins, PSD and Parseval at 4 rates: max error {worst:.5f} dB; '
          f'64-sample burst phase variation {variation:.3f} dB. Chunk invariance passed.')
