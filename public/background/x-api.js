// background/x-api.js
// X(Twitter) posting via browser cookie session.
// Uses the web bearer + ct0 (CSRF) cookie from x.com, chunk-uploads media to
// upload.x.com, and creates a tweet via the GraphQL CreateTweet endpoint.
// The bearer and the CreateTweet operation (queryId + feature/field flags) are
// refreshed at runtime from X's public bundle (fetchXConfig), with baked-in
// fallbacks, because X rotates them periodically.

// The web bearer is NOT hard-coded. It is read at runtime from X's public client
// bundle (fetchXConfig) right before posting. If it can't be obtained we refuse
// to post and surface a clear error rather than embedding a token in source.
let activeBearer = null;
const X_API_BASE = 'https://api.x.com';
const X_UPLOAD_BASE = 'https://upload.x.com/i/media/upload.json';
// X rotates the CreateTweet GraphQL operation periodically. Crucially, the
// queryId and its required `featureSwitches` / `fieldToggles` are a MATCHED SET:
// sending a new queryId with the old feature list (or vice-versa) yields
// 422 GRAPHQL_VALIDATION_FAILED. So we always use them together.
//
// To survive rotation without an extension release we read the WHOLE operation
// (queryId + featureSwitches + fieldToggles) from X's live client bundle at
// runtime (see fetchCreateTweetOp). The baked-in constants below are the
// verified-working fallback used when the bundle is unreachable.
// Last synced from X's live client (operationName:"CreateTweet").
const CREATE_TWEET_QUERY_ID = 'H-t2v_HvFR07ZBP9aOeKoA';

// featureSwitches the operation declares; X only checks they are PRESENT
// (non-null), values don't affect creation, so we send every one as true.
const CREATE_TWEET_FEATURE_NAMES = [
    'premium_content_api_read_enabled',
    'communities_web_enable_tweet_community_results_fetch',
    'c9s_tweet_anatomy_moderator_badge_enabled',
    'responsive_web_grok_analyze_button_fetch_trends_enabled',
    'responsive_web_grok_analyze_post_followups_enabled',
    'rweb_cashtags_composer_attachment_enabled',
    'responsive_web_jetfuel_frame',
    'responsive_web_grok_share_attachment_enabled',
    'responsive_web_grok_annotations_enabled',
    'responsive_web_edit_tweet_api_enabled',
    'rweb_conversational_replies_downvote_enabled',
    'graphql_is_translatable_rweb_tweet_is_translatable_enabled',
    'view_counts_everywhere_api_enabled',
    'longform_notetweets_consumption_enabled',
    'responsive_web_twitter_article_tweet_consumption_enabled',
    'content_disclosure_indicator_enabled',
    'content_disclosure_ai_generated_indicator_enabled',
    'responsive_web_grok_show_grok_translated_post',
    'responsive_web_grok_analysis_button_from_backend',
    'post_ctas_fetch_enabled',
    'longform_notetweets_rich_text_read_enabled',
    'longform_notetweets_inline_media_enabled',
    'profile_label_improvements_pcf_label_in_post_enabled',
    'responsive_web_profile_redirect_enabled',
    'rweb_tipjar_consumption_enabled',
    'verified_phone_label_enabled',
    'articles_preview_enabled',
    'rweb_cashtags_enabled',
    'responsive_web_grok_community_note_auto_translation_is_enabled',
    'responsive_web_graphql_skip_user_profile_image_extensions_enabled',
    'freedom_of_speech_not_reach_fetch_enabled',
    'standardized_nudges_misinfo',
    'tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled',
    'responsive_web_grok_image_annotation_enabled',
    'responsive_web_grok_imagine_annotation_enabled',
    'responsive_web_graphql_timeline_navigation_enabled',
];

// fieldToggles the operation declares. We post plain text/image tweets, so all
// article/grok/payment toggles are false.
const CREATE_TWEET_FIELD_TOGGLE_NAMES = [
    'withArticleRichContentState',
    'withArticlePlainText',
    'withArticleSummaryText',
    'withArticleVoiceOver',
    'withGrokAnalyze',
    'withDisallowedReplyControls',
    'withPayments',
    'withAuxiliaryUserLabels',
];

// X serves its web client JS from this static CDN. We GET it (no credentials,
// no cookie injection) only to read the CreateTweet operation definition.
const X_ASSET_HOST = 'https://abs.twimg.com';

// Runtime cache for the dynamically-resolved client config
// ({ bearer, queryId, featureNames, fieldToggleNames }). The bearer is REQUIRED
// (no hard-coded fallback); queryId/feature flags fall back to baked-in non-secret
// constants only as resilience.
let cachedConfig = null;
let cachedConfigAt = 0;
const CONFIG_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function parseStringArray(s) {
    return s ? [...s.matchAll(/"([^"]+)"/g)].map(m => m[1]) : [];
}

// Read X's live client config (bearer + CreateTweet op) from its public JS
// bundle. The bearer is never hard-coded — it is obtained here at runtime.
// Returns whatever it found ({} if nothing); the caller treats a missing bearer
// as a hard error. We only cache once the bearer is present so a transient
// failure doesn't poison the cache for the whole TTL.
async function fetchXConfig() {
    if (cachedConfig?.bearer && (Date.now() - cachedConfigAt) < CONFIG_TTL_MS) {
        return cachedConfig;
    }
    const out = {};
    try {
        const homeRes = await fetch('https://x.com/home', { credentials: 'omit' });
        const html = await homeRes.text();
        // Include both src= and href= (preload links) so we don't miss the
        // bundle that carries the bearer. Only X's own static CDN is scanned.
        const bundleUrls = [...new Set(
            [...html.matchAll(/(?:src|href)=["']([^"']+\.js[^"']*)["']/g)]
                .map(m => { try { return new URL(m[1], 'https://x.com').href; } catch { return null; } })
                .filter(Boolean)
                .filter(u => u.startsWith(X_ASSET_HOST + '/'))
        )];

        for (const url of bundleUrls) {
            if (out.bearer && out.queryId) break; // got everything
            let t;
            try { t = await (await fetch(url, { credentials: 'omit' })).text(); }
            catch { continue; }

            // Bearer: longest "AAAA…"-prefixed literal in the bundle.
            if (!out.bearer) {
                let best = null;
                for (const m of t.matchAll(/(AAAAAAAA[A-Za-z0-9%]{40,})/g)) {
                    if (!best || m[1].length > best.length) best = m[1];
                }
                if (best) out.bearer = best;
            }

            // CreateTweet op: anchor on the operation NAME (not a stray
            // "CreateTweet" substring) so we don't grab a neighbour's queryId.
            if (!out.queryId) {
                const opIdx = t.indexOf('operationName:"CreateTweet"');
                if (opIdx !== -1) {
                    const before = t.slice(Math.max(0, opIdx - 160), opIdx);
                    const qid = (before.match(/queryId:"([A-Za-z0-9_-]+)"[^"]*$/) || [])[1];
                    const after = t.slice(opIdx, opIdx + 6000);
                    const features = parseStringArray((after.match(/featureSwitches:\[([^\]]*)\]/) || [])[1]);
                    const toggles = parseStringArray((after.match(/fieldToggles:\[([^\]]*)\]/) || [])[1]);
                    if (qid && features.length) {
                        out.queryId = qid;
                        out.featureNames = features;
                        out.fieldToggleNames = toggles;
                    }
                }
            }
        }
    } catch (e) {
        console.warn('[X] live config fetch failed:', e?.message || e);
    }

    // Only cache a result that has the (required) bearer; otherwise let the next
    // post retry instead of being stuck on an empty config for the whole TTL.
    if (out.bearer) {
        cachedConfig = out;
        cachedConfigAt = Date.now();
    }
    console.log('[X] config resolved', {
        bearer: out.bearer ? 'live' : 'MISSING',
        queryId: out.queryId ? 'live' : 'baked-in',
        featureCount: out.featureNames?.length ?? CREATE_TWEET_FEATURE_NAMES.length,
    });
    return out;
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
                // 実際に叩くのは api.x.com / upload.x.com のみ。bare 'x.com' を外し、
                // 並行する正規 x.com タブのXHRをヘッダ上書きで巻き込む範囲を減らす。
                requestDomains: ['api.x.com', 'upload.x.com'],
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

// MV3 の session rule は SW が finally 到達前に停止(タイムアウト/クラッシュ/リロード)すると
// 残存し得る。起動/インストール時に確実に掃除するため、background から呼べるよう公開する。
export async function clearXHeaderRule() {
    await uninstallHeaderRule();
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
        // activeBearer is read from X's live bundle per post (fetchXConfig).
        // post() guarantees it is set before any request reaches here.
        'authorization': `Bearer ${activeBearer}`,
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
        // Make auth failures actionable instead of a bare status.
        if (res.status === 401 || res.status === 403) {
            throw new Error(`X API ${res.status}: 認証に失敗しました（Xのログイン切れ、またはbearer/トークンの失効の可能性）。${text.slice(0, 160)}`);
        }
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

async function createTweet(text, mediaIds, csrf, cfg) {
    const variables = {
        tweet_text: text,
        dark_request: false,
        media: {
            media_entities: (mediaIds || []).map(id => ({ media_id: id, tagged_users: [] })),
            possibly_sensitive: false,
        },
        semantic_annotation_ids: [],
    };

    // Use the CreateTweet operation as a MATCHED SET (queryId + the exact
    // featureSwitches + fieldToggles it declares). cfg comes from the live bundle;
    // any missing field falls back to the baked-in constant. Mixing a live queryId
    // with stale feature names is what produces 422 GRAPHQL_VALIDATION_FAILED — so
    // when cfg has a live queryId we ALSO use its live feature/toggle lists.
    const usingLiveOp = !!(cfg && cfg.queryId);
    const queryId = cfg?.queryId || CREATE_TWEET_QUERY_ID;
    const featureNames = cfg?.featureNames?.length ? cfg.featureNames : CREATE_TWEET_FEATURE_NAMES;
    const fieldToggleNames = cfg?.fieldToggleNames?.length ? cfg.fieldToggleNames : CREATE_TWEET_FIELD_TOGGLE_NAMES;

    // X only checks these are present (non-null); values don't affect creation.
    const features = Object.fromEntries(featureNames.map(n => [n, true]));
    // We post plain text/image tweets → all article/grok/payment toggles false.
    const fieldToggles = Object.fromEntries(fieldToggleNames.map(n => [n, false]));

    const url = `${X_API_BASE}/graphql/${queryId}/CreateTweet`;
    console.log('[X] CreateTweet POST', {
        queryIdPrefix: queryId.slice(0, 6) + '...',
        opSource: usingLiveOp ? 'live-bundle' : 'baked-in',
        featureCount: featureNames.length,
        textLen: text?.length,
        mediaCount: (mediaIds || []).length,
    });
    const res = await xFetch(url, {
        method: 'POST',
        body: JSON.stringify({ variables, features, fieldToggles, queryId }),
        headers: { 'content-type': 'application/json' },
    }, csrf);
    const data = await res.json();
    // X returns HTTP 200 even when the operation fails — the failure is reported
    // in body.errors[]. Surface it as a thrown error so callers don't treat a
    // failed post as success (the cause of the "silent X skip" symptom).
    if (data.errors?.length) {
        const e = data.errors[0];
        console.error('[X] CreateTweet returned errors:', data.errors);
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
        console.log('[X] xApi.post called', { textLen: text?.length, hasImage: !!imageDataUrl });
        const csrf = await getCsrfToken();
        await getAuthToken();

        // Resolve live client config (bearer + CreateTweet op) BEFORE installing
        // the header rule / uploading media, so the bearer is ready for every
        // request in this post. The bearer is mandatory and never hard-coded: if
        // we can't read it from X's bundle, refuse to post with a clear error.
        const cfg = await fetchXConfig();
        if (!cfg.bearer) {
            throw new Error('X の認証トークン(bearer)を取得できませんでした。x.com に接続できるか、ログイン状態を確認してください。');
        }
        activeBearer = cfg.bearer;

        return withXHeaders(async () => {
            const mediaIds = [];
            if (imageDataUrl) {
                const fetchRes = await fetch(imageDataUrl);
                const blob = await fetchRes.blob();
                const mimeType = blob.type || 'image/png';
                console.log('[X] uploading media', { size: blob.size, mimeType });
                const mediaId = await uploadMediaChunked(blob, mimeType, csrf);
                console.log('[X] media uploaded', { mediaId });
                mediaIds.push(mediaId);
            }

            return createTweet(text || '', mediaIds, csrf, cfg);
        });
    },
};
