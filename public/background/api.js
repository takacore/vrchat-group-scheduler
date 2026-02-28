import { storage } from './storage.js';

const VRC_API_URL = 'https://vrchat.com/api/1';
const MIN_REQUEST_INTERVAL = 500; // 500ms minimum between requests

let lastRequestTime = 0;

async function apiRequest(endpoint, options = {}) {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL) {
        await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - elapsed));
    }
    lastRequestTime = Date.now();

    const url = `${VRC_API_URL}${endpoint}`;
    const maxRetries = 3;
    let backoff = 2000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const res = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers,
            },
            credentials: 'include',
        });

        if (res.status === 401) {
            throw new Error('Unauthorized');
        }

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

        if (!res.ok && res.status !== 404) {
            const errorData = await res.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `API Error: ${res.status}`);
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

async function loadGroupCache(userId) {
    const key = `group-permissions-${userId}`;
    const data = await storage.get([key]);
    return data[key] || { lastFullCheck: null, lastRefresh: null, groups: {} };
}

async function saveGroupCache(userId, cacheObj) {
    const key = `group-permissions-${userId}`;
    await storage.set({ [key]: cacheObj });
}

async function getGroupRoles(groupId) {
    const cacheKey = `roles:${groupId}`;
    const cached = getMemCached(cacheKey);
    if (cached) return cached;

    const res = await apiRequest(`/groups/${groupId}/roles`);
    if (!res.ok) return [];
    const roles = await res.json();

    setMemCache(cacheKey, roles);
    return roles;
}

async function getGroupDetail(groupId) {
    const cacheKey = `group:${groupId}`;
    const cached = getMemCached(cacheKey);
    if (cached) return cached;

    const res = await apiRequest(`/groups/${groupId}`);
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

async function fetchAllGroupsFromAPI(userId) {
    const res = await apiRequest(`/users/${userId}/groups`);
    if (res.status === 404) return [];
    return await res.json();
}

async function checkAndCachePermissions(allGroups, userId, existingCache) {
    const now = new Date().toISOString();
    const updatedGroups = { ...existingCache.groups };
    const total = allGroups.length;
    let current = 0;

    for (const group of allGroups) {
        current++;
        chrome.runtime.sendMessage({
            type: 'SCAN_PROGRESS',
            payload: { current, total, groupName: group.name, phase: 'fetching' }
        }).catch(() => { });

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
            const cached = existingCache.groups[gid];
            if (cached && cached.checkedAt) {
                updatedGroups[gid] = { ...cached, groupData: group, name: group.name, shortCode: group.shortCode };
                continue;
            }

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
                console.warn(`[VRChat API] Permission check failed for "${group.name}":`, err);
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

async function forceCheckAllPermissions(allGroups, userId) {
    const now = new Date().toISOString();
    const updatedGroups = {};
    const total = allGroups.length;

    console.log(`[VRChat API] Force refreshing permissions for ${total} groups...`);
    let current = 0;

    for (let i = 0; i < allGroups.length; i++) {
        const group = allGroups[i];
        current++;
        chrome.runtime.sendMessage({
            type: 'SCAN_PROGRESS',
            payload: { current, total, groupName: group.name, phase: 'fetching' }
        }).catch(() => { });

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
                console.warn(`[VRChat API] Permission check failed for "${group.name}":`, err);
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


export const api = {
    async getAuth() {
        const res = await apiRequest('/auth/user');
        return res.json();
    },

    async getUserGroups(userId) {
        const cache = await loadGroupCache(userId);
        const now = Date.now();

        if (cache.lastFullCheck) {
            const cacheAge = now - new Date(cache.lastFullCheck).getTime();
            if (cacheAge < GROUP_CACHE_TTL && Object.keys(cache.groups).length > 0) {
                console.log(`[VRChat API] Using cached group permissions (age: ${Math.round(cacheAge / 1000)}s)`);
                return { groups: buildFilteredGroupList(cache.groups), needsScan: false };
            }
        }

        if (!cache.lastFullCheck || Object.keys(cache.groups).length === 0) {
            console.log(`[VRChat API] No group cache found. Scan required.`);
            return { groups: [], needsScan: true };
        }

        console.log(`[VRChat API] Cache expired. Fetching groups for user ${userId}...`);
        const allGroups = await fetchAllGroupsFromAPI(userId);
        console.log(`[VRChat API] Found ${allGroups.length} groups. Smart-checking permissions...`);

        const updatedGroups = await checkAndCachePermissions(allGroups, userId, cache);

        const newCache = {
            lastFullCheck: new Date().toISOString(),
            lastRefresh: cache.lastRefresh,
            groups: updatedGroups,
        };
        await saveGroupCache(userId, newCache);

        const result = buildFilteredGroupList(updatedGroups);
        console.log(`[VRChat API] Filtered: ${result.length}/${allGroups.length} groups have posting permission.`);
        return { groups: result, needsScan: false };
    },

    async refreshUserGroups(userId) {
        const cache = await loadGroupCache(userId);
        const now = Date.now();

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

        console.log(`[VRChat API] Manual refresh triggered. Fetching all groups...`);
        const allGroups = await fetchAllGroupsFromAPI(userId);
        const updatedGroups = await forceCheckAllPermissions(allGroups, userId);

        const newCache = {
            lastFullCheck: new Date().toISOString(),
            lastRefresh: new Date().toISOString(),
            groups: updatedGroups,
        };
        await saveGroupCache(userId, newCache);

        const result = buildFilteredGroupList(updatedGroups);
        console.log(`[VRChat API] Refresh complete: ${result.length}/${allGroups.length} groups have posting permission.`);

        return {
            groups: result,
            cooldownRemaining: 0,
            refreshed: true,
        };
    },

    async getGroup(groupId) {
        return getGroupDetail(groupId);
    },

    async createGroupPost(groupId, title, text, sendNotification = false) {
        const res = await apiRequest(`/groups/${groupId}/posts`, {
            method: 'POST',
            body: JSON.stringify({ title, text, sendNotification })
        });
        return res.json();
    }
};
