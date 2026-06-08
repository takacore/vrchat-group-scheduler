// background/background.js
import { api } from './api.js';
import { storage } from './storage.js';
import { scheduler } from './scheduler.js';
import { xApi, clearXHeaderRule } from './x-api.js';

// Only ever turn a data:image/ URL into a blob. This prevents an imported
// backup (or any crafted post) from making the SW fetch an arbitrary URL.
async function dataUrlToBlob(dataUrl) {
    if (typeof dataUrl !== 'string' || !/^data:image\//i.test(dataUrl)) {
        throw new Error('画像データが不正です（data:image/ 形式のみ許可）');
    }
    const res = await fetch(dataUrl);
    return res.blob();
}

// Compute the next fire time for a recurring post, strictly in the future.
// If the SW slept through several periods we jump to the next upcoming one
// (we do NOT replay every missed occurrence).
function computeNextOccurrence(prev, recurrence) {
    if (!recurrence || !(prev instanceof Date) || Number.isNaN(prev.getTime())) return null;
    const now = Date.now();
    const type = recurrence.type;
    if (type === 'daily') {
        const next = new Date(prev.getTime());
        do { next.setDate(next.getDate() + 1); } while (next.getTime() <= now);
        return next;
    }
    if (type === 'weekly') {
        const days = (recurrence.days && recurrence.days.length)
            ? recurrence.days
            : [prev.getDay()];
        for (let i = 1; i <= 366; i++) {
            const cand = new Date(prev.getTime());
            cand.setDate(prev.getDate() + i); // preserves time-of-day
            if (days.includes(cand.getDay()) && cand.getTime() > now) return cand;
        }
        return null;
    }
    if (type === 'monthly') {
        const next = new Date(prev.getTime());
        do { next.setMonth(next.getMonth() + 1); } while (next.getTime() <= now);
        return next;
    }
    return null;
}

// Atomic-ish single-post update: re-read storage right before writing and mutate
// only the target post, so concurrent alarm handlers don't clobber each other's
// changes (read-modify-write race mitigation).
async function updatePostById(postId, mutate) {
    const { posts } = await storage.get(['posts']);
    if (!posts) return;
    const i = posts.findIndex(p => p.id === postId);
    if (i === -1) return;
    mutate(posts[i]);
    await storage.set({ posts });
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

    const post = posts.find(p => p.id === postId);
    if (!post) {
        console.warn(`Post ${postId} not found in storage.`);
        return;
    }
    if (post.status === 'deleted') {
        console.warn(`Post ${postId} is deleted; skipping and clearing alarm.`);
        await scheduler.removeJob(postId);
        return;
    }

    const isRecurring = !!post.recurrence;
    let vrcImageError = null;
    let xError = null;
    let xResultOk = true;
    let hardError = null;

    try {
        let imageId = null;
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
    } catch (error) {
        hardError = error.message;
        console.error('Failed to post:', error);
    }

    const fullySuccess = !hardError && xResultOk && !vrcImageError;

    // For recurring posts, compute the next fire time so the schedule continues
    // even if this run failed (a transient failure must not kill the series).
    let nextTs = null;
    if (isRecurring) {
        const next = computeNextOccurrence(new Date(post.scheduledAt), post.recurrence);
        if (next) nextTs = next.getTime();
    }

    await updatePostById(postId, (p) => {
        if (isRecurring) {
            p.status = 'recurring';
            p.lastRunAt = new Date().toISOString();
            p.lastResult = hardError ? 'failed' : (fullySuccess ? 'success' : 'partial');
            if (nextTs) p.scheduledAt = new Date(nextTs).toISOString();
        } else {
            p.status = hardError ? 'failed' : (fullySuccess ? 'completed' : 'partial');
        }
        // Record / clear last-run diagnostics.
        if (hardError) p.error = hardError; else delete p.error;
        if (xError) p.xError = xError; else delete p.xError;
        if (vrcImageError) p.vrcImageError = vrcImageError; else delete p.vrcImageError;
    });

    // Re-arm AFTER persisting the next scheduledAt so storage and the alarm agree.
    if (isRecurring && nextTs) {
        await scheduler.addJob(postId, nextTs);
        console.log(`[Scheduler] recurring re-armed for ${new Date(nextTs).toLocaleString()}`);
    } else if (isRecurring) {
        console.warn(`[Scheduler] recurring post ${postId} produced no next occurrence; not re-armed.`);
    }

    // Notify.
    if (hardError) {
        chrome.notifications.create({
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon128.png'),
            title: 'VRChat Group Post Failed',
            message: `Failed to post to group: ${post.groupName || post.groupId}`
        });
    } else {
        const issues = [];
        if (vrcImageError) issues.push('画像添付失敗');
        if (xError) issues.push('X投稿失敗');
        chrome.notifications.create({
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon128.png'),
            title: fullySuccess
                ? (isRecurring ? 'VRChat 定期投稿' : 'VRChat Group Scheduled Post')
                : `投稿完了（${issues.join(' / ')}）`,
            message: fullySuccess
                ? `Successfully posted to group: ${post.groupName || post.groupId}`
                : `VRChat投稿はOK。${vrcImageError ? '画像: ' + vrcImageError + '. ' : ''}${xError ? 'X: ' + xError : ''}`
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
                if (Number.isNaN(timestamp)) {
                    throw new Error('スケジュール日時が不正です');
                }
                if (timestamp <= Date.now() && !post.recurrence) {
                    throw new Error('過去の日時は指定できません');
                }
                // For a recurring post whose start time is already past, arm the
                // next upcoming occurrence instead of firing immediately.
                let when = timestamp;
                if (timestamp <= Date.now() && post.recurrence) {
                    const next = computeNextOccurrence(new Date(timestamp), post.recurrence);
                    if (!next) throw new Error('次回の発火時刻を計算できませんでした');
                    when = next.getTime();
                }
                await scheduler.addJob(post.id, when);
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
            } else if (request.type === 'IMPORT_POSTS') {
                const result = await importPosts(request.payload.posts || []);
                sendResponse({ success: true, data: result });
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

// Validate & normalize one imported post. Returns a clean object or null.
// Imported JSON is untrusted input, so we whitelist fields, enforce types,
// clamp lengths, and reject anything that isn't a data:image/ image. This blocks
// crafted backups from injecting arbitrary URLs or unexpected shapes.
const ALLOWED_STATUS = new Set(['pending', 'recurring', 'completed', 'partial', 'failed', 'missed', 'deleted']);
const ALLOWED_RECUR = new Set(['daily', 'weekly', 'monthly']);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function sanitizeImportedPost(p) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id) return null;
    if (typeof p.groupId !== 'string' || !p.groupId) return null;

    const clean = {
        id: p.id.slice(0, 100),
        groupId: p.groupId.slice(0, 100),
        groupName: str(p.groupName, 300),
        title: str(p.title, 1000),
        text: str(p.text, 20000),
        scheduledAt: str(p.scheduledAt, 40),
        created_at: str(p.created_at, 40) || new Date().toISOString(),
        sendNotification: !!p.sendNotification,
        postToX: !!p.postToX,
        status: ALLOWED_STATUS.has(p.status) ? p.status : 'pending',
    };
    if (typeof p.xText === 'string') clean.xText = p.xText.slice(0, 1000);
    if (typeof p.imageName === 'string') clean.imageName = p.imageName.slice(0, 300);
    // Only accept data:image/ payloads; drop anything else (e.g. http(s) URLs).
    if (typeof p.imageDataUrl === 'string' && /^data:image\//i.test(p.imageDataUrl)) {
        clean.imageDataUrl = p.imageDataUrl;
    }
    if (p.recurrence && typeof p.recurrence === 'object' && ALLOWED_RECUR.has(p.recurrence.type)) {
        const rec = { type: p.recurrence.type };
        if (Array.isArray(p.recurrence.days)) {
            rec.days = p.recurrence.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6);
        }
        clean.recurrence = rec;
    }
    return clean;
}

// Restore a backup: validate + merge incoming posts into storage by id (incoming
// wins) and re-arm alarms for any future pending/recurring posts so schedules
// survive an update / machine migration where the previous alarms were lost.
async function importPosts(incoming) {
    if (!Array.isArray(incoming)) throw new Error('インポートデータが配列ではありません');

    const { posts: existing = [] } = await storage.get(['posts']);
    const byId = new Map((existing || []).map(p => [p.id, p]));

    let added = 0;
    let updated = 0;
    let skipped = 0;
    for (const raw of incoming) {
        const p = sanitizeImportedPost(raw);
        if (!p) { skipped++; continue; }
        if (byId.has(p.id)) updated++; else added++;
        byId.set(p.id, p);
    }
    const merged = [...byId.values()];
    await storage.set({ posts: merged });

    // Re-arm alarms for active posts. For a recurring post whose stored time is
    // already in the past, arm the next upcoming occurrence so it stays alive.
    const now = Date.now();
    let rescheduled = 0;
    for (const p of merged) {
        if ((p.status === 'pending' || p.status === 'recurring') && p.scheduledAt) {
            const ts = new Date(p.scheduledAt).getTime();
            if (Number.isNaN(ts)) continue;
            let when = ts;
            if (ts <= now) {
                if (!p.recurrence) continue; // a past one-shot is not re-armed
                const next = computeNextOccurrence(new Date(ts), p.recurrence);
                if (!next) continue;
                when = next.getTime();
                p.scheduledAt = next.toISOString();
            }
            await scheduler.addJob(p.id, when);
            rescheduled++;
        }
    }
    // Persist any scheduledAt advances made above.
    await storage.set({ posts: merged });
    return { total: merged.length, added, updated, skipped, rescheduled };
}

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
