// Real acquisition/IPC/UI/inspector/replay using independent synthetic HT IQ.
// The second run selects the second identical MPDU in an LDPC aggregate.
process.env.AIRWOLF_TEST_RECEPTION_PROTOCOLS = 'wifi';
process.env.AIRWOLF_TEST_WIFI_PHY = 'ht';
await import('./reception.mjs?ht-single');
process.env.AIRWOLF_TEST_WIFI_PHY = 'ht-aggregate';
await import('./reception.mjs?ht-aggregate');
