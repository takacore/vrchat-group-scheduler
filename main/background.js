import path from 'path'
import { app, ipcMain } from 'electron'
import serve from 'electron-serve'
import log from 'electron-log/main'
import { createWindow } from './helpers'
import { initScheduler } from './scheduler'
import { registerIpcHandlers } from './ipc-handlers'
import { initAutoUpdater, autoCheckForUpdates, getUpdateSettings, checkForUpdates } from './updater.js'

const isProd = process.env.NODE_ENV === 'production'

// Initialize electron-log
log.initialize()
Object.assign(console, log.functions)
log.info('Starting VRChat Group Scheduler...')

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

    // Initialize electron-updater (Windows auto-update)
    initAutoUpdater(mainWindow)

    // Auto-update check on startup (delayed to avoid blocking)
    setTimeout(async () => {
      try {
        const settings = await getUpdateSettings()
        if (settings.autoCheck) {
          if (process.platform === 'win32') {
            // Windows: use electron-updater for seamless auto-update
            await autoCheckForUpdates(settings.channel)
          } else {
            // macOS/Linux: use GitHub API check (no code signing = no auto-update)
            const result = await checkForUpdates(settings.channel)
            if (result.updateAvailable) {
              mainWindow.webContents.send('updater:update-available', result)
            }
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
