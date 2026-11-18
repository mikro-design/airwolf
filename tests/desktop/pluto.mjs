// Production IIO event/packet path, original 12-bit IQ, native dissection and export.
// Test-only sample source; never opens a physical receiver.
process.env.AIRWOLF_TEST_RECEIVER = 'pluto';
await import('./reception.mjs');
