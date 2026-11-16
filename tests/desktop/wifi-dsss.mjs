// A faded CCK preamble must survive live acquisition and exact selected IQ replay.
process.env.AIRWOLF_TEST_RECEPTION_PROTOCOLS = 'wifi';
process.env.AIRWOLF_TEST_WIFI_PHY = 'cck';
await import('./reception.mjs');
