// background/background.js
import { api } from './api.js';
import { storage } from './storage.js';
import { scheduler } from './scheduler.js';
import { xApi, clearXHeaderRule } from './x-api.js';

async function dataUrlToBlob(dataUrl) {
    const res = await fetch(dataUrl);
    return res.blob();
}

chrome.runtime.onInstalled.addListener(() => {
    console.log('VRChat Group Scheduler Extension Installed');

    // 前回セッションで残った可能性のあるX用ヘッダルールを掃除
    clearXHeaderRule();

    // Initialize storage if empty
    storage.get(['posts']).then(result => {
        if (!result.posts) {
            storage.set({ posts: [] });
        }
    });
});

// 起動時にも残留 session rule を必ず除去（古いCookieスナップショットでX宛XHRを
// 上書きし続けるのを防ぐ。MV3 session rule は SW ライフサイクルと独立に残るため）
chrome.runtime.onStartup.addListener(() => {
    clearXHeaderRule();
});

// Alarm Listener
chrome.alarms.onAlarm.addListener(async (alarm) => {
    const postId = alarm.name;
    console.log(`Alarm fired for post: ${postId}`);

    const { posts } = await storage.get(['posts']);
    if (!posts) return;

    const postIndex = posts.findIndex(p => p.id === postId);
    if (postIndex === -1) {
        console.warn(`Post ${postId} not found in storage.`);
        return;
    }

    const post = posts[postIndex];

    try {
        let imageId = null;
        let vrcImageError = null;
        if (post.imageDataUrl) {
            try {
                const blob = await dataUrlToBlob(post.imageDataUrl);
                const filename = post.imageName || 'image.png';
                imageId = await api.uploadImage(blob, filename, 'gallery');
            } catch (uploadErr) {
                vrcImageError = uploadErr.message;
                console.warn('VRChat image upload failed, posting without image:', uploadErr);
            }
        }

        const result = await api.createGroupPost(post.groupId, post.title, post.text, post.sendNotification, imageId);
        console.log('Post successful:', result);

        let xResultOk = true;
        let xError = null;
        if (post.postToX) {
            console.log('[Scheduler] post.postToX=true, attempting X post...');
            try {
                const xText = post.xText || `${post.title}\n\n${post.text}`;
                await xApi.post(xText, post.imageDataUrl || null);
                console.log('[Scheduler] X post completed');
            } catch (xErr) {
                xResultOk = false;
                xError = xErr.message;
                console.error('[Scheduler] X(Twitter) post failed:', xErr);
            }
        } else {
            console.log('[Scheduler] post.postToX falsy, skipping X');
        }

        const fullySuccess = xResultOk && !vrcImageError;
        posts[postIndex].status = fullySuccess ? 'completed' : 'partial';
        if (xError) posts[postIndex].xError = xError;
        if (vrcImageError) posts[postIndex].vrcImageError = vrcImageError;
        await storage.set({ posts });

        const issues = [];
        if (vrcImageError) issues.push(`画像添付失敗`);
        if (xError) issues.push(`X投稿失敗`);
        chrome.notifications.create({
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon128.png'),
            title: fullySuccess ? 'VRChat Group Scheduled Post' : `投稿完了（${issues.join(' / ')}）`,
            message: fullySuccess
                ? `Successfully posted to group: ${post.groupName || post.groupId}`
                : `VRChat投稿はOK。${vrcImageError ? '画像: ' + vrcImageError + '. ' : ''}${xError ? 'X: ' + xError : ''}`
        });

    } catch (error) {
        console.error('Failed to post:', error);

        posts[postIndex].status = 'failed';
        posts[postIndex].error = error.message;
        await storage.set({ posts });

        chrome.notifications.create({
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon128.png'),
            title: 'VRChat Group Post Failed',
            message: `Failed to post to group: ${post.groupName || post.groupId}`
        });
    }
});

// IPC Message Listener from Frontend
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Wrap async function to handle response
    (async () => {
        try {
            if (request.type === 'API_CALL') {
                const result = await handleApiCall(request.payload);
                sendResponse({ success: true, data: result });
            } else if (request.type === 'SCHEDULE_POST') {
                const { post } = request.payload;
                const timestamp = new Date(post.scheduledAt).getTime();
                await scheduler.addJob(post.id, timestamp);
                sendResponse({ success: true });
            } else if (request.type === 'CANCEL_POST') {
                const { postId } = request.payload;
                await scheduler.removeJob(postId);
                sendResponse({ success: true });
            } else if (request.type === 'STORAGE_GET') {
                const result = await storage.get(request.payload.keys);
                sendResponse({ success: true, data: result });
            } else if (request.type === 'STORAGE_SET') {
                await storage.set(request.payload.items);
                sendResponse({ success: true });
            } else {
                throw new Error(`Unknown message type: ${request.type}`);
            }
        } catch (error) {
            console.error('Message handling error:', error);
            sendResponse({ success: false, error: error.message || 'Unknown error occurred' });
        }
    })();

    return true; // Keep message channel open for async response
});

async function handleApiCall({ action, params }) {
    switch (action) {
        case 'getAuth':
            return api.getAuth();
        case 'getGroups':
            return api.getUserGroups(params.userId);
        case 'refreshGroups':
            return api.refreshUserGroups(params.userId);
        case 'getGroup':
            return api.getGroup(params.groupId);
        case 'xCheckLogin':
            return xApi.checkLogin();
        case 'xPostNow': {
            const { text, imageDataUrl } = params || {};
            return xApi.post(text, imageDataUrl || null);
        }
        default:
            throw new Error(`Unknown action: ${action}`);
    }
}
