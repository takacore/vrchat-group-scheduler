import { ipcMain } from 'electron';
import { login, logout, verify2FA, getCurrentUser, getUserGroups } from './vrchat.js';
import { addPost, deletePost, getPosts } from './scheduler.js';
import { checkForUpdates, getUpdateSettings, saveUpdateSettings, openDownloadPage } from './updater.js';

export function registerIpcHandlers() {
    // Auth
    ipcMain.handle('auth:login', async (_, { username, password }) => {
        return await login(username, password);
    });

    ipcMain.handle('auth:verify-2fa', async (_, { code }) => {
        return await verify2FA(code);
    });

    ipcMain.handle('auth:get-user', async () => {
        return await getCurrentUser();
    });

    ipcMain.handle('auth:logout', async () => {
        return await logout();
    });

    // Groups (filtered by permission in getUserGroups)
    ipcMain.handle('groups:get-all', async (_, { userId }) => {
        if (!userId) {
            const user = await getCurrentUser();
            if (!user) throw new Error('Not logged in');
            userId = user.id;
        }
        return await getUserGroups(userId);
    });

    // Posts
    ipcMain.handle('posts:get-all', async (_, { includeDeleted, status }) => {
        return await getPosts(includeDeleted, status);
    });

    ipcMain.handle('posts:create', async (_, postData) => {
        return await addPost(postData);
    });

    ipcMain.handle('posts:delete', async (_, { id, force }) => {
        return await deletePost(id, force);
    });

    // Updater
    ipcMain.handle('updater:check', async (_, { channel } = {}) => {
        const settings = await getUpdateSettings();
        const ch = channel || settings.channel || 'stable';
        return await checkForUpdates(ch);
    });

    ipcMain.handle('updater:get-settings', async () => {
        return await getUpdateSettings();
    });

    ipcMain.handle('updater:save-settings', async (_, settings) => {
        return await saveUpdateSettings(settings);
    });

    ipcMain.handle('updater:open-download', async (_, { url }) => {
        openDownloadPage(url);
        return true;
    });
}
