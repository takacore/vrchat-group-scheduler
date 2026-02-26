import { readJson, writeJson } from './storage.js';
import fetch from 'node-fetch';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const API_BASE = 'https://api.vrchat.cloud/api/1';
const USER_AGENT = `VRChatGroupScheduler/${pkg.version} ai.takacore@gmail.com`;
const AUTH_FILE = 'auth.json';

// --- Rate Limiter & Backoff ---
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1000; // 1 second minimum between requests

async function apiRequest(url, options = {}) {
    // Rate limiting: ensure minimum interval between requests
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL) {
        await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - elapsed));
    }
    lastRequestTime = Date.now();

    // Retry with exponential backoff
    const maxRetries = 3;
    let backoff = 2000; // Start at 2 seconds

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const res = await fetch(url, options);

        if (res.status === 429) {
            if (attempt < maxRetries) {
                console.warn(`[VRChat API] Rate limited (429). Retrying in ${backoff / 1000}s... (attempt ${attempt + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, backoff));
                backoff = Math.min(backoff * 2, 30000); // Max 30 seconds
                continue;
            }
            console.error('[VRChat API] Rate limited after max retries.');
        }

        // For other server errors (5xx), also retry
        if (res.status >= 500 && attempt < maxRetries) {
            console.warn(`[VRChat API] Server error (${res.status}). Retrying in ${backoff / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, backoff));
            backoff = Math.min(backoff * 2, 30000);
            continue;
        }

        return res;
    }

    throw new Error('VRChat API request failed after max retries');
}

// --- Cache ---
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
        return entry.data;
    }
    cache.delete(key);
    return null;
}

function setCache(key, data) {
    cache.set(key, { data, timestamp: Date.now() });
}

export function clearCache() {
    cache.clear();
}

// --- Auth ---
async function getAuthHeaders() {
    const authData = await readJson(AUTH_FILE, {}, { encrypted: true });
    if (!authData.cookies) return { 'User-Agent': USER_AGENT };

    return {
        'User-Agent': USER_AGENT,
        'Cookie': authData.cookies,
    };
}

async function saveCookies(response) {
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
        const currentAuth = await readJson(AUTH_FILE, {}, { encrypted: true });
        let currentCookies = currentAuth.cookies || '';

        let newCookies = [];
        if (typeof setCookie === 'string') {
            newCookies = setCookie.split(/,(?=\s*[^;]+=[^;]+)/).map(c => c.split(';')[0].trim());
        } else if (Array.isArray(setCookie)) {
            newCookies = setCookie.map(c => c.split(';')[0].trim());
        }

        const cookieMap = new Map();

        // Load existing
        currentCookies.split(';').forEach(c => {
            const [k, v] = c.split('=').map(s => s.trim());
            if (k) cookieMap.set(k, v);
        });

        // Update with new
        newCookies.forEach(c => {
            const [k, v] = c.split('=').map(s => s.trim());
            if (k) cookieMap.set(k, v);
        });

        // Reconstruct
        const cookieString = Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');

        await writeJson(AUTH_FILE, { ...currentAuth, cookies: cookieString }, { encrypted: true });
    }
}

// --- Auth API ---
export async function logout() {
    clearCache();
    await writeJson(AUTH_FILE, {}, { encrypted: true });
    return true;
}

export async function login(username, password) {
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    const res = await apiRequest(`${API_BASE}/auth/user`, {
        headers: {
            'Authorization': `Basic ${auth}`,
            'User-Agent': USER_AGENT
        }
    });

    await saveCookies(res);
    const data = await res.json();

    if (!res.ok) {
        throw new Error(data.error?.message || 'Login failed');
    }
    return data;
}

export async function verify2FA(code) {
    const headers = await getAuthHeaders();
    const res = await apiRequest(`${API_BASE}/auth/twofactorauth/totp/verify`, {
        method: 'POST',
        headers: {
            ...headers,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ code })
    });

    await saveCookies(res);
    const data = await res.json();

    if (!res.ok) {
        throw new Error(data.error?.message || '2FA verification failed');
    }
    return data;
}

export async function getCurrentUser() {
    const headers = await getAuthHeaders();
    if (!headers.Cookie) return null;

    const res = await apiRequest(`${API_BASE}/auth/user`, { headers });
    if (!res.ok) return null;
    return res.json();
}

// --- Group Post ---
export async function createGroupPost(groupId, postData) {
    const headers = await getAuthHeaders();
    const res = await apiRequest(`${API_BASE}/groups/${groupId}/posts`, {
        method: 'POST',
        headers: {
            ...headers,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(postData)
    });

    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error?.message || 'Failed to create post');
    }
    return data;
}

// --- Group Roles & Permissions ---
async function getGroupRoles(groupId) {
    const cacheKey = `roles:${groupId}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const headers = await getAuthHeaders();
    const res = await apiRequest(`${API_BASE}/groups/${groupId}/roles`, { headers });
    if (!res.ok) return [];
    const roles = await res.json();

    setCache(cacheKey, roles);
    return roles;
}

async function getGroupDetail(groupId) {
    const cacheKey = `group:${groupId}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const headers = await getAuthHeaders();
    const res = await apiRequest(`${API_BASE}/groups/${groupId}`, { headers });
    if (!res.ok) return null;
    const group = await res.json();

    setCache(cacheKey, group);
    return group;
}

async function checkAnnouncementPermission(groupId) {
    const group = await getGroupDetail(groupId);
    if (!group) return false;

    const myRoleIds = group.myMember?.roleIds || [];
    if (myRoleIds.length === 0) return false;

    const roles = await getGroupRoles(groupId);

    return roles.some(role =>
        myRoleIds.includes(role.id) &&
        (role.permissions.includes('group-announcement-manage') ||
            role.permissions.includes('*'))
    );
}

export async function getUserGroups(userId) {
    const cacheKey = `userGroups:${userId}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const headers = await getAuthHeaders();
    const res = await apiRequest(`${API_BASE}/users/${userId}/groups`, { headers });

    if (res.status === 404) return [];

    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error?.message || 'Failed to fetch groups');
    }

    const allGroups = await res.json();

    // Check permissions for each group and filter
    const groupsWithPermissions = [];
    for (const group of allGroups) {
        const isOwner = group.ownerId === userId;

        if (isOwner) {
            groupsWithPermissions.push({
                ...group,
                isOwner: true,
                hasAnnouncementPermission: true, // Owner has all permissions
            });
        } else {
            const hasPermission = await checkAnnouncementPermission(group.groupId);
            if (hasPermission) {
                groupsWithPermissions.push({
                    ...group,
                    isOwner: false,
                    hasAnnouncementPermission: true,
                });
            }
            // Skip groups without permission
        }
    }

    setCache(cacheKey, groupsWithPermissions);
    return groupsWithPermissions;
}

// checkGroupPermission is no longer needed as filtering is done in getUserGroups
