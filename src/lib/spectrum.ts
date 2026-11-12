// FFT-shifted bin k is at LO - Fs/2 + k*Fs/N. Preserve the strongest
// bin in each pixel bucket: selecting one bin would erase narrow signals.
export function spectrumPixels(
  values: readonly number[],
  start: number,
  width: number,
  columns: number,
) {
  const output = new Float32Array(columns);
  for (let col = 0; col < columns; col++) {
    const left = (start + (width * col) / columns) * values.length;
    const right = (start + (width * (col + 1)) / columns) * values.length;
    const first = Math.max(0, Math.min(values.length - 1, Math.ceil(left - 1e-9)));
    const end = Math.max(first + 1, Math.min(values.length, Math.ceil(right - 1e-9)));
    let peak = -120;
    for (let bin = first; bin < end; bin++) peak = Math.max(peak, values[bin]);
    output[col] = peak;
  }
  return output;
}
