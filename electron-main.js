const { app, BrowserWindow, shell } = require('electron');

const PORT = 3847;

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    title: 'Sid',
    backgroundColor: '#0b0c0e',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.removeMenu();
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(`http://127.0.0.1:${PORT}`);
}

app.whenReady().then(() => {
  process.env.SID_DATA_DIR = app.getPath('userData');
  process.env.SID_PORT = String(PORT);
  require('./server');
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
