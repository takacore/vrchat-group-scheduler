// utils/extension-api.js

export const invokeBackend = async (action, payload = {}) => {
    return new Promise((resolve, reject) => {
        if (typeof chrome === 'undefined' || !chrome.runtime) {
            // Handle the case where the app is loaded outside of an extension context
            return reject(new Error('Extension context not found.'));
        }

        // Wrap the old IPC semantics to the new message format
        let type = 'API_CALL';
        switch (action) {
            case 'auth:get-user':
                type = 'API_CALL';
                payload = { action: 'getAuth' };
                break;
            case 'groups:get-all':
                type = 'API_CALL';
                payload = { action: 'getGroups', params: payload };
                break;
            case 'groups:refresh':
                type = 'API_CALL';
                payload = { action: 'refreshGroups', params: payload };
                break;
            case 'posts:get-all':
                return chrome.runtime.sendMessage({ type: 'STORAGE_GET', payload: { keys: ['posts'] } }, (response) => {
                    if (response?.success) {
                        resolve(response.data.posts || []);
                    } else {
                        reject(new Error(response?.error || 'Failed to get posts'));
                    }
                });
            case 'posts:create':
                // Need to save post to storage and schedule alarm
                const post = {
                    id: crypto.randomUUID(),
                    ...payload,
                    created_at: new Date().toISOString()
                };
                return chrome.runtime.sendMessage({ type: 'STORAGE_GET', payload: { keys: ['posts'] } }, async (response) => {
                    const posts = response?.data?.posts || [];
                    posts.push(post);

                    await new Promise((res) => {
                        chrome.runtime.sendMessage({ type: 'STORAGE_SET', payload: { items: { posts } } }, () => res());
                    });

                    // Schedule it via background
                    chrome.runtime.sendMessage({ type: 'SCHEDULE_POST', payload: { post } }, (schedRes) => {
                        if (schedRes?.success) resolve(post);
                        else reject(new Error(schedRes?.error || 'Failed to schedule post'));
                    });
                });
            case 'posts:delete':
                return chrome.runtime.sendMessage({ type: 'STORAGE_GET', payload: { keys: ['posts'] } }, (response) => {
                    const posts = response?.data?.posts || [];
                    const { id, force } = payload;

                    let updatedPosts = [];
                    if (force) {
                        updatedPosts = posts.filter(p => p.id !== id);
                    } else {
                        updatedPosts = posts.map(p => p.id === id ? { ...p, status: 'deleted' } : p);
                    }

                    chrome.runtime.sendMessage({ type: 'STORAGE_SET', payload: { items: { posts: updatedPosts } } }, () => {
                        // Cancel alarm if we delete or trash it
                        chrome.runtime.sendMessage({ type: 'CANCEL_POST', payload: { postId: id } }, () => resolve());
                    });
                });
            case 'app:get-version':
                return resolve(chrome.runtime.getManifest().version);

            // Ignore updater actions
            case 'updater:get-settings':
            case 'updater:save-settings':
                return resolve({});
            case 'updater:check':
                return resolve({ updateAvailable: false });

            default:
                console.warn('Unknown invoke channel', action);
                return reject(new Error('Unknown channel'));
        }

        if (type === 'API_CALL') {
            chrome.runtime.sendMessage({ type, payload }, (response) => {
                if (chrome.runtime.lastError) {
                    return reject(chrome.runtime.lastError);
                }
                if (!response) {
                    return reject(new Error('No response from background'));
                }
                if (!response.success) {
                    return reject(new Error(response.error));
                }

                // Adapter layer cleanup: Background now returns { groups, needsScan, etc. }
                // So no transformation is strictly needed!
                resolve(response.data);
            });
        }
    });
};
