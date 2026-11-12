const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dissector', {
  info: () => ipcRenderer.invoke('dissector:info'),
  decode: (request) => ipcRenderer.invoke('dissector:decode', request),
  stop: () => ipcRenderer.invoke('dissector:stop'),
});
function subscribe(channel, fn) {
  const listener = (_event, data) => fn(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld('radio', {
  info: () => ipcRenderer.invoke('radio:info'),
  start: (config) => ipcRenderer.invoke('radio:start', config),
  stop: () => ipcRenderer.invoke('radio:stop'),
  onSpectrum: (fn) =>
    subscribe('radio:spectrum', (packet) => {
      try {
        fn(packet.data);
      } finally {
        ipcRenderer.send('radio:spectrum:ack', packet.sequence);
      }
    }),
  onPackets: (fn) =>
    subscribe('radio:packets', (batch) => {
      try {
        fn({ packets: batch.packets, dropped: batch.dropped });
      } finally {
        ipcRenderer.send('radio:packets:ack', batch.sequence);
      }
    }),
  onStatus: (fn) => subscribe('radio:status', fn),
});
