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
  info: (request) => ipcRenderer.invoke('radio:info', request),
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
  onSweep: (fn) =>
    subscribe('radio:sweep', (packet) => {
      try {
        fn(packet.data);
      } finally {
        ipcRenderer.send('radio:sweep:ack', packet.sequence);
      }
    }),
  onStatus: (fn) => subscribe('radio:status', fn),
});

contextBridge.exposeInMainWorld('iq', {
  list: () => ipcRenderer.invoke('iq:list'),
  take: (id) => ipcRenderer.invoke('iq:take', id),
  frame: (reference) => ipcRenderer.invoke('iq:frame', reference),
  start: (config, seconds) => ipcRenderer.invoke('iq:start', config, seconds),
  stop: () => ipcRenderer.invoke('iq:stop'),
  overview: (id, first, end, columns, slot) =>
    ipcRenderer.invoke('iq:overview', id, first, end, columns, slot),
  decode: (id, first, end, settings, selectedPacket) =>
    ipcRenderer.invoke('iq:decode', id, first, end, settings, selectedPacket),
  cancelDecode: () => ipcRenderer.invoke('iq:cancel-decode'),
  cancelAnalysis: () => ipcRenderer.invoke('iq:cancel-analysis'),
  save: (id, first, end, description) => ipcRenderer.invoke('iq:save', id, first, end, description),
  open: () => ipcRenderer.invoke('iq:open'),
  remove: (id) => ipcRenderer.invoke('iq:remove', id),
  onState: (fn) => subscribe('iq:state', fn),
});

contextBridge.exposeInMainWorld('livePcap', {
  start: () => ipcRenderer.invoke('pcap-live:start'),
  append: (batches) => ipcRenderer.invoke('pcap-live:append', batches),
  stop: () => ipcRenderer.invoke('pcap-live:stop'),
  state: () => ipcRenderer.invoke('pcap-live:state'),
  onState: (fn) => subscribe('pcap-live:state', fn),
});
contextBridge.exposeInMainWorld('zigbeeKeys', {
  list: () => ipcRenderer.invoke('zigbee-keys:list'),
  add: (entry) => ipcRenderer.invoke('zigbee-keys:add', entry),
  remove: (id) => ipcRenderer.invoke('zigbee-keys:remove', id),
  setLevel: (level) => ipcRenderer.invoke('zigbee-keys:level', level),
});
contextBridge.exposeInMainWorld('lorawanKeys', {
  list: () => ipcRenderer.invoke('lorawan-keys:list'),
  add: (entry) => ipcRenderer.invoke('lorawan-keys:add', entry),
  remove: (id) => ipcRenderer.invoke('lorawan-keys:remove', id),
});
