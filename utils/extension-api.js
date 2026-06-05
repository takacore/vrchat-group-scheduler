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
            // [proto] 公開中お知らせ一覧 (GET /groups/{id}/posts) — 重複ガード/Published一覧で共有
            case 'posts:get-published':
                type = 'API_CALL';
                payload = { action: 'getGroupPosts', params: payload };
                break;
            // [proto] グループ在席ダッシュボード用のGETチャンネル（非破壊）
            case 'groups:get-detail':
                type = 'API_CALL';
                payload = { action: 'getGroup', params: payload };
                break;
            case 'groups:get-instances':
                type = 'API_CALL';
                payload = { action: 'getGroupInstances', params: payload };
                break;
            // [proto] 投稿権限のプリフライト確認
            case 'groups:check-permission':
                type = 'API_CALL';
                payload = { action: 'checkPostPermission', params: payload };
                break;
            // [proto] 公開中お知らせの編集 (PUT /groups/{id}/posts/{notificationId}) — 破壊的
            case 'posts:update-live':
                type = 'API_CALL';
                payload = { action: 'updateGroupPost', params: payload };
                break;
            // [proto] 公開中お知らせの削除 (DELETE /groups/{id}/posts/{notificationId}) — ⚠️破壊的
            case 'posts:delete-live':
                type = 'API_CALL';
                payload = { action: 'deleteGroupPost', params: payload };
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
            case 'posts:update': {
                // Overwrite an existing scheduled post and re-arm its alarm
                const { id, ...fields } = payload;
                return chrome.runtime.sendMessage({ type: 'STORAGE_GET', payload: { keys: ['posts'] } }, (response) => {
                    const posts = response?.data?.posts || [];
                    const idx = posts.findIndex(p => p.id === id);
                    if (idx === -1) {
                        return reject(new Error('対象の投稿が見つかりません'));
                    }

                    // Only active posts may be edited — guards against resurrecting a
                    // trashed/sent post (e.g. deleting the post you're editing then hitting 更新).
                    const currentStatus = posts[idx].status;
                    if (currentStatus !== 'pending' && currentStatus !== 'recurring') {
                        return reject(new Error(`この投稿は編集できません（${currentStatus}）`));
                    }

                    const updated = {
                        ...posts[idx],
                        ...fields,
                        id: posts[idx].id,
                        created_at: posts[idx].created_at,
                        updated_at: new Date().toISOString()
                    };
                    // Drop stale error state — this is a fresh attempt
                    delete updated.error;
                    delete updated.xError;
                    delete updated.vrcImageError;

                    // Re-arm the alarm FIRST and only persist once scheduling succeeds, so a
                    // failed re-schedule never leaves an orphaned post with no alarm.
                    chrome.runtime.sendMessage({ type: 'CANCEL_POST', payload: { postId: id } }, () => {
                        chrome.runtime.sendMessage({ type: 'SCHEDULE_POST', payload: { post: updated } }, (schedRes) => {
                            if (!schedRes?.success) {
                                return reject(new Error(schedRes?.error || 'Failed to schedule post'));
                            }
                            posts[idx] = updated;
                            chrome.runtime.sendMessage({ type: 'STORAGE_SET', payload: { items: { posts } } }, () => resolve(updated));
                        });
                    });
                });
            }
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

            case 'x:check-login':
                type = 'API_CALL';
                payload = { action: 'xCheckLogin' };
                break;
            case 'x:post-now':
                type = 'API_CALL';
                payload = { action: 'xPostNow', params: payload };
                break;

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
                    const e = new Error(response.error);
                    if (response.code) e.code = response.code;
                    return reject(e);
                }

                // Adapter layer cleanup: Background now returns { groups, needsScan, etc. }
                // So no transformation is strictly needed!
                resolve(response.data);
            });
        }
    });
};
