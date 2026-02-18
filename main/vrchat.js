import { readJson, writeJson } from './storage.js';
import fetch from 'node-fetch'; // Electron main usually has native fetch in newer versions, but importing to be safe if environment differs. 
// Actually Electron 34 has global fetch. We can remove import if we want, but let's keep native usage.

const API_BASE = 'https://api.vrchat.cloud/api/1';
const USER_AGENT = 'VRChatGroupScheduler/1.0 (contact: admin@localhost)';
const AUTH_FILE = 'auth.json';

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
        // Simple cookie parser/merger
        const currentAuth = await readJson(AUTH_FILE, {}, { encrypted: true });
        let currentCookies = currentAuth.cookies || '';

        // Split into individual cookies - this basic split might be fragile for complex set-cookie headers but works for basic VRChat auth
        // set-cookie header in node-fetch might be an array or string.
        // In native fetch, headers.get('set-cookie') returns string (first one) or joined? 
        // Actually, for multiple set-cookie headers, we need raw headers or iterate.
        // Electron Main fetch: response.headers is distinct.
        // Let's assume standard behavior.

        let newCookies = [];
        if (typeof setCookie === 'string') {
            // It might be comma separated, but dates also have commas.
            // VRChat cookies are usually simple.
            // Better to use a library like 'set-cookie-parser' if strict, but let's reuse logic for now.
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
        await writeJson(AUTH_FILE, { ...currentAuth, cookies: cookieString }, { encrypted: true });
    }
}

export async function logout() {
    await writeJson(AUTH_FILE, {}, { encrypted: true });
    return true;
}

export async function login(username, password) {
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    const res = await fetch(`${API_BASE}/auth/user`, {
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
    const res = await fetch(`${API_BASE}/auth/twofactorauth/totp/verify`, {
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
    if (!headers.Cookie) return null; // No cookies, definitely not logged in

    const res = await fetch(`${API_BASE}/auth/user`, { headers });
    if (!res.ok) return null;
    return res.json();
}

export async function createGroupPost(groupId, postData) {
    const headers = await getAuthHeaders();
    const res = await fetch(`${API_BASE}/groups/${groupId}/posts`, {
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

async function getGroupRoles(groupId) {
    const headers = await getAuthHeaders();
    const res = await fetch(`${API_BASE}/groups/${groupId}/roles`, { headers });
    if (!res.ok) return [];
    return res.json();
}

export async function getUserGroups(userId) {
    const headers = await getAuthHeaders();
    const res = await fetch(`${API_BASE}/users/${userId}/groups`, { headers });

    if (res.status === 404) return [];

    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error?.message || 'Failed to fetch groups');
    }

    const allGroups = await res.json();

    return allGroups.map(group => ({
        ...group,
        isOwner: group.ownerId === userId
    }));
}

export async function checkGroupPermission(groupId) {
    const headers = await getAuthHeaders();
    const groupRes = await fetch(`${API_BASE}/groups/${groupId}`, { headers });
    if (!groupRes.ok) return false;

    const group = await groupRes.json();
    const myRoleIds = group.myMember?.roleIds || [];
    if (myRoleIds.length === 0) return false;

    const roles = await getGroupRoles(groupId);

    const hasPermission = roles.some(role =>
        myRoleIds.includes(role.id) &&
        (role.permissions.includes('group-announcement-manage') ||
            role.permissions.includes('*'))
    );

    return hasPermission;
}
