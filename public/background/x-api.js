// background/x-api.js
// X(Twitter) posting via browser cookie session.
// Uses the public web bearer token + ct0 (CSRF) cookie from x.com,
// then chunk-uploads media to upload.twitter.com and creates a tweet
// via the GraphQL CreateTweet endpoint.

const X_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const X_API_BASE = 'https://api.x.com';
const X_UPLOAD_BASE = 'https://upload.x.com/i/media/upload.json';
// NOTE: X rotates the CreateTweet GraphQL queryId and its required feature
// flags periodically. When posting suddenly returns 404 (stale queryId) or 400
// "The following features cannot be null: ..." these must be refreshed from the
// live web bundle: fetch https://abs.twimg.com/responsive-web/client-web/main.*.js
// and read the module with operationName:"CreateTweet".
// We also dynamically refresh queryId at runtime (see fetchCreateTweetQueryId)
// so the hard-coded value below is only a fallback when x.com is unreachable.
// Last synced from X's live client: queryId + 36 featureSwitches + 8 fieldToggles.
const CREATE_TWEET_QUERY_ID = 'H-t2v_HvFR07ZBP9aOeKoA';

// Cache for dynamically-fetched queryId. Refreshes from x.com's bundle to
// survive X rotating the value without requiring an extension release.
let cachedQueryId = null;
let cachedQueryIdAt = 0;
const QUERY_ID_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function fetchCreateTweetQueryId() {
    if (cachedQueryId && (Date.now() - cachedQueryIdAt) < QUERY_ID_TTL_MS) {
        return cachedQueryId;
    }
    try {
        const homeRes = await fetch('https://x.com/home', { credentials: 'include' });
        const html = await homeRes.text();
        const scriptUrls = [...html.matchAll(/src=["']([^"']+\.js[^"']*)["']/g)]
            .map(m => m[1])
            .map(u => u.startsWith('http') ? u : (u.startsWith('//') ? 'https:' + u : 'https://x.com' + u));
        for (const url of scriptUrls) {
            try {
                const r = await fetch(url);
                const t = await r.text();
                const idx = t.indexOf('"CreateTweet"');
                if (idx === -1) continue;
                const around = t.slice(Math.max(0, idx - 500), idx + 200);
                const m = around.match(/queryId:\s*["']([A-Za-z0-9_-]+)["']/);
                if (m) {
                    cachedQueryId = m[1];
                    cachedQueryIdAt = Date.now();
                    console.log('[X] CreateTweet queryId refreshed from live bundle');
                    return m[1];
                }
            } catch {}
        }
    } catch (e) {
        console.warn('[X] Failed to refresh queryId from x.com, using hardcoded fallback:', e);
    }
    return cachedQueryId || CREATE_TWEET_QUERY_ID;
}

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
    if (finalizeData.errors?.length) {
        const e = finalizeData.errors[0];
        throw new Error(`X media FINALIZE失敗: ${e.message || JSON.stringify(e)}`);
    }

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

    // X validates that EVERY feature switch declared by the CreateTweet
    // operation is present (non-null). Values don't affect whether the tweet is
    // created, so we mirror the live list and set them all true. Synced from
    // X's client bundle (see note by CREATE_TWEET_QUERY_ID).
    const features = {
        premium_content_api_read_enabled: true,
        communities_web_enable_tweet_community_results_fetch: true,
        c9s_tweet_anatomy_moderator_badge_enabled: true,
        responsive_web_grok_analyze_button_fetch_trends_enabled: true,
        responsive_web_grok_analyze_post_followups_enabled: true,
        rweb_cashtags_composer_attachment_enabled: true,
        responsive_web_jetfuel_frame: true,
        responsive_web_grok_share_attachment_enabled: true,
        responsive_web_grok_annotations_enabled: true,
        responsive_web_edit_tweet_api_enabled: true,
        rweb_conversational_replies_downvote_enabled: true,
        graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
        view_counts_everywhere_api_enabled: true,
        longform_notetweets_consumption_enabled: true,
        responsive_web_twitter_article_tweet_consumption_enabled: true,
        content_disclosure_indicator_enabled: true,
        content_disclosure_ai_generated_indicator_enabled: true,
        responsive_web_grok_show_grok_translated_post: true,
        responsive_web_grok_analysis_button_from_backend: true,
        post_ctas_fetch_enabled: true,
        longform_notetweets_rich_text_read_enabled: true,
        longform_notetweets_inline_media_enabled: true,
        profile_label_improvements_pcf_label_in_post_enabled: true,
        responsive_web_profile_redirect_enabled: true,
        rweb_tipjar_consumption_enabled: true,
        verified_phone_label_enabled: true,
        articles_preview_enabled: true,
        rweb_cashtags_enabled: true,
        responsive_web_grok_community_note_auto_translation_is_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: true,
        freedom_of_speech_not_reach_fetch_enabled: true,
        standardized_nudges_misinfo: true,
        tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
        responsive_web_grok_image_annotation_enabled: true,
        responsive_web_grok_imagine_annotation_enabled: true,
        responsive_web_graphql_timeline_navigation_enabled: true,
    };

    // Newer CreateTweet also requires fieldToggles to be present (non-null).
    // We post plain text/image tweets, so all article/grok toggles are false.
    const fieldToggles = {
        withArticleRichContentState: false,
        withArticlePlainText: false,
        withArticleSummaryText: false,
        withArticleVoiceOver: false,
        withGrokAnalyze: false,
        withDisallowedReplyControls: false,
        withPayments: false,
        withAuxiliaryUserLabels: false,
    };

    const queryId = await fetchCreateTweetQueryId();
    const url = `${X_API_BASE}/graphql/${queryId}/CreateTweet`;
    console.log('[X] CreateTweet POST', { queryIdPrefix: queryId.slice(0, 6) + '...', textLen: text?.length, mediaIds });
    const res = await xFetch(url, {
        method: 'POST',
        body: JSON.stringify({ variables, features, fieldToggles, queryId }),
        headers: { 'content-type': 'application/json' },
    }, csrf);
    const data = await res.json();
    if (data.errors?.length) {
        const e = data.errors[0];
        console.error('[X] CreateTweet response had errors:', data.errors);
        throw new Error(`X CreateTweet失敗 (code ${e.code ?? 'n/a'}): ${e.message || JSON.stringify(e)}`);
    }
    if (!data.data?.create_tweet) {
        console.error('[X] CreateTweet unexpected response shape:', data);
        throw new Error('X CreateTweet失敗: 予期しないレスポンス形式');
    }
    console.log('[X] CreateTweet success');
    return data;
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
