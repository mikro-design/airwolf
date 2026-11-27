const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  safeStorage,
} = require('electron');
const path = require('node:path');
const { createRadio, validate } = require('./radio.cjs');
const { createIqCapture } = require('./iq-capture.cjs');
let iq;
let zigbeeKeys, lorawanKeys;
const { createZigbeeKeyStore } = require('./zigbee-key-store.cjs');
const { createLoRaWanKeyStore } = require('./lorawan-key-store.cjs');
const { latestEvent } = require('./latest-event.cjs');
const { packetRelay } = require('./packet-relay.cjs');
const { createDissector } = require('./dissector.cjs');
const { crashRecovery } = require('./crash-recovery.cjs');
const { confineFileProtocol } = require('./file-scope.cjs');
const { createLivePcap } = require('./live-pcap.cjs');
const dissector = createDissector();
let win;
let rendererReady = false;
let closingApp = false;
const send = (channel, data) => {
  if (rendererReady && win && !win.isDestroyed() && !win.webContents.isDestroyed())
    win.webContents.send(channel, data);
};
const livePcap = createLivePcap({
  chooseSave: async (name) => {
    const result = await dialog.showSaveDialog(win, {
      title: 'Capture live packets to PCAP',
      defaultPath: name,
      filters: [
        { name: 'PCAPNG (all link types in one file)', extensions: ['pcapng'] },
        { name: 'PCAP (one file per link type)', extensions: ['pcap'] },
      ],
    });
    return result.canceled ? null : result.filePath;
  },
  emit: (state) => send('pcap-live:state', state),
});
const spectrumRelay = latestEvent((packet) => {
  if (!rendererReady || !win || win.isDestroyed()) return false;
  win.webContents.send('radio:spectrum', packet);
}, receiverStalled);
// Sweep frames are independent 500 ms accumulations; the renderer folds them
// into its own max-hold, so only the latest unsent frame is kept.
const sweepRelay = latestEvent((frame) => {
  if (!rendererReady || !win || win.isDestroyed()) return false;
  win.webContents.send('radio:sweep', frame);
}, receiverStalled);
const packets = packetRelay(
  (batch) => {
    if (!rendererReady || !win || win.isDestroyed()) return false;
    win.webContents.send('radio:packets', batch);
  },
  2000,
  512,
  receiverStalled,
  5000,
  50,
);
const radio = createRadio(
  (data) => {
    if (rendererReady) spectrumRelay.offer(data);
  },
  (data) => {
    iq?.onStatus(data);
    send('radio:status', data);
  },
  undefined,
  (packet) => {
    iq?.onPacket(packet);
    if (rendererReady) packets.offer(packet);
  },
  (event) => iq?.onRecording(event),
  (frame) => {
    if (rendererReady) sweepRelay.offer(frame);
  },
);
function resetRelays() {
  spectrumRelay.reset();
  sweepRelay.reset();
  packets.reset();
}
async function stopCapture() {
  iq?.close();
  resetRelays();
  dissector.close();
  await (iq ? iq.stop() : radio.stop());
  resetRelays();
}
function receiverStalled() {
  void stopCapture().then(() =>
    send('radio:status', {
      state: 'error',
      message:
        'Capture stopped: the display did not acknowledge live data. Start the receiver again to resume.',
    }),
  );
}
app.whenReady().then(() => {
  zigbeeKeys = createZigbeeKeyStore({
    file: path.join(app.getPath('userData'), 'zigbee-keys.bin'),
    safeStorage,
  });
  lorawanKeys = createLoRaWanKeyStore({
    file: path.join(app.getPath('userData'), 'lorawan-keys.bin'),
    safeStorage,
  });
  iq = createIqCapture({
    directory: path.join(app.getPath('userData'), 'iq-captures'),
    radio,
    emit: (state) => send('iq:state', state),
    chooseOpen: async () => {
      const result = await dialog.showOpenDialog(win, {
        title: 'Open IQ recording',
        properties: ['openFile'],
        filters: [{ name: 'SigMF metadata', extensions: ['sigmf-meta'] }],
      });
      return result.canceled ? null : result.filePaths[0];
    },
    chooseSave: async (name) => {
      const result = await dialog.showSaveDialog(win, {
        title: 'Save IQ selection',
        defaultPath: name,
        filters: [{ name: 'SigMF metadata', extensions: ['sigmf-meta'] }],
      });
      return result.canceled ? null : result.filePath;
    },
  });
  confineFileProtocol(protocol, net, path.join(__dirname, '../dist'));
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  ipcMain.on('radio:packets:ack', (event, sequence) => {
    if (win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame)
      packets.acknowledge(sequence);
  });
  ipcMain.on('radio:sweep:ack', (event, sequence) => {
    if (win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame)
      sweepRelay.acknowledge(sequence);
  });
  ipcMain.on('radio:spectrum:ack', (event, sequence) => {
    if (win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame)
      spectrumRelay.acknowledge(sequence);
  });
  for (const [channel, fn] of [
    ['pcap-live:start', () => livePcap.start()],
    ['pcap-live:append', (batches) => livePcap.append(batches)],
    ['pcap-live:stop', () => livePcap.stop()],
    ['pcap-live:state', () => livePcap.state()],
    ['radio:info', (request) => radio.info(request)],
    [
      'radio:start',
      async (config) => {
        if (!rendererReady)
          throw new Error('The display is loading; wait before starting capture.');
        if (iq.isRecording()) throw new Error('Stop the IQ take before changing the receiver');
        validate(config);
        await radio.stop();
        resetRelays();
        if (!rendererReady)
          throw new Error('The display is loading; wait before starting capture.');
        // An IQ take may have been requested while the previous receiver stopped.
        if (iq.isRecording()) throw new Error('Stop the IQ take before changing the receiver');
        return radio.start(config);
      },
    ],
    [
      'radio:stop',
      async () => {
        await (iq.isRecording() ? iq.stop() : radio.pause());
        // A frame still in flight when the renderer stopped listening is never
        // acknowledged; with the receiver stopped, nothing is owed.
        resetRelays();
      },
    ],
    ['iq:list', () => iq.list()],
    ['iq:take', (id) => iq.take(id)],
    ['iq:frame', (reference) => iq.frame(reference)],
    [
      'iq:start',
      (config, seconds) => {
        if (!rendererReady) throw new Error('The display is loading');
        return iq.start(config, seconds);
      },
    ],
    ['iq:stop', () => iq.stop()],
    ['iq:overview', (...args) => iq.overview(...args)],
    ['iq:decode', (...args) => iq.decode(...args)],
    ['iq:cancel-decode', () => iq.cancelDecode()],
    ['iq:cancel-analysis', () => iq.cancelAnalysis()],
    ['iq:save', (...args) => iq.save(...args)],
    ['iq:open', () => iq.open()],
    ['iq:remove', (id) => iq.remove(id)],
    ['dissector:info', () => dissector.info()],
    [
      'dissector:decode',
      (request) =>
        dissector.dissect(request, { ...zigbeeKeys.secrets(), lorawan: lorawanKeys.secrets() }),
    ],
    ['zigbee-keys:list', () => zigbeeKeys.list()],
    [
      'zigbee-keys:add',
      (entry) => {
        dissector.stop();
        return zigbeeKeys.add(entry);
      },
    ],
    [
      'zigbee-keys:remove',
      (id) => {
        dissector.stop();
        return zigbeeKeys.remove(id);
      },
    ],
    [
      'zigbee-keys:level',
      (level) => {
        dissector.stop();
        return zigbeeKeys.setLevel(level);
      },
    ],
    ['lorawan-keys:list', () => lorawanKeys.list()],
    [
      'lorawan-keys:add',
      (entry) => {
        dissector.stop();
        return lorawanKeys.add(entry);
      },
    ],
    [
      'lorawan-keys:remove',
      (id) => {
        dissector.stop();
        return lorawanKeys.remove(id);
      },
    ],
    ['dissector:stop', () => dissector.stop()],
  ]) {
    ipcMain.handle(channel, (event, ...args) => {
      if (
        !win ||
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame
      )
        throw new Error('Untrusted sender');
      return fn(...args);
    });
  }
  function createWindow() {
    win = new BrowserWindow({
      show: process.env.AIRWOLF_TEST_HEADLESS !== '1',
      width: 1560,
      height: 1040,
      minWidth: 1000,
      minHeight: 700,
      backgroundColor: '#101317',
      title: 'Airwolf',
      icon: path.join(__dirname, '../dist/airwolf-mark.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const window = win;
    const recovery = crashRecovery();
    let closingWindow = false;
    window.on('close', () => {
      closingWindow = true;
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    // A cancelled navigation leaves the existing document and its subscriptions
    // intact. Only a committed main-frame navigation replaces the renderer page.
    window.webContents.on('did-navigate', () => {
      rendererReady = false;
      void stopCapture();
    });
    window.webContents.on('did-finish-load', () => {
      rendererReady = true;
    });
    window.webContents.on('render-process-gone', () => {
      rendererReady = false;
      // Release USB ownership before rebuilding the display. Recovery leaves
      // capture stopped; a fresh renderer can start the receiver normally.
      void stopCapture().then(async () => {
        if (closingApp || closingWindow || win !== window || window.isDestroyed()) return;
        if (!recovery.allow()) {
          const { response } = await dialog.showMessageBox(window, {
            type: 'error',
            title: 'Airwolf could not recover the display',
            message: 'The display has crashed repeatedly. The receiver is stopped.',
            detail:
              'Automatic recovery has stopped. Close Airwolf or try loading the display again.',
            buttons: ['Close Airwolf', 'Try again'],
            defaultId: 0,
            cancelId: 0,
          });
          if (response === 0) {
            app.quit();
            return;
          }
          recovery.reset();
        }
        if (!closingApp && !closingWindow && win === window && !window.isDestroyed())
          await window.loadFile(path.join(__dirname, '../dist/index.html'));
      });
    });
    window.on('closed', () => {
      rendererReady = false;
      void stopCapture();
      win = null;
    });
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
let quitting = false;
app.on('will-quit', () => {
  zigbeeKeys?.clearSession();
  lorawanKeys?.clearSession();
});
app.on('before-quit', (event) => {
  closingApp = true;
  if (quitting) return;
  event.preventDefault();
  livePcap.stop();
  dissector.close();
  iq?.close();
  Promise.allSettled([iq?.abortExports(), iq ? iq.stop() : radio.stop()]).finally(() => {
    quitting = true;
    app.quit();
  });
});
