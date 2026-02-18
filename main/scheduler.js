import schedule from 'node-schedule';
import { readJson, writeJson } from './storage.js';
import { createGroupPost } from './vrchat.js';
import crypto from 'crypto'; // Native in Node

const POSTS_FILE = 'posts.json';

// In-memory job store
const jobs = new Map();

export async function initScheduler() {
    console.log('Initializing Scheduler...');
    const posts = await readJson(POSTS_FILE, []);

    // Load pending AND recurring posts
    const activePosts = posts.filter(p => p.status === 'pending' || p.status === 'recurring');
    console.log(`Found ${activePosts.length} active posts.`);

    activePosts.forEach(post => {
        schedulePostJob(post);
    });
}

function schedulePostJob(post) {
    const date = new Date(post.scheduledAt);

    // Only check past date for non-recurring posts
    if (!post.recurrence && date < new Date()) {
        console.log(`Post ${post.id} is in the past. Marking as failed/missed.`);
        updatePostStatus(post.id, 'missed', { error: 'Scheduled time passed while app was closed' });
        return;
    }

    let rule = date;
    if (post.recurrence) {
        rule = new schedule.RecurrenceRule();
        rule.hour = date.getHours();
        rule.minute = date.getMinutes();

        // Default to seconds = 0 to avoid multiple firings if not specified
        rule.second = 0;

        if (post.recurrence.type === 'daily') {
            // Runs every day at HH:MM
        } else if (post.recurrence.type === 'weekly') {
            // days is array of 0-6
            rule.dayOfWeek = post.recurrence.days;
        } else if (post.recurrence.type === 'monthly') {
            rule.date = date.getDate();
        }
        console.log(`Scheduling recurring post ${post.id} with rule:`, JSON.stringify(rule));
    }

    const job = schedule.scheduleJob(rule, async () => {
        console.log(`Executing scheduled post: ${post.title}`);
        try {
            await createGroupPost(post.groupId, {
                title: post.title,
                text: post.text,
                imageId: post.imageId || undefined,
                sendNotification: post.sendNotification || false,
                visibility: post.visibility || 'public'
            });

            if (post.recurrence) {
                // For recurring posts, create a history entry
                console.log(`Recurring post ${post.id} executed. Creating history entry.`);
                await addPost({
                    ...post,
                    id: crypto.randomUUID(), // New ID for history
                    parentId: post.id,
                    recurrence: null, // History is not recurring
                    status: 'posted',
                    scheduledAt: new Date().toISOString(), // Actual execution time
                    createdAt: new Date().toISOString()
                }, true); // true = skip schedule
            } else {
                // Normal post
                await updatePostStatus(post.id, 'posted');
            }
            console.log(`Post success.`);
        } catch (err) {
            console.error(`Post failed:`, err);
            if (post.recurrence) {
                await addPost({
                    ...post,
                    id: crypto.randomUUID(),
                    parentId: post.id,
                    recurrence: null,
                    status: 'failed',
                    error: err.message,
                    scheduledAt: new Date().toISOString(),
                    createdAt: new Date().toISOString()
                }, true);
            } else {
                await updatePostStatus(post.id, 'failed', { error: err.message });
            }
        }
    });

    jobs.set(post.id, job);
    if (!post.recurrence) {
        console.log(`Scheduled post ${post.id} for ${date.toISOString()}`);
    }
}

async function updatePostStatus(id, status, extra = {}) {
    const posts = await readJson(POSTS_FILE, []);
    const index = posts.findIndex(p => p.id === id);
    if (index !== -1) {
        posts[index] = { ...posts[index], status, ...extra, updatedAt: new Date().toISOString() };
        await writeJson(POSTS_FILE, posts);
    }
}

// Added skipSchedule param
export async function addPost(postData, skipSchedule = false) {
    const posts = await readJson(POSTS_FILE, []);

    const newPost = {
        id: crypto.randomUUID(),
        status: 'pending',
        createdAt: new Date().toISOString(),
        ...postData
    };

    posts.push(newPost);
    await writeJson(POSTS_FILE, posts);

    if (!skipSchedule) {
        schedulePostJob(newPost);
    }
    return newPost;
}

export async function deletePost(id, force = false) {
    if (jobs.has(id)) {
        jobs.get(id).cancel();
        jobs.delete(id);
        console.log(`Job for post ${id} cancelled.`);
    }

    let posts = await readJson(POSTS_FILE, []);

    if (force) {
        posts = posts.filter(p => p.id !== id);
        console.log(`Post ${id} permanently deleted.`);
    } else {
        const index = posts.findIndex(p => p.id === id);
        if (index !== -1) {
            posts[index] = {
                ...posts[index],
                status: 'deleted',
                updatedAt: new Date().toISOString()
            };
            console.log(`Post ${id} moved to trash.`);
        }
    }

    await writeJson(POSTS_FILE, posts);
}

export async function getPosts(includeDeleted = false, statusFilter = null) {
    let posts = await readJson(POSTS_FILE, []);

    if (statusFilter) {
        posts = posts.filter(p => p.status === statusFilter);
    } else if (!includeDeleted) {
        posts = posts.filter(p => p.status !== 'deleted');
    }

    return posts;
}
