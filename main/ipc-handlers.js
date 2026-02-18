import { ipcMain } from 'electron';
import { login, logout, verify2FA, getCurrentUser, getUserGroups, checkGroupPermission } from './vrchat.js';
import { addPost, deletePost, getPosts } from './scheduler.js';

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


    // Groups
    ipcMain.handle('groups:get-all', async (_, { userId }) => {
        // If userId not provided, maybe fetch current user first?
        // Frontend should provide userId usually, or we store it in memory.
        // For now, let's assume we can get it from getCurrentUser() if needed or passed from front.
        // Optimization: Frontend sends userId.
        if (!userId) {
            const user = await getCurrentUser();
            if (!user) throw new Error('Not logged in');
            userId = user.id;
        }
        return await getUserGroups(userId);
    });

    ipcMain.handle('groups:check-permission', async (_, { groupId }) => {
        return await checkGroupPermission(groupId);
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
}
