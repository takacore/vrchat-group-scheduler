import { readJson, writeJson } from './storage.js';
import fetch from 'node-fetch';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const API_BASE = 'https://api.vrchat.cloud/api/1';
const USER_AGENT = `VRChatGroupScheduler/${pkg.version} ai.takacore@gmail.com`;
const AUTH_FILE = 'auth.json';
const GROUP_CACHE_FILE = 'group-permissions.json';

// --- Rate Limiter & Backoff ---
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 200; // 200ms minimum between requests

async function apiRequest(url, options = {}) {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL) {
        await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - elapsed));
    }
    lastRequestTime = Date.now();

    const maxRetries = 3;
    let backoff = 2000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const res = await fetch(url, options);

        if (res.status === 429) {
            if (attempt < maxRetries) {
                console.warn(`[VRChat API] Rate limited (429). Retrying in ${backoff / 1000}s... (attempt ${attempt + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, backoff));
                backoff = Math.min(backoff * 2, 30000);
                continue;
            }
            console.error('[VRChat API] Rate limited after max retries.');
        }

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

// --- In-Memory Cache (for roles/group details within a session) ---
const memCache = new Map();
const MEM_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getMemCached(key) {
    const entry = memCache.get(key);
    if (entry && Date.now() - entry.timestamp < MEM_CACHE_TTL) {
        return entry.data;
    }
    memCache.delete(key);
    return null;
}

function setMemCache(key, data) {
    memCache.set(key, { data, timestamp: Date.now() });
}

// --- Persistent Group Permission Cache ---
const GROUP_CACHE_TTL = 30 * 60 * 1000; // 30 minutes before auto-refresh
const REFRESH_COOLDOWN = 5 * 60 * 1000; // 5 minutes cooldown for manual refresh

async function loadGroupCache() {
    return await readJson(GROUP_CACHE_FILE, { lastFullCheck: null, lastRefresh: null, groups: {} });
}

async function saveGroupCache(cache) {
    await writeJson(GROUP_CACHE_FILE, cache);
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
        currentCookies.split(';').forEach(c => {
            const [k, v] = c.split('=').map(s => s.trim());
            if (k) cookieMap.set(k, v);
        });
        newCookies.forEach(c => {
            const [k, v] = c.split('=').map(s => s.trim());
            if (k) cookieMap.set(k, v);
        });

        const cookieString = Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
        await writeJson(AUTH_FILE, { ...currentAuth, cookies: cookieString }, { encrypted: true });
    }
}

// --- Auth API ---
export async function logout() {
    memCache.clear();
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
    if (!res.ok) throw new Error(data.error?.message || 'Login failed');
    return data;
}

export async function verify2FA(code) {
    const headers = await getAuthHeaders();
    const res = await apiRequest(`${API_BASE}/auth/twofactorauth/totp/verify`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
    });

    await saveCookies(res);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || '2FA verification failed');
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
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(postData)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Failed to create post');
    return data;
}

// --- Group Roles & Permissions ---
async function getGroupRoles(groupId) {
    const cacheKey = `roles:${groupId}`;
    const cached = getMemCached(cacheKey);
    if (cached) return cached;

    const headers = await getAuthHeaders();
    const res = await apiRequest(`${API_BASE}/groups/${groupId}/roles`, { headers });
    if (!res.ok) return [];
    const roles = await res.json();

    setMemCache(cacheKey, roles);
    return roles;
}

async function getGroupDetail(groupId) {
    const cacheKey = `group:${groupId}`;
    const cached = getMemCached(cacheKey);
    if (cached) return cached;

    const headers = await getAuthHeaders();
    const res = await apiRequest(`${API_BASE}/groups/${groupId}`, { headers });
    if (!res.ok) return null;
    const group = await res.json();

    setMemCache(cacheKey, group);
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

// --- Main Group Fetching with Persistent Cache ---

async function fetchAllGroupsFromAPI(userId) {
    const headers = await getAuthHeaders();
    const res = await apiRequest(`${API_BASE}/users/${userId}/groups`, { headers });
    if (res.status === 404) return [];
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error?.message || 'Failed to fetch groups');
    }
    return await res.json();
}

async function checkAndCachePermissions(allGroups, userId, existingCache) {
    const now = new Date().toISOString();
    const updatedGroups = { ...existingCache.groups };

    for (const group of allGroups) {
        const gid = group.groupId;
        const isOwner = group.ownerId === userId;

        if (isOwner) {
            updatedGroups[gid] = {
                name: group.name,
                shortCode: group.shortCode,
                isOwner: true,
                hasPermission: true,
                checkedAt: now,
                groupData: group,
            };
            console.log(`[VRChat API] Group "${group.name}" - Owner ★`);
        } else {
            // Check if we already have a cached result for this group
            const cached = existingCache.groups[gid];
            if (cached && cached.checkedAt) {
                // Use cached result - don't re-check
                updatedGroups[gid] = { ...cached, groupData: group, name: group.name, shortCode: group.shortCode };
                continue;
            }

            // New group - need to check permission
            try {
                const hasPermission = await checkAnnouncementPermission(gid);
                updatedGroups[gid] = {
                    name: group.name,
                    shortCode: group.shortCode,
                    isOwner: false,
                    hasPermission,
                    checkedAt: now,
                    groupData: group,
                };
                if (hasPermission) {
                    console.log(`[VRChat API] Group "${group.name}" - Has announcement permission ◆`);
                }
            } catch (err) {
                console.warn(`[VRChat API] Permission check failed for "${group.name}": ${err.message}`);
                updatedGroups[gid] = {
                    name: group.name,
                    shortCode: group.shortCode,
                    isOwner: false,
                    hasPermission: false,
                    checkedAt: now,
                    groupData: group,
                    error: err.message,
                };
            }
        }
    }

    return updatedGroups;
}

async function forceCheckAllPermissions(allGroups, userId, onProgress = null) {
    const now = new Date().toISOString();
    const updatedGroups = {};
    const total = allGroups.length;

    console.log(`[VRChat API] Force refreshing permissions for ${total} groups...`);

    for (let i = 0; i < allGroups.length; i++) {
        const group = allGroups[i];
        const gid = group.groupId;
        const isOwner = group.ownerId === userId;

        if (onProgress) {
            onProgress({ current: i + 1, total, groupName: group.name, phase: 'checking' });
        }

        if (isOwner) {
            updatedGroups[gid] = {
                name: group.name,
                shortCode: group.shortCode,
                isOwner: true,
                hasPermission: true,
                checkedAt: now,
                groupData: group,
            };
            console.log(`[VRChat API] Group "${group.name}" - Owner ★`);
        } else {
            try {
                const hasPermission = await checkAnnouncementPermission(gid);
                updatedGroups[gid] = {
                    name: group.name,
                    shortCode: group.shortCode,
                    isOwner: false,
                    hasPermission,
                    checkedAt: now,
                    groupData: group,
                };
                if (hasPermission) {
                    console.log(`[VRChat API] Group "${group.name}" - Has announcement permission ◆`);
                }
            } catch (err) {
                console.warn(`[VRChat API] Permission check failed for "${group.name}": ${err.message}`);
                updatedGroups[gid] = {
                    name: group.name,
                    shortCode: group.shortCode,
                    isOwner: false,
                    hasPermission: false,
                    checkedAt: now,
                    groupData: group,
                };
            }
        }
    }

    if (onProgress) {
        onProgress({ current: total, total, groupName: '', phase: 'done' });
    }

    return updatedGroups;
}

function buildFilteredGroupList(groupsCache) {
    return Object.entries(groupsCache)
        .filter(([_, info]) => info.hasPermission)
        .map(([gid, info]) => ({
            ...info.groupData,
            groupId: gid,
            isOwner: info.isOwner,
            hasAnnouncementPermission: true,
        }));
}

export async function getUserGroups(userId) {
    const cache = await loadGroupCache();
    const now = Date.now();

    // Case 1: Cache exists and is fresh (< 30 minutes) → return from cache
    if (cache.lastFullCheck) {
        const cacheAge = now - new Date(cache.lastFullCheck).getTime();
        if (cacheAge < GROUP_CACHE_TTL && Object.keys(cache.groups).length > 0) {
            console.log(`[VRChat API] Using cached group permissions (age: ${Math.round(cacheAge / 1000)}s)`);
            return { groups: buildFilteredGroupList(cache.groups), needsScan: false };
        }
    }

    // Case 2: No cache at all → return empty + needsScan flag (initial setup)
    if (!cache.lastFullCheck || Object.keys(cache.groups).length === 0) {
        console.log(`[VRChat API] No group cache found. Scan required.`);
        return { groups: [], needsScan: true };
    }

    // Case 3: Cache expired → smart permission check (use cached results where available)
    console.log(`[VRChat API] Cache expired. Fetching groups for user ${userId}...`);
    const allGroups = await fetchAllGroupsFromAPI(userId);
    console.log(`[VRChat API] Found ${allGroups.length} groups. Smart-checking permissions...`);

    const updatedGroups = await checkAndCachePermissions(allGroups, userId, cache);

    const newCache = {
        lastFullCheck: new Date().toISOString(),
        lastRefresh: cache.lastRefresh,
        groups: updatedGroups,
    };
    await saveGroupCache(newCache);

    const result = buildFilteredGroupList(updatedGroups);
    console.log(`[VRChat API] Filtered: ${result.length}/${allGroups.length} groups have posting permission.`);
    return { groups: result, needsScan: false };
}

export async function refreshUserGroups(userId, onProgress = null) {
    const cache = await loadGroupCache();
    const now = Date.now();

    // Check cooldown
    if (cache.lastRefresh) {
        const cooldownRemaining = REFRESH_COOLDOWN - (now - new Date(cache.lastRefresh).getTime());
        if (cooldownRemaining > 0) {
            return {
                groups: buildFilteredGroupList(cache.groups),
                cooldownRemaining: Math.ceil(cooldownRemaining / 1000),
                refreshed: false,
            };
        }
    }

    // Force refresh - re-fetch all groups and re-check ALL permissions
    console.log(`[VRChat API] Manual refresh triggered. Fetching all groups...`);
    if (onProgress) onProgress({ current: 0, total: 0, groupName: '', phase: 'fetching' });
    const allGroups = await fetchAllGroupsFromAPI(userId);
    const updatedGroups = await forceCheckAllPermissions(allGroups, userId, onProgress);

    const newCache = {
        lastFullCheck: new Date().toISOString(),
        lastRefresh: new Date().toISOString(),
        groups: updatedGroups,
    };
    await saveGroupCache(newCache);

    const result = buildFilteredGroupList(updatedGroups);
    console.log(`[VRChat API] Refresh complete: ${result.length}/${allGroups.length} groups have posting permission.`);

    return {
        groups: result,
        cooldownRemaining: 0,
        refreshed: true,
    };
}
