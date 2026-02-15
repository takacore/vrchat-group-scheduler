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

    const pendingPosts = posts.filter(p => p.status === 'pending');
    console.log(`Found ${pendingPosts.length} pending posts.`);

    pendingPosts.forEach(post => {
        schedulePostJob(post);
    });
}

function schedulePostJob(post) {
    const date = new Date(post.scheduledAt);

    if (date < new Date()) {
        console.log(`Post ${post.id} is in the past. Marking as failed/missed.`);
        updatePostStatus(post.id, 'missed', { error: 'Scheduled time passed while app was closed' });
        return;
    }

    const job = schedule.scheduleJob(date, async () => {
        console.log(`Executing scheduled post: ${post.title}`);
        try {
            await createGroupPost(post.groupId, {
                title: post.title,
                text: post.text,
                imageId: post.imageId || undefined,
                sendNotification: post.sendNotification || false,
                visibility: post.visibility || 'public'
            });
            await updatePostStatus(post.id, 'posted');
            console.log(`Post ${post.id} success.`);
        } catch (err) {
            console.error(`Post ${post.id} failed:`, err);
            await updatePostStatus(post.id, 'failed', { error: err.message });
        }
    });

    jobs.set(post.id, job);
    console.log(`Scheduled post ${post.id} for ${date.toISOString()}`);
}

async function updatePostStatus(id, status, extra = {}) {
    const posts = await readJson(POSTS_FILE, []);
    const index = posts.findIndex(p => p.id === id);
    if (index !== -1) {
        posts[index] = { ...posts[index], status, ...extra, updatedAt: new Date().toISOString() };
        await writeJson(POSTS_FILE, posts);
    }
}

export async function addPost(postData) {
    const posts = await readJson(POSTS_FILE, []);

    const newPost = {
        id: crypto.randomUUID(),
        status: 'pending',
        createdAt: new Date().toISOString(),
        ...postData
    };

    posts.push(newPost);
    await writeJson(POSTS_FILE, posts);
    schedulePostJob(newPost);
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

    // Sort logic can be here or frontend. Let's return raw and sort in frontend or here.
    // Standardize: return all filtered.
    return posts;
}
