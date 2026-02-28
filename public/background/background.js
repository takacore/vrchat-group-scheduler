// background/background.js
import { api } from './api.js';
import { storage } from './storage.js';
import { scheduler } from './scheduler.js';

chrome.runtime.onInstalled.addListener(() => {
    console.log('VRChat Group Scheduler Extension Installed');

    // Initialize storage if empty
    storage.get(['posts']).then(result => {
        if (!result.posts) {
            storage.set({ posts: [] });
        }
    });
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
        const result = await api.createGroupPost(post.groupId, post.title, post.text, post.sendNotification);
        console.log('Post successful:', result);

        // Update post status
        posts[postIndex].status = 'completed';
        await storage.set({ posts });

        chrome.notifications.create({
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon128.png'),
            title: 'VRChat Group Scheduled Post',
            message: `Successfully posted to group: ${post.groupName || post.groupId}`
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
        default:
            throw new Error(`Unknown action: ${action}`);
    }
}
