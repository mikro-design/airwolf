const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
const { createRadio } = require('./radio.cjs');
const { latestEvent } = require('./latest-event.cjs');
const { packetRelay } = require('./packet-relay.cjs');
const { createDissector } = require('./dissector.cjs');
const dissector = createDissector();
let win;
let rendererReady = false;
const send = (channel, data) => {
  if (rendererReady && win && !win.isDestroyed() && !win.webContents.isDestroyed())
    win.webContents.send(channel, data);
};
const spectrumRelay = latestEvent((packet) => {
  if (!rendererReady || !win || win.isDestroyed()) return false;
  win.webContents.send('radio:spectrum', packet);
}, receiverStalled);
const packets = packetRelay(
  (batch) => {
    if (!rendererReady || !win || win.isDestroyed()) return false;
    win.webContents.send('radio:packets', batch);
  },
  2000,
  64,
  receiverStalled,
);
const radio = createRadio(
  (data) => {
    if (rendererReady) spectrumRelay.offer(data);
  },
  (data) => send('radio:status', data),
  undefined,
  (packet) => {
    if (rendererReady) packets.offer(packet);
  },
);
function resetRelays() {
  spectrumRelay.reset();
  packets.reset();
}
async function stopCapture() {
  resetRelays();
  dissector.stop();
  await radio.stop();
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
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  ipcMain.on('radio:packets:ack', (event, sequence) => {
    if (win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame)
      packets.acknowledge(sequence);
  });
  ipcMain.on('radio:spectrum:ack', (event, sequence) => {
    if (win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame)
      spectrumRelay.acknowledge(sequence);
  });
  for (const [channel, fn] of [
    ['radio:info', () => radio.info()],
    [
      'radio:start',
      (config) => {
        if (!rendererReady)
          throw new Error('The display is loading; wait before starting capture.');
        return radio.start(config);
      },
    ],
    ['radio:stop', () => radio.stop()],
    ['dissector:info', () => dissector.info()],
    ['dissector:decode', (request) => dissector.dissect(request)],
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
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      rendererReady = false;
      void stopCapture();
    });
    win.webContents.on('did-finish-load', () => {
      rendererReady = true;
    });
    win.webContents.on('render-process-gone', () => {
      rendererReady = false;
      void stopCapture();
    });
    win.on('closed', () => {
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
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  dissector.stop();
  radio.stop().finally(() => {
    quitting = true;
    app.quit();
  });
});
