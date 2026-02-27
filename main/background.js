import path from 'path'
import { app, ipcMain } from 'electron'
import serve from 'electron-serve'
import { createWindow } from './helpers'
import { initScheduler } from './scheduler'
import { registerIpcHandlers } from './ipc-handlers'
import { checkForUpdates, getUpdateSettings } from './updater.js'

const isProd = process.env.NODE_ENV === 'production'

if (isProd) {
  serve({ directory: 'app' })
} else {
  app.setPath('userData', `${app.getPath('userData')} (development)`)
}

// Initialize Backend
registerIpcHandlers()
initScheduler().catch(console.error)

  ; (async () => {
    await app.whenReady()

    const mainWindow = createWindow('main', {
      width: 1200,
      height: 800,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
      },
    })

    if (isProd) {
      await mainWindow.loadURL('app://./home')
    } else {
      const port = process.argv[2]
      await mainWindow.loadURL(`http://localhost:${port}/home`)
      mainWindow.webContents.openDevTools()
    }

    // Auto-update check on startup (delayed to avoid blocking)
    setTimeout(async () => {
      try {
        const settings = await getUpdateSettings()
        if (settings.autoCheck) {
          const result = await checkForUpdates(settings.channel)
          if (result.updateAvailable) {
            mainWindow.webContents.send('updater:update-available', result)
          }
        }
      } catch (err) {
        console.error('Auto-update check failed:', err)
      }
    }, 5000)
  })()

app.on('window-all-closed', () => {
  app.quit()
})
