import { BrowserWindow } from 'electron';
import { join } from 'path';
import { is } from '@electron-toolkit/utils';
import { CONFIG } from '../shared/config';

let authWindow: BrowserWindow | null = null;

export function getAuthWindow(): BrowserWindow | null {
  return authWindow;
}

export function showAuthWindow(): void {
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.show();
    authWindow.focus();
    return;
  }

  authWindow = new BrowserWindow({
    width: 420,
    height: 480,
    title: `Sign in to ${CONFIG.APP_NAME}`,
    frame: true,
    resizable: false,
    minimizable: true,
    maximizable: false,
    show: false,
    backgroundColor: '#0B0F19',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    authWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=auth`);
  } else {
    authWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'auth' }
    });
  }

  authWindow.on('ready-to-show', () => {
    authWindow?.show();
    authWindow?.focus();
  });

  authWindow.on('closed', () => {
    authWindow = null;
  });
}

export function closeAuthWindow(): void {
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.close();
  }
  authWindow = null;
}
