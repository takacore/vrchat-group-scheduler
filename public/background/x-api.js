// background/x-api.js
// X(Twitter) posting via browser cookie session.
// Uses the public web bearer token + ct0 (CSRF) cookie from x.com,
// then chunk-uploads media to upload.twitter.com and creates a tweet
// via the GraphQL CreateTweet endpoint.

const X_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const X_API_BASE = 'https://api.x.com';
const X_UPLOAD_BASE = 'https://upload.x.com/i/media/upload.json';
const CREATE_TWEET_QUERY_ID = 'oB-5XsHNAbjvARJEc8CZFw';

async function getCsrfToken() {
    return new Promise((resolve, reject) => {
        chrome.cookies.get({ url: 'https://x.com', name: 'ct0' }, (cookie) => {
            if (cookie?.value) return resolve(cookie.value);
            chrome.cookies.get({ url: 'https://twitter.com', name: 'ct0' }, (cookie2) => {
                if (cookie2?.value) return resolve(cookie2.value);
                reject(new Error('X(Twitter)のログインCookie(ct0)が見つかりません。ブラウザでログインしてください。'));
            });
        });
    });
}

async function getAuthToken() {
    return new Promise((resolve, reject) => {
        chrome.cookies.get({ url: 'https://x.com', name: 'auth_token' }, (cookie) => {
            if (cookie?.value) return resolve(cookie.value);
            chrome.cookies.get({ url: 'https://twitter.com', name: 'auth_token' }, (cookie2) => {
                if (cookie2?.value) return resolve(cookie2.value);
                reject(new Error('X(Twitter)にログインしていません。'));
            });
        });
    });
}

// Read all relevant cookies and build a Cookie header value.
// SameSite=Lax cookies aren't sent on cross-site POST from extension SW, so we
// inject them via declarativeNetRequest header rules.
async function buildCookieHeader() {
    const fromX = await new Promise(r => chrome.cookies.getAll({ domain: '.x.com' }, c => r(c || [])));
    const fromTwitter = await new Promise(r => chrome.cookies.getAll({ domain: '.twitter.com' }, c => r(c || [])));
    const seen = new Set();
    const parts = [];
    for (const c of [...fromX, ...fromTwitter]) {
        if (seen.has(c.name)) continue;
        seen.add(c.name);
        parts.push(`${c.name}=${c.value}`);
    }
    return parts.join('; ');
}

const HEADER_RULE_ID = 1009;

async function installHeaderRule() {
    const cookieValue = await buildCookieHeader();
    if (!cookieValue) throw new Error('X(Twitter)のCookieが取得できません。ログイン状態を確認してください。');

    await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [HEADER_RULE_ID],
        addRules: [{
            id: HEADER_RULE_ID,
            priority: 1,
            action: {
                type: 'modifyHeaders',
                requestHeaders: [
                    { header: 'cookie', operation: 'set', value: cookieValue },
                    { header: 'origin', operation: 'set', value: 'https://x.com' },
                    { header: 'referer', operation: 'set', value: 'https://x.com/home' },
                ],
            },
            condition: {
                requestDomains: ['api.x.com', 'upload.x.com', 'x.com'],
                resourceTypes: ['xmlhttprequest'],
            },
        }],
    });
}

async function uninstallHeaderRule() {
    try {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [HEADER_RULE_ID] });
    } catch (e) {
        console.warn('Failed to remove X header rule:', e);
    }
}

async function withXHeaders(fn) {
    await installHeaderRule();
    try {
        return await fn();
    } finally {
        await uninstallHeaderRule();
    }
}

function baseHeaders(csrf) {
    return {
        'authorization': `Bearer ${X_BEARER}`,
        'x-csrf-token': csrf,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'ja',
    };
}

async function xFetch(url, options, csrf) {
    const res = await fetch(url, {
        ...options,
        credentials: 'include',
        headers: {
            ...baseHeaders(csrf),
            ...(options.headers || {}),
        },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`X API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res;
}

async function uploadMediaChunked(blob, mimeType, csrf) {
    const totalBytes = blob.size;

    // INIT
    const initForm = new URLSearchParams();
    initForm.append('command', 'INIT');
    initForm.append('total_bytes', String(totalBytes));
    initForm.append('media_type', mimeType);
    initForm.append('media_category', 'tweet_image');

    const initRes = await xFetch(X_UPLOAD_BASE, {
        method: 'POST',
        body: initForm,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }, csrf);
    const initData = await initRes.json();
    const mediaId = initData.media_id_string;
    if (!mediaId) throw new Error('X media INIT failed: no media_id');

    // APPEND (single chunk for simplicity; X allows up to ~5MB per chunk)
    const CHUNK = 4 * 1024 * 1024;
    let segment = 0;
    for (let offset = 0; offset < totalBytes; offset += CHUNK) {
        const slice = blob.slice(offset, Math.min(offset + CHUNK, totalBytes));
        const form = new FormData();
        form.append('command', 'APPEND');
        form.append('media_id', mediaId);
        form.append('segment_index', String(segment));
        form.append('media', slice);
        await xFetch(X_UPLOAD_BASE, { method: 'POST', body: form }, csrf);
        segment++;
    }

    // FINALIZE
    const finalizeForm = new URLSearchParams();
    finalizeForm.append('command', 'FINALIZE');
    finalizeForm.append('media_id', mediaId);
    const finalizeRes = await xFetch(X_UPLOAD_BASE, {
        method: 'POST',
        body: finalizeForm,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }, csrf);
    const finalizeData = await finalizeRes.json();

    // STATUS polling if processing
    if (finalizeData.processing_info) {
        let info = finalizeData.processing_info;
        while (info && (info.state === 'pending' || info.state === 'in_progress')) {
            await new Promise(r => setTimeout(r, (info.check_after_secs || 1) * 1000));
            const statusUrl = `${X_UPLOAD_BASE}?command=STATUS&media_id=${mediaId}`;
            const statusRes = await xFetch(statusUrl, { method: 'GET' }, csrf);
            const statusData = await statusRes.json();
            info = statusData.processing_info;
            if (info?.state === 'failed') {
                throw new Error(`X media processing failed: ${info.error?.message || 'unknown'}`);
            }
        }
    }

    return mediaId;
}

async function createTweet(text, mediaIds, csrf) {
    const variables = {
        tweet_text: text,
        dark_request: false,
        media: {
            media_entities: (mediaIds || []).map(id => ({ media_id: id, tagged_users: [] })),
            possibly_sensitive: false,
        },
        semantic_annotation_ids: [],
    };

    const features = {
        communities_web_enable_tweet_community_results_fetch: true,
        c9s_tweet_anatomy_moderator_badge_enabled: true,
        responsive_web_grok_analyze_button_fetch_trends_enabled: false,
        responsive_web_grok_analyze_post_followups_enabled: true,
        responsive_web_jetfuel_frame: false,
        responsive_web_grok_share_attachment_enabled: true,
        responsive_web_edit_tweet_api_enabled: true,
        graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
        view_counts_everywhere_api_enabled: true,
        longform_notetweets_consumption_enabled: true,
        responsive_web_twitter_article_tweet_consumption_enabled: true,
        tweet_awards_web_tipping_enabled: false,
        creator_subscriptions_quote_tweet_preview_enabled: false,
        longform_notetweets_rich_text_read_enabled: true,
        longform_notetweets_inline_media_enabled: true,
        profile_label_improvements_pcf_label_in_post_enabled: true,
        rweb_tipjar_consumption_enabled: true,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        articles_preview_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        responsive_web_graphql_timeline_navigation_enabled: true,
        responsive_web_enhance_cards_enabled: false,
        standardized_nudges_misinfo: true,
        tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
        rweb_video_timestamps_enabled: true,
        freedom_of_speech_not_reach_fetch_enabled: true,
    };

    const url = `${X_API_BASE}/graphql/${CREATE_TWEET_QUERY_ID}/CreateTweet`;
    const res = await xFetch(url, {
        method: 'POST',
        body: JSON.stringify({ variables, features, queryId: CREATE_TWEET_QUERY_ID }),
        headers: { 'content-type': 'application/json' },
    }, csrf);
    return res.json();
}

export const xApi = {
    async checkLogin() {
        try {
            await getAuthToken();
            await getCsrfToken();
            return true;
        } catch {
            return false;
        }
    },

    async post(text, imageDataUrl = null) {
        const csrf = await getCsrfToken();
        await getAuthToken();

        return withXHeaders(async () => {
            const mediaIds = [];
            if (imageDataUrl) {
                const fetchRes = await fetch(imageDataUrl);
                const blob = await fetchRes.blob();
                const mimeType = blob.type || 'image/png';
                const mediaId = await uploadMediaChunked(blob, mimeType, csrf);
                mediaIds.push(mediaId);
            }

            return createTweet(text || '', mediaIds, csrf);
        });
    },
};
