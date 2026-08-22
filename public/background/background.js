// background/background.js
import { api } from './api.js';
import { storage } from './storage.js';
import { scheduler } from './scheduler.js';

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
        // Preserve the ORIGINAL intended day-of-month (recurrence.anchorDay),
        // clamping to each target month's last day. Deriving the day from `prev`
        // would let a clamp stick (Jan31 -> Feb28 -> Mar28...), so we anchor off
        // the stored intent and restore 31 wherever the month allows.
        const day = (Number.isInteger(recurrence.anchorDay) && recurrence.anchorDay >= 1 && recurrence.anchorDay <= 31)
            ? recurrence.anchorDay
            : prev.getDate();
        const h = prev.getHours(), mi = prev.getMinutes(), s = prev.getSeconds();
        let next = new Date(prev.getTime());
        let guard = 0;
        do {
            const y = next.getFullYear();
            const m = next.getMonth() + 1; // advance one month (may roll year)
            const lastDay = new Date(y, m + 1, 0).getDate(); // last day of target month
            next = new Date(y, m, Math.min(day, lastDay), h, mi, s, 0);
        } while (next.getTime() <= now && ++guard < 1200);
        return next.getTime() > now ? next : null;
    }
    return null;
}

// First fire time for a freshly-created schedule. For weekly recurrence with
// specific days, align the first execution to the first selected weekday on/after
// the chosen start (so picking Mon-start with days=[Wed] fires on Wed, not Mon).
function firstFireTime(startTs, recurrence) {
    const start = new Date(startTs);
    if (recurrence && recurrence.type === 'weekly' && recurrence.days && recurrence.days.length) {
        if (recurrence.days.includes(start.getDay())) return start;
        for (let i = 1; i <= 7; i++) {
            const cand = new Date(start.getTime());
            cand.setDate(start.getDate() + i);
            if (recurrence.days.includes(cand.getDay())) return cand;
        }
    }
    return start;
}

// Atomic-ish single-post update: re-read storage right before writing and mutate
// only the target post, so concurrent alarm handlers don't clobber each other's
// changes (read-modify-write race mitigation). The mutate callback may return
// false to abort the write (e.g. the post was trashed between reads). Returns
// { found, written, status } describing the freshly-read post.
async function updatePostById(postId, mutate) {
    const { posts } = await storage.get(['posts']);
    if (!posts) return { found: false, written: false, status: null };
    const i = posts.findIndex(p => p.id === postId);
    if (i === -1) return { found: false, written: false, status: null };
    const proceed = mutate(posts[i]);
    if (proceed === false) return { found: true, written: false, status: posts[i].status };
    await storage.set({ posts });
    return { found: true, written: true, status: posts[i].status };
}

// v2.2.0-rc.6 no longer supports X cross-posting. Remove those obsolete fields
// from existing local records as well as from imported backups, so subsequent
// backups contain only data used by the VRChat scheduler.
async function removeLegacyXFields() {
    const { posts } = await storage.get(['posts']);
    if (!Array.isArray(posts)) return;
    let changed = false;
    for (const post of posts) {
        for (const field of ['postToX', 'xText', 'xError']) {
            if (Object.hasOwn(post, field)) {
                delete post[field];
                changed = true;
            }
        }
    }
    if (changed) await storage.set({ posts });
}

chrome.runtime.onInstalled.addListener(() => {
    console.log('VRChat Group Scheduler Extension Installed');

    // Initialize storage if empty
    storage.get(['posts']).then(result => {
        if (!result.posts) {
            storage.set({ posts: [] });
        }
    });
    removeLegacyXFields().catch(error => console.warn('Failed to remove legacy X fields:', error));
});

chrome.runtime.onStartup.addListener(() => {
    removeLegacyXFields().catch(error => console.warn('Failed to remove legacy X fields:', error));
});

// Alarm Listener
chrome.alarms.onAlarm.addListener(async (alarm) => {
    const postId = alarm.name;
    console.log(`Alarm fired for post: ${postId}`);

    const { posts } = await storage.get(['posts']);
    if (!posts) return;

    const post = posts.find(p => p.id === postId);
    if (!post) {
        console.warn(`Post ${postId} not found in storage; clearing stale alarm.`);
        await scheduler.removeJob(postId);
        return;
    }
    // Only act on a post that is genuinely awaiting a run. Anything else (deleted,
    // or a terminal completed/partial/failed/missed one-shot) means this alarm is
    // stale — e.g. a leftover alarm after a backup import overwrote the post's
    // state. Re-posting it would create a duplicate VRChat post, so refuse.
    if (post.status !== 'pending' && post.status !== 'recurring') {
        console.warn(`Post ${postId} status='${post.status}' is not schedulable; clearing stale alarm.`);
        await scheduler.removeJob(postId);
        return;
    }

    const isRecurring = !!post.recurrence;
    let vrcImageError = null;
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

    } catch (error) {
        hardError = error.message;
        console.error('Failed to post:', error);
    }

    const fullySuccess = !hardError && !vrcImageError;

    // For recurring posts, compute the next fire time so the schedule continues
    // even if this run failed (a transient failure must not kill the series).
    // Backfill the monthly anchor day for legacy posts created before anchorDay
    // existed, so the live re-arm path doesn't drift either.
    let nextTs = null;
    let anchorBackfill = null;
    if (isRecurring) {
        if (post.recurrence.type === 'monthly'
            && !(Number.isInteger(post.recurrence.anchorDay) && post.recurrence.anchorDay >= 1 && post.recurrence.anchorDay <= 31)) {
            anchorBackfill = new Date(post.scheduledAt).getDate();
            post.recurrence.anchorDay = anchorBackfill;
        }
        const next = computeNextOccurrence(new Date(post.scheduledAt), post.recurrence);
        if (next) nextTs = next.getTime();
    }

    const upd = await updatePostById(postId, (p) => {
        // If the user trashed (or removed) this post while it was mid-fire, don't
        // resurrect it and don't re-arm — honour the deletion.
        if (p.status === 'deleted') return false;
        if (isRecurring) {
            p.status = 'recurring';
            p.lastRunAt = new Date().toISOString();
            p.lastResult = hardError ? 'failed' : (fullySuccess ? 'success' : 'partial');
            if (anchorBackfill && p.recurrence) p.recurrence.anchorDay = anchorBackfill;
            if (nextTs) p.scheduledAt = new Date(nextTs).toISOString();
        } else {
            p.status = hardError ? 'failed' : (fullySuccess ? 'completed' : 'partial');
        }
        // Record / clear last-run diagnostics.
        if (hardError) p.error = hardError; else delete p.error;
        if (vrcImageError) p.vrcImageError = vrcImageError; else delete p.vrcImageError;
        return true;
    });

    // Re-arm AFTER persisting the next scheduledAt so storage and the alarm agree.
    // Only re-arm if the update actually applied (post still active, not trashed).
    if (!upd.written) {
        console.warn(`[Scheduler] post ${postId} was trashed/removed mid-fire; clearing alarm.`);
        await scheduler.removeJob(postId);
    } else if (isRecurring && nextTs) {
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
        chrome.notifications.create({
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon128.png'),
            title: fullySuccess
                ? (isRecurring ? 'VRChat 定期投稿' : 'VRChat Group Scheduled Post')
                : `投稿完了（${issues.join(' / ')}）`,
            message: fullySuccess
                ? `Successfully posted to group: ${post.groupName || post.groupId}`
                : `VRChat投稿はOK。${vrcImageError ? '画像: ' + vrcImageError : ''}`
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
                // Capture the original day-of-month for monthly recurrence so
                // clamping in short months never drifts the day permanently.
                let anchorDayPatch = null;
                if (post.recurrence && post.recurrence.type === 'monthly'
                    && !(Number.isInteger(post.recurrence.anchorDay) && post.recurrence.anchorDay >= 1 && post.recurrence.anchorDay <= 31)) {
                    anchorDayPatch = new Date(timestamp).getDate();
                    post.recurrence.anchorDay = anchorDayPatch; // so firstFire/compute use it now
                }
                // Align the first execution to the recurrence (weekly day picker),
                // so a Mon-start with days=[Wed] first fires on Wed, not Mon.
                let when = firstFireTime(timestamp, post.recurrence).getTime();
                if (when <= Date.now()) {
                    if (!post.recurrence) {
                        throw new Error('過去の日時は指定できません');
                    }
                    // Past-start recurring → arm the next upcoming occurrence.
                    const next = computeNextOccurrence(new Date(when), post.recurrence);
                    if (!next) throw new Error('次回の発火時刻を計算できませんでした');
                    when = next.getTime();
                }
                await scheduler.addJob(post.id, when);
                // Persist the actual first-fire time and the monthly anchor day so
                // the queue isn't stale and the schedule stays drift-free.
                if (when !== timestamp || anchorDayPatch) {
                    await updatePostById(post.id, (p) => {
                        if (when !== timestamp) p.scheduledAt = new Date(when).toISOString();
                        if (anchorDayPatch && p.recurrence) p.recurrence.anchorDay = anchorDayPatch;
                        return true;
                    });
                }
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
            } else if (request.type === 'EXPORT_BACKUP') {
                const result = await exportBackup();
                sendResponse({ success: true, data: result });
            } else if (request.type === 'IMPORT_BACKUP') {
                const result = await importBackup(request.payload || {});
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
const ALLOWED_LASTRESULT = new Set(['success', 'partial', 'failed']);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const MAX_IMAGE_DATAURL = 8 * 1024 * 1024; // 8 MiB data: string (~6MB binary); guards storage bloat

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
        status: ALLOWED_STATUS.has(p.status) ? p.status : 'pending',
    };
    if (typeof p.imageName === 'string') clean.imageName = p.imageName.slice(0, 300);
    // Only accept reasonably-sized data:image/ payloads; drop anything else
    // (e.g. http(s) URLs) and over-large blobs that would bloat storage.
    if (typeof p.imageDataUrl === 'string' && /^data:image\//i.test(p.imageDataUrl) && p.imageDataUrl.length <= MAX_IMAGE_DATAURL) {
        clean.imageDataUrl = p.imageDataUrl;
    }
    if (p.recurrence && typeof p.recurrence === 'object' && ALLOWED_RECUR.has(p.recurrence.type)) {
        const rec = { type: p.recurrence.type };
        if (Array.isArray(p.recurrence.days)) {
            rec.days = p.recurrence.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6);
        }
        if (Number.isInteger(p.recurrence.anchorDay) && p.recurrence.anchorDay >= 1 && p.recurrence.anchorDay <= 31) {
            rec.anchorDay = p.recurrence.anchorDay;
        }
        clean.recurrence = rec;
    }
    // Preserve last-run diagnostics so a round-trip backup keeps history — but
    // ONLY for statuses where an error is meaningful. A 'completed'/'pending'
    // post must not carry an error string (a tampered backup could otherwise show
    // a stale 「投稿失敗」 banner on a successful post).
    const keepDiagnostics = clean.status === 'recurring' || clean.status === 'failed' || clean.status === 'partial';
    if (keepDiagnostics) {
        if (typeof p.lastRunAt === 'string') clean.lastRunAt = p.lastRunAt.slice(0, 40);
        if (ALLOWED_LASTRESULT.has(p.lastResult)) clean.lastResult = p.lastResult;
        if (typeof p.error === 'string') clean.error = p.error.slice(0, 500);
        if (typeof p.vrcImageError === 'string') clean.vrcImageError = p.vrcImageError.slice(0, 500);
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

    // CRITICAL: clear every pre-existing alarm for the merged posts BEFORE
    // re-arming. Otherwise a stale alarm from a prior schedule (e.g. an id that
    // import just overwrote with a terminal/one-shot post) would survive and
    // re-fire, producing a duplicate VRChat post. We then arm only the posts
    // that legitimately qualify below.
    for (const p of merged) {
        await scheduler.removeJob(p.id);
    }

    // Re-arm alarms for active posts. For a recurring post whose stored time is
    // already in the past, arm the next upcoming occurrence so it stays alive.
    const now = Date.now();
    let rescheduled = 0;
    for (const p of merged) {
        if ((p.status === 'pending' || p.status === 'recurring') && p.scheduledAt) {
            const ts = new Date(p.scheduledAt).getTime();
            if (Number.isNaN(ts)) continue;
            // Backfill the monthly anchor day for older backups that predate it,
            // so re-armed monthly schedules don't drift.
            if (p.recurrence && p.recurrence.type === 'monthly'
                && !(Number.isInteger(p.recurrence.anchorDay) && p.recurrence.anchorDay >= 1 && p.recurrence.anchorDay <= 31)) {
                p.recurrence.anchorDay = new Date(ts).getDate();
            }
            let when = ts;
            if (ts <= now) {
                if (!p.recurrence) continue; // a past one-shot is not re-armed
                const next = computeNextOccurrence(new Date(ts), p.recurrence);
                if (!next) continue;
                when = next.getTime();
                p.scheduledAt = next.toISOString();
            } else {
                // Future-start: align the first fire to the recurrence (weekly day
                // picker) just like SCHEDULE_POST, so a hand-crafted/legacy backup
                // whose start weekday isn't in days fires on the right day.
                const aligned = firstFireTime(ts, p.recurrence).getTime();
                if (aligned !== ts) {
                    when = aligned;
                    p.scheduledAt = new Date(aligned).toISOString();
                }
            }
            await scheduler.addJob(p.id, when);
            rescheduled++;
        }
    }
    // Persist any scheduledAt advances made above.
    await storage.set({ posts: merged });
    return { total: merged.length, added, updated, skipped, rescheduled };
}

// Group permission caches are keyed by the VRChat user ID. Include only the
// fields the UI needs, rather than serialising arbitrary API responses from
// chrome.storage, and cap the size to keep imported backups bounded.
const GROUP_CACHE_KEY = /^group-permissions-usr_[A-Za-z0-9-]{1,100}$/;
const MAX_GROUP_CACHES = 10;
const MAX_GROUPS_PER_CACHE = 500;

function sanitizeGroupCaches(caches) {
    if (!caches || typeof caches !== 'object' || Array.isArray(caches)) return {};
    const cleanCaches = {};
    for (const [key, cache] of Object.entries(caches)) {
        if (Object.keys(cleanCaches).length >= MAX_GROUP_CACHES) break;
        if (!GROUP_CACHE_KEY.test(key) || !cache || typeof cache !== 'object' || Array.isArray(cache)) continue;
        const groups = {};
        for (const [groupId, info] of Object.entries(cache.groups || {})) {
            if (Object.keys(groups).length >= MAX_GROUPS_PER_CACHE) break;
            if (typeof groupId !== 'string' || groupId.length > 100 || !info || typeof info !== 'object') continue;
            const source = info.groupData && typeof info.groupData === 'object' ? info.groupData : {};
            const name = str(info.name || source.name, 300);
            const shortCode = str(info.shortCode || source.shortCode, 100);
            groups[groupId] = {
                name,
                shortCode,
                isOwner: !!info.isOwner,
                hasPermission: !!info.hasPermission,
                checkedAt: str(info.checkedAt, 40),
                groupData: {
                    id: str(source.id, 100) || groupId,
                    groupId,
                    name,
                    shortCode,
                },
            };
        }
        cleanCaches[key] = {
            lastFullCheck: str(cache.lastFullCheck, 40),
            lastRefresh: str(cache.lastRefresh, 40),
            groups,
        };
    }
    return cleanCaches;
}

async function exportBackup() {
    const all = await storage.get(null);
    const groupCaches = {};
    for (const [key, value] of Object.entries(all)) {
        if (GROUP_CACHE_KEY.test(key)) groupCaches[key] = value;
    }
    return {
        posts: Array.isArray(all.posts) ? all.posts : [],
        groupCaches: sanitizeGroupCaches(groupCaches),
    };
}

async function importBackup({ posts = [], groupCaches = {} }) {
    const postResult = await importPosts(posts);
    const cleanCaches = sanitizeGroupCaches(groupCaches);
    if (Object.keys(cleanCaches).length) await storage.set(cleanCaches);
    return { ...postResult, groupCachesRestored: Object.keys(cleanCaches).length };
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
        default:
            throw new Error(`Unknown action: ${action}`);
    }
}
