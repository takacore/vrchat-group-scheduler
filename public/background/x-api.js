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

// Serialize all X posts. The shared declarativeNetRequest rule (HEADER_RULE_ID)
// and the module-level activeBearer mean two concurrent posts (e.g. several
// recurring posts firing in the same minute) would stomp each other's auth
// headers and fail with 401/403. Chain posts so only one runs at a time.
let _xPostChain = Promise.resolve();
function runSerialized(fn) {
    const result = _xPostChain.then(fn, fn);
    _xPostChain = result.then(() => {}, () => {});
    return result;
}

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
        // Code 226 = X anti-automation. The request authenticated and validated
        // fine; X blocked it because the拡張機能 cannot attach the per-request
        // `x-client-transaction-id` header that X's own web client computes in the
        // page. (VRChat投稿は成功しているので status は partial 扱い。)
        if (e.code === 226) {
            throw new Error('X側の自動化対策でブロックされました (code 226)。Xが要求する x-client-transaction-id ヘッダを拡張機能から付与できていないためです。VRChat投稿は成功しています。X投稿の恒久対応は方針検討中です。');
        }
        throw new Error(`X CreateTweet失敗 (code ${e.code ?? 'n/a'}): ${e.message || JSON.stringify(e)}`);
    }
    if (!data.data?.create_tweet) {
        console.error('[X] CreateTweet unexpected response shape:', data);
        throw new Error('X CreateTweet失敗: 予期しないレスポンス形式');
    }
    console.log('[X] CreateTweet success');
    return data;
}

// ---------------------------------------------------------------------------
// X anti-automation (code 226) bypass via the page's own fetch.
//
// X wraps window.fetch in its web bundle and attaches a per-request
// `x-client-transaction-id` header that the extension's Service Worker (native
// fetch) cannot compute. Posting straight from the SW therefore gets 226.
//
// Fix: run the post FROM an x.com page (MAIN world) so X's wrapped fetch adds the
// header for us. We reuse an open x.com tab when present, otherwise open a
// transient background tab and close it afterwards — so scheduled posts work even
// when the user has no x.com tab open.
// ---------------------------------------------------------------------------

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function findXTab() {
    try {
        const tabs = await chrome.tabs.query({ url: 'https://x.com/*' });
        return tabs.find(t => t.status === 'complete') || tabs[0] || null;
    } catch {
        return null;
    }
}

function waitTabComplete(tabId, timeoutMs = 20000) {
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return; done = true;
            try { chrome.tabs.onUpdated.removeListener(listener); } catch { }
            resolve();
        };
        const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
        try { chrome.tabs.onUpdated.addListener(listener); } catch { }
        setTimeout(finish, timeoutMs);
    });
}

// Runs in the x.com page MAIN world. window.fetch here is X's wrapped fetch,
// which attaches x-client-transaction-id. Fully self-contained (executeScript
// stringifies it — no closures over module scope). Returns a serializable result.
async function xRelayInjected(payload) {
    try {
        const { text, imageDataUrl, bearer, csrf, queryId, features, fieldToggles, lang } = payload;
        const UP = 'https://upload.x.com/i/media/upload.json';
        const base = {
            'authorization': 'Bearer ' + bearer,
            'x-csrf-token': csrf,
            'x-twitter-auth-type': 'OAuth2Session',
            'x-twitter-active-user': 'yes',
            'x-twitter-client-language': lang || 'en',
        };
        const mediaIds = [];
        if (imageDataUrl) {
            const blob = await (await fetch(imageDataUrl)).blob();
            const init = await fetch(UP, {
                method: 'POST', credentials: 'include',
                headers: { ...base, 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ command: 'INIT', total_bytes: String(blob.size), media_type: blob.type || 'image/png', media_category: 'tweet_image' }),
            });
            if (!init.ok) return { ok: false, error: 'media INIT ' + init.status + ': ' + (await init.text()).slice(0, 150) };
            const mediaId = (await init.json()).media_id_string;
            const fd = new FormData();
            fd.append('command', 'APPEND'); fd.append('media_id', mediaId); fd.append('segment_index', '0'); fd.append('media', blob);
            const ap = await fetch(UP, { method: 'POST', credentials: 'include', headers: base, body: fd });
            if (!ap.ok) return { ok: false, error: 'media APPEND ' + ap.status };
            const fin = await fetch(UP, {
                method: 'POST', credentials: 'include',
                headers: { ...base, 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ command: 'FINALIZE', media_id: mediaId }),
            });
            const finData = await fin.json().catch(() => ({}));
            if (finData.errors?.length) return { ok: false, error: 'media FINALIZE: ' + (finData.errors[0].message || '') };
            mediaIds.push(mediaId);
        }
        const variables = {
            tweet_text: text || '',
            dark_request: false,
            media: { media_entities: mediaIds.map(id => ({ media_id: id, tagged_users: [] })), possibly_sensitive: false },
            semantic_annotation_ids: [],
        };
        const r = await fetch('https://api.x.com/graphql/' + queryId + '/CreateTweet', {
            method: 'POST', credentials: 'include',
            headers: { ...base, 'content-type': 'application/json' },
            body: JSON.stringify({ variables, features, fieldToggles, queryId }),
        });
        const data = await r.json().catch(() => ({}));
        if (data.errors?.length) {
            const e = data.errors[0];
            return { ok: false, code: e.code, error: 'CreateTweet code ' + (e.code ?? '?') + ': ' + (e.message || '') };
        }
        if (!data.data?.create_tweet) return { ok: false, error: 'CreateTweet 予期しないレスポンス' };
        return { ok: true };
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
    }
}

async function postViaRelay(payload) {
    if (!(chrome.scripting && chrome.scripting.executeScript)) {
        throw new Error('X投稿の中継に必要な scripting 権限がありません。拡張機能を再読み込みしてください。');
    }
    let tab = await findXTab();
    let created = false;
    if (!tab) {
        console.log('[X] no x.com tab open; opening a transient background tab for relay');
        tab = await chrome.tabs.create({ url: 'https://x.com/home', active: false });
        created = true;
        await waitTabComplete(tab.id);
        await delay(2500); // let X's client install its fetch wrapper
    } else {
        console.log('[X] relaying via existing x.com tab', tab.id);
    }
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: xRelayInjected,
            args: [payload],
        });
        const out = results && results[0] && results[0].result;
        if (!out) throw new Error('X投稿の中継に失敗しました（x.comページで実行できませんでした）。');
        if (!out.ok) {
            if (out.code === 226) {
                throw new Error('X側の自動化対策でブロックされました (code 226)。x.comページ経由でも拒否されたため、アカウントが一時的に制限されている可能性があります。VRChat投稿は成功しています。');
            }
            throw new Error('X投稿失敗: ' + out.error);
        }
        console.log('[X] relay post success');
        return out;
    } finally {
        if (created) { try { await chrome.tabs.remove(tab.id); } catch { } }
    }
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

    post(text, imageDataUrl = null) {
        // Only accept data:image/ payloads. Never let a crafted/imported post make
        // the SW fetch an arbitrary URL (blind SSRF / beacon).
        if (imageDataUrl != null && !(typeof imageDataUrl === 'string' && /^data:image\//i.test(imageDataUrl))) {
            return Promise.reject(new Error('X画像は data:image/ 形式のみ対応です'));
        }
        return runSerialized(() => postInner(text, imageDataUrl));
    },
};

async function postInner(text, imageDataUrl = null) {
    console.log('[X] xApi.post called', { textLen: text?.length, hasImage: !!imageDataUrl });
    const csrf = await getCsrfToken();
    await getAuthToken();

    // Resolve the live client config (bearer + CreateTweet op as a matched set).
    // The bearer is mandatory and never hard-coded.
    const cfg = await fetchXConfig();
    if (!cfg.bearer) {
        throw new Error('X の認証トークン(bearer)を取得できませんでした。x.com に接続できるか、ログイン状態を確認してください。');
    }
    const queryId = cfg.queryId || CREATE_TWEET_QUERY_ID;
    const featureNames = cfg.featureNames?.length ? cfg.featureNames : CREATE_TWEET_FEATURE_NAMES;
    const fieldToggleNames = cfg.fieldToggleNames?.length ? cfg.fieldToggleNames : CREATE_TWEET_FIELD_TOGGLE_NAMES;
    const features = Object.fromEntries(featureNames.map(n => [n, true]));
    const fieldToggles = Object.fromEntries(fieldToggleNames.map(n => [n, false]));

    // Post via an x.com page so X's wrapped fetch supplies x-client-transaction-id
    // (the SW's native fetch cannot, which is what triggers the 226 block).
    return postViaRelay({
        text: text || '',
        imageDataUrl: imageDataUrl || null,
        bearer: cfg.bearer,
        csrf,
        queryId,
        features,
        fieldToggles,
        lang: 'ja',
    });
}
