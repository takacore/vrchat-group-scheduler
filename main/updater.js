import { app, shell } from 'electron';
import { readJson, writeJson } from './storage.js';

const GITHUB_OWNER = 'takacore';
const GITHUB_REPO = 'vrchat-group-scheduler';
const RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
const SETTINGS_FILE = 'update-settings.json';

// Dynamic import for node-fetch (ESM)
let fetch;
async function getFetch() {
    if (!fetch) {
        const mod = await import('node-fetch');
        fetch = mod.default;
    }
    return fetch;
}

/**
 * Get current app version from Electron app module
 */
function getCurrentVersion() {
    return app.getVersion();
}

/**
 * Parse semver string into comparable parts
 * Supports: 1.0.0, 1.0.0-beta.1, v1.0.0
 */
function parseSemver(version) {
    const cleaned = version.replace(/^v/, '');
    const [main, prerelease] = cleaned.split('-');
    const [major, minor, patch] = main.split('.').map(Number);
    return { major, minor, patch, prerelease: prerelease || null };
}

/**
 * Compare two semver versions
 * Returns: 1 if a > b, -1 if a < b, 0 if equal
 */
function compareSemver(a, b) {
    const va = parseSemver(a);
    const vb = parseSemver(b);

    if (va.major !== vb.major) return va.major > vb.major ? 1 : -1;
    if (va.minor !== vb.minor) return va.minor > vb.minor ? 1 : -1;
    if (va.patch !== vb.patch) return va.patch > vb.patch ? 1 : -1;

    // No prerelease > has prerelease (1.0.0 > 1.0.0-beta.1)
    if (!va.prerelease && vb.prerelease) return 1;
    if (va.prerelease && !vb.prerelease) return -1;

    // Both have prerelease: compare lexicographically
    if (va.prerelease && vb.prerelease) {
        return va.prerelease.localeCompare(vb.prerelease);
    }

    return 0;
}

/**
 * Get update settings from storage
 */
export async function getUpdateSettings() {
    const defaults = {
        channel: 'stable',  // 'stable' or 'beta'
        autoCheck: true
    };
    const settings = await readJson(SETTINGS_FILE, defaults);
    return { ...defaults, ...settings };
}

/**
 * Save update settings to storage
 */
export async function saveUpdateSettings(settings) {
    const current = await getUpdateSettings();
    const merged = { ...current, ...settings };
    await writeJson(SETTINGS_FILE, merged);
    return merged;
}

/**
 * Check for updates from GitHub Releases
 * @param {string} channel - 'stable' or 'beta'
 * @returns {Object} Update info
 */
export async function checkForUpdates(channel) {
    const fetchFn = await getFetch();
    const currentVersion = getCurrentVersion();

    try {
        const response = await fetchFn(RELEASES_API_URL, {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': `VRChatGroupScheduler/${currentVersion}`
            }
        });

        if (!response.ok) {
            throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
        }

        const releases = await response.json();

        if (!releases || releases.length === 0) {
            return {
                updateAvailable: false,
                currentVersion,
                latestVersion: currentVersion,
                releaseNotes: '',
                downloadUrl: '',
                isBeta: false
            };
        }

        // Filter releases based on channel
        let targetRelease;
        if (channel === 'beta') {
            // Beta channel: include pre-releases, pick the latest one
            targetRelease = releases[0]; // API returns sorted by date desc
        } else {
            // Stable channel: exclude pre-releases
            targetRelease = releases.find(r => !r.prerelease);
        }

        if (!targetRelease) {
            return {
                updateAvailable: false,
                currentVersion,
                latestVersion: currentVersion,
                releaseNotes: '',
                downloadUrl: '',
                isBeta: false
            };
        }

        const latestVersion = targetRelease.tag_name.replace(/^v/, '');
        const updateAvailable = compareSemver(latestVersion, currentVersion) > 0;

        return {
            updateAvailable,
            currentVersion,
            latestVersion,
            releaseNotes: targetRelease.body || '',
            downloadUrl: targetRelease.html_url,
            isBeta: targetRelease.prerelease || false,
            publishedAt: targetRelease.published_at
        };
    } catch (error) {
        console.error('Update check failed:', error);
        throw error;
    }
}

/**
 * Open the download URL in the system browser
 */
export function openDownloadPage(url) {
    if (url) {
        shell.openExternal(url);
    }
}
