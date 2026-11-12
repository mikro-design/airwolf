const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
const { createRadio } = require('./radio.cjs');
const { latestEvent } = require('./latest-event.cjs');
const { packetRelay } = require('./packet-relay.cjs');
const { createDissector } = require('./dissector.cjs');
const dissector = createDissector();
let win;
const send = (channel, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
};
const spectrumRelay = latestEvent((packet) => {
  if (!win || win.isDestroyed()) return false;
  win.webContents.send('radio:spectrum', packet);
});
const packets = packetRelay((batch) => {
  if (!win || win.isDestroyed()) return false;
  win.webContents.send('radio:packets', batch);
});
const radio = createRadio(
  (data) => spectrumRelay.offer(data),
  (data) => send('radio:status', data),
  undefined,
  (packet) => packets.offer(packet),
);
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
    ['radio:start', (config) => radio.start(config)],
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
    win.on('closed', () => {
      dissector.stop();
      radio.stop();
      spectrumRelay.reset();
      packets.reset();
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
