import { invokeBackend } from '../utils/extension-api';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import styles from '../styles/Home.module.css';

export default function Dashboard() {
  const [user, setUser] = useState(null);
  const [authNeedLogin, setAuthNeedLogin] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();

  // UX State
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState(''); // VRChat接続失敗（AUTH以外）
  const [showTrash, setShowTrash] = useState(false);
  // [proto] 投稿済みお知らせ一覧パネル (GET /groups/{id}/posts, 非破壊)
  const [publishedMode, setPublishedMode] = useState(false);
  const [publishedPosts, setPublishedPosts] = useState([]);
  const [publishedLoading, setPublishedLoading] = useState(false);
  const [publishedError, setPublishedError] = useState('');
  // [proto] 公開中お知らせの即時編集 (PUT /posts/{notificationId}, 破壊的)
  const [liveEditingId, setLiveEditingId] = useState(null); // null | notificationId(=GroupPost.id)
  const [liveEditingGroupId, setLiveEditingGroupId] = useState(null);
  const [liveEditingTitle, setLiveEditingTitle] = useState('');
  const [groupRefreshing, setGroupRefreshing] = useState(false);
  const [refreshCooldown, setRefreshCooldown] = useState(0);
  const [showScanConfirm, setShowScanConfirm] = useState(false);
  const [scanProgress, setScanProgress] = useState(null); // { current, total, groupName, phase }
  const [toast, setToast] = useState(null); // { message, type: 'success'|'error' }
  const [confirmDialog, setConfirmDialog] = useState(null); // { message, onConfirm }

  // Form State
  const [groupId, setGroupId] = useState('');
  const [groups, setGroups] = useState([]);

  // [proto] グループ在席ダッシュボード: 選択グループの人数/アクティブインスタンス数をキャッシュ
  const [groupStats, setGroupStats] = useState({}); // { [groupId]: { memberCount, onlineMemberCount, instances } }
  const [statsLoading, setStatsLoading] = useState(false);

  // [proto] 投稿権限のプリフライト確認 (null=未確認, true=権限あり, false=権限なし)
  const [permOk, setPermOk] = useState(null);
  const [permChecking, setPermChecking] = useState(false);

  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [notification, setNotification] = useState(false);

  // Edit State
  const [editingId, setEditingId] = useState(null);

  // Recurrence State
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurrenceType, setRecurrenceType] = useState('daily');
  const [recurrenceDays, setRecurrenceDays] = useState([]);

  // Image State
  const [imageDataUrl, setImageDataUrl] = useState('');
  const [imageName, setImageName] = useState('');

  // X(Twitter) State
  const [postToX, setPostToX] = useState(false);
  const [xText, setXText] = useState('');
  const [xLoggedIn, setXLoggedIn] = useState(null); // null = unknown, true/false = checked

  // Update State
  const [updateInfo, setUpdateInfo] = useState(null);
  const [showUpdateBanner, setShowUpdateBanner] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [updateSettings, setUpdateSettings] = useState({ channel: 'stable', autoCheck: true });
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState(null);
  const [downloadProgress, setDownloadProgress] = useState(null); // { percent }
  const [updateDownloaded, setUpdateDownloaded] = useState(false);

  useEffect(() => {
    checkAuth();
    loadUpdateSettings();
  }, []);

  // Fetch posts whenever showTrash changes
  useEffect(() => {
    if (user) {
      fetchPosts();
    }
  }, [showTrash, user]);

  // [proto] Published一覧: 指定グループの公開中お知らせをGETで取得（非破壊）
  const fetchPublishedPosts = async (gid = groupId) => {
    if (!gid) {
      setPublishedPosts([]);
      setPublishedError('');
      return;
    }
    setPublishedLoading(true);
    setPublishedError('');
    try {
      const data = await invokeBackend('posts:get-published', { groupId: gid });
      setPublishedPosts(Array.isArray(data) ? data : []);
    } catch (err) {
      setPublishedError(err.message || 'お知らせの取得に失敗しました');
      setPublishedPosts([]);
    } finally {
      setPublishedLoading(false);
    }
  };

  // [proto] published中はgroupId変更時に再取得
  useEffect(() => {
    if (publishedMode) {
      fetchPublishedPosts(groupId);
    }
  }, [publishedMode, groupId]);

  // Listen for scan progress from background worker
  useEffect(() => {
    const handleProgress = (request) => {
      if (request.type === 'SCAN_PROGRESS') {
        setScanProgress(request.payload);
      } else if (request.type === 'SCAN_COMPLETE') {
        setGroupRefreshing(false);
        setScanProgress(null);
        if (request.payload?.refreshed) {
          setRefreshCooldown(300);
          // Refresh group list from background
          if (user) {
            invokeBackend('groups:get-all', { userId: user.id }).then(res => {
              if (res.groups) setGroups(sortGroups(res.groups));
            }).catch(console.error);
          }
        }
        if (request.payload?.error) {
          setError('グループスキャン中にエラーが発生しました: ' + request.payload.error);
        }
      }
    };
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(handleProgress);
      return () => chrome.runtime.onMessage.removeListener(handleProgress);
    }
  }, [user]);

  const loadUpdateSettings = async () => {
    try {
      const settings = await invokeBackend('updater:get-settings');
      setUpdateSettings(settings);
    } catch (err) {
      console.error('Failed to load update settings:', err);
    }
  };

  const handleSaveSettings = async () => {
    try {
      const saved = await invokeBackend('updater:save-settings', updateSettings);
      setUpdateSettings(saved);
      setShowSettings(false);
    } catch (err) {
      console.error('Failed to save settings:', err);
    }
  };

  const handleCheckUpdate = async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      const result = await invokeBackend('updater:check', { channel: updateSettings.channel });
      setCheckResult(result);
      if (result.updateAvailable) {
        setUpdateInfo(result);
        setShowUpdateBanner(true);
      }
    } catch (err) {
      setCheckResult({ error: err.message || 'アップデートの確認に失敗しました' });
    } finally {
      setChecking(false);
    }
  };

  const handleOpenDownload = async () => {
    if (updateInfo?.autoUpdater) {
      // Windows: use electron-updater to download
      try {
        setDownloadProgress({ percent: 0 });
        await invokeBackend('updater:download-update');
      } catch (err) {
        setDownloadProgress(null);
        setError('ダウンロードに失敗しました: ' + err.message);
      }
    } else if (updateInfo?.downloadUrl) {
      // macOS/manual: open in browser
      await invokeBackend('updater:open-download', { url: updateInfo.downloadUrl });
    }
  };

  const handleInstallUpdate = async () => {
    await invokeBackend('updater:install-update');
  };

  const checkAuth = async () => {
    try {
      // IPC Call
      const userData = await invokeBackend('auth:get-user');
      if (!userData) {
        setAuthNeedLogin(true);
        return;
      }
      setUser(userData);
      const version = await invokeBackend('app:get-version');
      setAppVersion(version);
      fetchGroups(userData.id); // Optimized: pass user id
      fetchPosts();
    } catch (err) {
      console.error(err);
      // AUTH(401)のときだけログイン誘導。NETWORK/RATE_LIMIT等は接続エラーとして扱う
      if (err.code === 'AUTH') {
        setAuthNeedLogin(true);
      } else {
        setLoadError(err.message || 'VRChatへの接続に失敗しました');
      }
    } finally {
      setLoading(false);
    }
  };

  const sortGroups = (data) => {
    return [...data].sort((a, b) => {
      if (a.isOwner && !b.isOwner) return -1;
      if (!a.isOwner && b.isOwner) return 1;
      return a.name.localeCompare(b.name);
    });
  };

  // ISO文字列を datetime-local 用の値 'YYYY-MM-DDTHH:mm' へ（ローカル時刻）
  const toLocalInputValue = (iso) => {
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const fetchGroups = async (userId) => {
    try {
      const result = await invokeBackend('groups:get-all', { userId });
      if (result.needsScan) {
        // First time - show confirmation dialog
        setShowScanConfirm(true);
      } else {
        setGroups(sortGroups(result.groups));
      }
    } catch (err) {
      console.error('Failed to fetch groups', err);
      if (err.code === 'AUTH') {
        setAuthNeedLogin(true);
        return;
      }
      setError('グループの取得に失敗しました: ' + err.message);
    }
  };

  const startGroupScan = async () => {
    setShowScanConfirm(false);
    setGroupRefreshing(true);
    setScanProgress({ current: 0, total: 0, groupName: '', phase: 'fetching' });
    try {
      const result = await invokeBackend('groups:refresh', { userId: user?.id });
      if (result.scanning) {
        setGroups(sortGroups(result.groups));
        return; // Keep refreshing state true until SCAN_COMPLETE arrives
      } else if (result.refreshed) {
        setGroups(sortGroups(result.groups));
        setRefreshCooldown(300);
      }
    } catch (err) {
      console.error('Failed to scan groups', err);
      setError('グループのスキャンに失敗しました: ' + err.message);
    }
    setGroupRefreshing(false);
    setScanProgress(null);
  };

  const handleRefreshGroups = async () => {
    if (groupRefreshing || refreshCooldown > 0) return;
    setGroupRefreshing(true);
    setScanProgress({ current: 0, total: 0, groupName: '', phase: 'fetching' });
    try {
      const result = await invokeBackend('groups:refresh', { userId: user?.id });
      if (result.scanning) {
        setGroups(sortGroups(result.groups));
        return; // Wait for SCAN_COMPLETE to reset states
      } else if (result.refreshed) {
        setGroups(sortGroups(result.groups));
        setRefreshCooldown(300);
      } else if (result.cooldownRemaining > 0) {
        setRefreshCooldown(result.cooldownRemaining);
        setGroups(sortGroups(result.groups));
      }
    } catch (err) {
      console.error('Failed to refresh groups', err);
      setError('グループの更新に失敗しました: ' + err.message);
    }
    setGroupRefreshing(false);
    setScanProgress(null);
  };

  // Cooldown timer
  useEffect(() => {
    if (refreshCooldown <= 0) return;
    const timer = setInterval(() => {
      setRefreshCooldown(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [refreshCooldown]);

  // [proto] グループ在席ダッシュボード: グループ選択時に未取得なら在席情報をGETでキャッシュ
  useEffect(() => {
    if (!groupId) return;
    if (groupStats[groupId]) return; // 取得済みなら連打防止のためスキップ

    let cancelled = false;
    (async () => {
      setStatsLoading(true);
      try {
        const [detail, instances] = await Promise.all([
          invokeBackend('groups:get-detail', { groupId }),
          invokeBackend('groups:get-instances', { groupId }),
        ]);
        if (cancelled) return;
        setGroupStats(prev => ({
          ...prev,
          [groupId]: {
            memberCount: detail?.memberCount,
            onlineMemberCount: detail?.onlineMemberCount,
            instances: Array.isArray(instances) ? instances : [],
          },
        }));
      } catch (err) {
        // 在席情報は補助的なのでエラーは握りつぶし（行を出さない）
        console.warn('[proto] グループ在席情報の取得に失敗:', err);
      } finally {
        if (!cancelled) setStatsLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [groupId]);

  const handleGroupChange = (e) => {
    const newGroupId = e.target.value;
    if (!newGroupId) {
      setGroupId('');
      setPermOk(null); // [proto] 未選択に戻したら権限状態をリセット
      return;
    }
    setGroupId(newGroupId);

    // [proto] 投稿権限のプリフライト確認: 選択時に最新の権限を再確認する
    setPermChecking(true);
    setPermOk(null);
    invokeBackend('groups:check-permission', { groupId: newGroupId })
      .then(ok => setPermOk(!!ok))
      .catch(err => {
        console.error('Permission preflight failed', err);
        setPermOk(false);
      })
      .finally(() => setPermChecking(false));
  };

  const fetchPosts = async () => {
    setRefreshing(true);
    try {
      // IPC Call
      let data = await invokeBackend('posts:get-all', {
        includeDeleted: showTrash
      });

      // Filter client side to match view if backend returns mixed
      if (showTrash) {
        data = data.filter(p => p.status === 'deleted');
      } else {
        data = data.filter(p => p.status !== 'deleted');
      }

      // Sort: Recurring/Pending first, then by date desc
      data.sort((a, b) => {
        const priorityStatus = ['recurring', 'pending'];
        const aPrio = priorityStatus.includes(a.status);
        const bPrio = priorityStatus.includes(b.status);

        if (aPrio && !bPrio) return -1;
        if (!aPrio && bPrio) return 1;

        return new Date(b.created_at || b.scheduledAt) - new Date(a.created_at || a.scheduledAt);
      });
      setPosts(data);
    } catch (err) {
      console.error(err);
      setError('Failed to fetch posts');
    } finally {
      setRefreshing(false);
    }
  };

  const handleImageChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) {
      setImageDataUrl('');
      setImageName('');
      return;
    }
    const MAX_SIZE = 5 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      setError('画像サイズは5MB以下にしてください');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setImageDataUrl(reader.result);
      setImageName(file.name);
    };
    reader.onerror = () => setError('画像の読み込みに失敗しました');
    reader.readAsDataURL(file);
  };

  const handleCheckXLogin = async () => {
    try {
      const ok = await invokeBackend('x:check-login');
      setXLoggedIn(!!ok);
      setToast({ message: ok ? 'X(Twitter)にログイン済みです' : 'X(Twitter)にログインしていません', type: ok ? 'success' : 'error' });
    } catch (err) {
      setXLoggedIn(false);
      setError('X確認失敗: ' + err.message);
    }
  };

  // フォームを初期状態へ完全に戻す（作成/更新の成功時・編集キャンセル時に共通利用）
  const resetForm = () => {
    setTitle('');
    setText('');
    setScheduledAt('');
    setNotification(false);
    setIsRecurring(false);
    setRecurrenceType('daily');
    setRecurrenceDays([]);
    setImageDataUrl('');
    setImageName('');
    setPostToX(false);
    setXText('');
    setEditingId(null);
    // [proto] 公開投稿の即時編集セッションもクリア
    setLiveEditingId(null);
    setLiveEditingGroupId(null);
    setLiveEditingTitle('');
  };

  // ローカル予約投稿の作成/更新本体（土台の handleCreate を切り出したもの）。
  // 入力バリデーション・過去時刻ガード・重複ガードを通過した後にのみ呼ばれる。
  // recurrence は state から再計算する（曜日バリデーションは handleCreate 側で実施済み）。
  const doSchedule = async () => {
    let recurrence = null;
    if (isRecurring) {
      recurrence = { type: recurrenceType };
      if (recurrenceType === 'weekly') {
        recurrence.days = recurrenceDays;
      }
    }

    try {
      const selectedGroup = groups.find(g => g.groupId === groupId);
      const payload = {
        groupId,
        groupName: selectedGroup?.name || groupId,
        title,
        text,
        scheduledAt: new Date(scheduledAt).toISOString(),
        sendNotification: notification,
        recurrence,
        status: isRecurring ? 'recurring' : 'pending',
        imageDataUrl: imageDataUrl || null,
        imageName: imageName || null,
        postToX,
        xText: postToX ? (xText || `${title}\n\n${text}`) : null,
      };

      let res;
      if (editingId) {
        res = await invokeBackend('posts:update', { id: editingId, ...payload });
      } else {
        res = await invokeBackend('posts:create', payload);
      }

      if (res) { // res is the new/updated post object
        const wasEditing = !!editingId;
        resetForm();
        fetchPosts();
        setToast({ message: wasEditing ? '投稿を更新しました' : '投稿をスケジュールしました！', type: 'success' });
      }
    } catch (err) {
      setError('Error: ' + err.message);
    }
  };

  // [proto] Publishedパネルから公開中投稿を左フォームへ読み込み、即時編集モードに入る
  const startLiveEdit = (post) => {
    setTitle(post.title || '');
    setText(post.text || '');
    setLiveEditingId(post.id);
    setLiveEditingGroupId(groupId); // 選択中のグループ（Published取得元）
    setLiveEditingTitle(post.title || '');
    // 編集モードでは予約系入力は使わない
    setEditingId(null); // ローカル予約編集とは排他
    setScheduledAt('');
    setIsRecurring(false);
    setRecurrenceDays([]);
    setError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // [proto] 即時編集モードを解除（フォームはそのまま、通常のcreate経路に戻す）
  const cancelLiveEdit = () => {
    setLiveEditingId(null);
    setLiveEditingGroupId(null);
    setLiveEditingTitle('');
  };

  // [proto] VRChat上の公開投稿をPUTで即時更新（confirm通過後に呼ばれる）
  const doUpdateLive = async () => {
    setError('');
    try {
      await invokeBackend('posts:update-live', {
        groupId: liveEditingGroupId,
        notificationId: liveEditingId,
        body: {
          title,
          text,
          visibility: 'group',
          sendNotification: false, // 再通知を避ける
        },
      });
      setToast({ message: '公開投稿を更新しました', type: 'success' });
      // フォーム / 編集モードをリセット
      setTitle('');
      setText('');
      cancelLiveEdit();
      // Publishedパネルを再取得して反映を確認
      fetchPublishedPosts(liveEditingGroupId);
    } catch (err) {
      setError('公開投稿の更新に失敗しました: ' + err.message);
    }
  };

  // [proto] 公開中お知らせの削除 — ⚠️破壊的・VRChat本番に作用。二段確認(setConfirmDialog)経由でのみ呼ぶ
  const doDeleteLive = async (post) => {
    try {
      await invokeBackend('posts:delete-live', { groupId, notificationId: post.id });
      setToast({ message: '公開お知らせを削除しました', type: 'success' });
      fetchPublishedPosts(groupId);
    } catch (err) {
      setError('公開お知らせの削除に失敗しました: ' + (err.message || ''));
    }
  };

  // 統一フロー（モード優先度: live編集 > local編集 > 新規作成）
  const handleCreate = async (e) => {
    e.preventDefault();

    // [1] VRChat公開投稿の編集(PUT) — 破壊的。確認必須。予約系のバリデーションは不要。
    if (liveEditingId) {
      if (!title || !text) return;
      setError('');
      setConfirmDialog({
        message: 'VRChat上の公開投稿「' + (liveEditingTitle || title) + '」を更新します。即時反映されます。続行しますか？',
        onConfirm: () => { setConfirmDialog(null); doUpdateLive(); },
      });
      return;
    }

    // [2]/[3] ローカル予約の更新/新規作成 — 共通の入力・時刻・曜日バリデーション
    if (!groupId || !title || !text || !scheduledAt) return;
    setError('');

    // 予約時刻は未来でなければならない（過去だと chrome.alarms が即時発火してしまう）
    if (new Date(scheduledAt).getTime() <= Date.now()) {
      setError('予約時刻は現在より未来の日時を指定してください');
      return;
    }

    // recurrence の weekly 曜日バリデーション（recurrence は doSchedule 内で再計算する）
    if (isRecurring && recurrenceType === 'weekly' && recurrenceDays.length === 0) {
      setError('Please select at least one day for weekly recurrence.');
      return;
    }

    // [2] ローカル予約の更新は重複チェック不要（既存投稿の編集なので）
    if (editingId) {
      doSchedule();
      return;
    }

    // [3] 新規ローカル予約のみ、公開中の同名お知らせを重複ガード。
    // ガードは非破壊。GET失敗時はスキップしてそのまま投稿を続行（投稿を妨げない）。
    try {
      const live = await invokeBackend('posts:get-published', { groupId });
      const dup = (live || []).some(p => (p.title || '').trim().toLowerCase() === title.trim().toLowerCase());
      if (dup) {
        setConfirmDialog({
          message: '「' + title + '」と同名のお知らせが既にVRChatグループに公開中です。続行しますか？',
          onConfirm: () => { setConfirmDialog(null); doSchedule(); },
        });
        return;
      }
    } catch (_) {
      // ガード用GETの失敗は致命的ではない。続行する。
    }

    doSchedule();
  };

  const handleDelete = async (id) => {
    const isTrash = showTrash;
    const msg = isTrash ? 'この投稿を完全に削除しますか？' : 'この投稿をゴミ箱に移動しますか？';

    setConfirmDialog({
      message: msg,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await invokeBackend('posts:delete', { id, force: isTrash });
          // 編集中の投稿を削除した場合は編集セッションを終了（ゴミ箱投稿の復活バグ防止）
          if (id === editingId) resetForm();
          fetchPosts();
          setToast({ message: isTrash ? '投稿を削除しました' : 'ゴミ箱に移動しました', type: 'success' });
        } catch (err) {
          setError(err.message);
        }
      }
    });
  };

  const handleRetry = (post) => {
    let targetGroupId = post.groupId;
    const groupExists = groups.some(g => g.groupId === targetGroupId);

    if (!groupExists) {
      const foundByMemberId = groups.find(g => g.id === targetGroupId);
      if (foundByMemberId) {
        targetGroupId = foundByMemberId.groupId;
      }
    }

    setGroupId(targetGroupId);
    setTitle(post.title);
    setText(post.text);
    setNotification(post.sendNotification || false);
    setScheduledAt('');
    setImageDataUrl(post.imageDataUrl || '');
    setImageName(post.imageName || '');
    setPostToX(!!post.postToX);
    setXText(post.xText || '');

    setEditingId(null); // Retryは新規作成として扱う
    setError('');
  };



  const handleEdit = (post) => {
    let targetGroupId = post.groupId;
    const groupExists = groups.some(g => g.groupId === targetGroupId);

    if (!groupExists) {
      const foundByMemberId = groups.find(g => g.id === targetGroupId);
      if (foundByMemberId) {
        targetGroupId = foundByMemberId.groupId;
      }
    }

    if (!groups.some(g => g.groupId === targetGroupId)) {
      setToast({ message: '元のグループが見つかりません。グループを選び直してください', type: 'error' });
    }
    setGroupId(targetGroupId);
    setTitle(post.title);
    setText(post.text);
    setNotification(post.sendNotification || false);
    setScheduledAt(toLocalInputValue(post.scheduledAt));
    setImageDataUrl(post.imageDataUrl || '');
    setImageName(post.imageName || '');
    setPostToX(!!post.postToX);
    setXText(post.xText || '');

    // Handle Recurrence
    if (post.recurrence) {
      setIsRecurring(true);
      setRecurrenceType(post.recurrence.type);
      setRecurrenceDays(post.recurrence.days || []);
    } else {
      setIsRecurring(false);
      setRecurrenceDays([]);
    }

    setEditingId(post.id);
    setError('');
    // Scroll to top to see form
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };



  const handleClone = (post) => {
    let targetGroupId = post.groupId;
    const groupExists = groups.some(g => g.groupId === targetGroupId);

    if (!groupExists) {
      const foundByMemberId = groups.find(g => g.id === targetGroupId);
      if (foundByMemberId) {
        targetGroupId = foundByMemberId.groupId;
      }
    }

    setGroupId(targetGroupId);
    setTitle(post.title);
    setText(post.text);
    setNotification(post.sendNotification || false);
    setScheduledAt(''); // Reset time for new schedule
    setImageDataUrl(post.imageDataUrl || '');
    setImageName(post.imageName || '');
    setPostToX(!!post.postToX);
    setXText(post.xText || '');

    // Handle Recurrence
    if (post.recurrence) {
      setIsRecurring(true);
      setRecurrenceType(post.recurrence.type);
      setRecurrenceDays(post.recurrence.days || []);
    } else {
      setIsRecurring(false);
      setRecurrenceDays([]);
    }

    // If it's a recurring parent status, treat as recurring
    if (post.status === 'recurring' && !post.recurrence) {
      // Should have recurrence obj if status is recurring, but just in case
    }

    setEditingId(null); // Cloneは新規作成として扱う
    setError('');
    // Scroll to top to see form
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDayToggle = (dayIndex) => {
    if (recurrenceDays.includes(dayIndex)) {
      setRecurrenceDays(recurrenceDays.filter(d => d !== dayIndex));
    } else {
      setRecurrenceDays([...recurrenceDays, dayIndex]);
    }
  };

  if (loading) return <div className={styles.container}>Loading...</div>;
  if (authNeedLogin) return (
    <div className={styles.container} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', textAlign: 'center' }}>
      <h2 style={{ color: 'var(--text)', marginBottom: '1rem' }}>VRChatのログインが必要です</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: '2rem' }}>
        グループ情報の取得や投稿を行うには、<br />
        ブラウザでVRChat公式サイトにログインしている必要があります。
      </p>
      <button
        className={styles.button}
        style={{ padding: '0.8rem 2rem', fontSize: '1.2rem', marginBottom: '1rem', width: 'auto' }}
        onClick={() => window.open('https://vrchat.com/login', '_blank')}
      >
        VRChat公式サイトを開く
      </button>
      <button
        className={styles.button}
        style={{ padding: '0.6rem 1.5rem', fontSize: '1rem', backgroundColor: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', width: 'auto' }}
        onClick={() => window.location.reload()}
      >
        ログイン後に再読み込み
      </button>
    </div>
  );
  if (loadError) return (
    <div className={styles.container} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', textAlign: 'center' }}>
      <h2 style={{ color: 'var(--text)', marginBottom: '1rem' }}>VRChatへの接続に失敗しました</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: '2rem' }}>
        {loadError}<br />
        ネットワーク状況を確認し、時間をおいて再度お試しください。
      </p>
      <button
        className={styles.button}
        style={{ padding: '0.8rem 2rem', fontSize: '1.1rem', width: 'auto' }}
        onClick={() => window.location.reload()}
      >
        再読み込み
      </button>
    </div>
  );
  if (!user) return null;

  return (
    <>
      <style dangerouslySetInnerHTML={{
        __html: `
        :root {
          /* Surfaces (page -> card -> raised -> recessed well) */
          --bg: #0F141A;
          --surface: #161D26;
          --surface-2: #1C2530;
          --well: #0E1319;
          /* Hairlines */
          --border: #232C38;
          --border-strong: #30404F;
          /* Text ramp */
          --text: #F4F6FA;
          --text-secondary: #C2CCD9;
          --text-muted: #8593A3;
          --text-subtle: #5A6675;
          /* One disciplined accent (indigo) */
          --accent: #6E79F0;
          --accent-hover: #8A93FF;
          --accent-pressed: #5A63D6;
          --accent-tint: rgba(110, 121, 240, 0.14);
          --on-accent: #0E1319;
          /* Semantic */
          --ok: #4ADE80;
          --warn: #F0B65A;
          --danger: #F87171;
          /* Status pills (tinted-translucent) */
          --status-pending-fg: #F0B65A;
          --status-pending-bg: rgba(214, 158, 46, 0.16);
          --status-posted-fg: #4ADE80;
          --status-posted-bg: rgba(56, 161, 105, 0.16);
          --status-failed-fg: #F87171;
          --status-failed-bg: rgba(229, 62, 62, 0.16);
          --status-neutral-fg: #94A3B8;
          --status-neutral-bg: rgba(113, 128, 150, 0.14);
          --status-recurring-fg: #8A93FF;
          --status-recurring-bg: rgba(110, 121, 240, 0.14);
          /* Badges */
          --badge-border: #2A3441;
          --badge-text: #A8B4C2;
          --badge-x-bg: #15191E;
          --badge-x-text: #E7E9EA;
          /* Elevation */
          --shadow-card: inset 0 1px 0 rgba(255, 255, 255, 0.04);
          --shadow-elevated: 0 16px 48px rgba(0, 0, 0, 0.6);
          --overlay: rgba(8, 10, 14, 0.66);
        }
        body {
          margin: 0;
          background-color: var(--bg);
        }
        * {
          box-sizing: border-box;
        }
      `}} />
      <div className={styles.container}>
        <header className={styles.header}>
          <div className={styles.title}>VRChat-Group-Notify-Scheduler</div>
          <div className={styles.userInfo}>
            <span className={styles.versionInfo}>v{appVersion || '...'}</span>
            <button
              className={styles.settingsBtn}
              onClick={() => {
                if (typeof chrome !== 'undefined' && chrome.tabs) {
                  chrome.tabs.create({ url: 'index.html' });
                } else {
                  window.open(window.location.href, '_blank');
                }
              }}
              title="別タブで開く"
              style={{
                marginRight: '0.5rem',
                width: 'auto',
                height: 'auto',
                fontSize: '0.8rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.35rem 0.7rem',
                background: 'transparent',
                borderRadius: '6px',
                color: 'var(--text-muted)',
                fontWeight: 600,
                border: '1px solid var(--border)'
              }}
            >
              <span>⤢ 全画面</span>
            </button>
            <span className={styles.username}>{user.displayName}</span>
            <img src={user.userIcon || 'https://assets.vrchat.com/www/images/default_avatar.png'} className={styles.avatar} alt="Avatar" />
          </div>
        </header>

        {/* Initial Scan Confirmation Dialog */}
        {showScanConfirm && (
          <div className={styles.modalOverlay}>
            <div className={styles.modalContent}>
              <h3 className={styles.modalTitle}>グループ権限のスキャン</h3>
              <p className={styles.modalText}>
                投稿権限のあるグループを確認するため、参加中のグループをスキャンします。
                <br /><br />
                <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  ※ 初回のみ全グループの権限を確認します。スキャン結果はキャッシュされるため、2回目以降はすぐに表示されます。
                </span>
              </p>
              <div className={styles.modalActions}>
                <button className={styles.scanStartBtn} onClick={startGroupScan}>
                  スキャンを開始
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Scan Progress Modal */}
        {scanProgress && groupRefreshing && (
          <div className={styles.modalOverlay}>
            <div className={styles.modalContent}>
              <h3 className={styles.modalTitle}>グループをスキャン中...</h3>
              <div className={styles.scanProgressContainer}>
                <div className={styles.scanProgressBar}>
                  <div
                    className={`${styles.scanProgressFill} ${scanProgress.phase === 'waiting' ? styles.scanProgressFillWaiting : ''}`}
                    style={{
                      width: scanProgress.total > 0
                        ? `${(scanProgress.current / scanProgress.total) * 100}%`
                        : '0%'
                    }}
                  />
                </div>
                <div className={styles.scanProgressInfo}>
                  {scanProgress.phase === 'fetching' ? (
                    <span>グループ一覧を取得中...</span>
                  ) : scanProgress.phase === 'waiting' ? (
                    <span style={{ color: 'var(--warn)', fontWeight: 'bold' }}>
                      API制限のため一時待機中... ({Math.round(scanProgress.retryIn)}秒)
                    </span>
                  ) : (
                    <>
                      <span className={styles.scanProgressCount}>
                        {scanProgress.current} / {scanProgress.total}
                      </span>
                      <span className={styles.scanProgressName}>
                        {scanProgress.groupName}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className={styles.errorBanner}>
            <span>{error}</span>
            <button className={styles.closeError} onClick={() => setError('')}>×</button>
          </div>
        )}

        {showUpdateBanner && updateInfo && (
          <div className={styles.updateBanner}>
            <div className={styles.updateBannerInfo}>
              <div className={styles.updateBannerTitle}>
                🚀 新しいバージョンが利用可能です
                {updateInfo.isBeta && <span className={styles.betaBadge}>BETA</span>}
              </div>
              <div className={styles.updateBannerMeta}>
                {updateInfo.currentVersion ? `v${updateInfo.currentVersion} → ` : ''}v{updateInfo.latestVersion || updateInfo.version}
                {updateInfo.releaseNotes && ` — ${updateInfo.releaseNotes.split('\n')[0].substring(0, 80)}`}
              </div>
              {downloadProgress && (
                <div style={{ marginTop: '0.5rem' }}>
                  <div style={{ background: 'var(--well)', borderRadius: '3px', height: '4px', overflow: 'hidden' }}>
                    <div style={{ width: `${downloadProgress.percent}%`, height: '100%', background: 'var(--ok)', transition: 'width 0.3s ease', borderRadius: '3px' }} />
                  </div>
                  <span style={{ fontSize: '0.75rem', opacity: 0.8 }}>ダウンロード中... {downloadProgress.percent}%</span>
                </div>
              )}
            </div>
            <div className={styles.updateBannerActions}>
              {updateDownloaded ? (
                <button className={styles.updateDownloadBtn} onClick={handleInstallUpdate} style={{ backgroundColor: 'var(--ok)', color: 'var(--bg)' }}>
                  再起動してアップデート
                </button>
              ) : downloadProgress ? (
                <button className={styles.updateDownloadBtn} disabled style={{ opacity: 0.6, cursor: 'not-allowed' }}>
                  ダウンロード中...
                </button>
              ) : (
                <button className={styles.updateDownloadBtn} onClick={handleOpenDownload}>
                  {updateInfo.autoUpdater ? 'アップデート' : 'ダウンロード'}
                </button>
              )}
              <button className={styles.updateDismissBtn} onClick={() => setShowUpdateBanner(false)}>
                後で
              </button>
            </div>
          </div>
        )}

        <div className={styles.grid}>
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>{editingId ? '予約投稿を編集' : 'New Scheduled Post'}</h2>
            <form onSubmit={handleCreate}>
              <div className={styles.formGroup}>
                <label className={styles.label}>Group</label>
                <select
                  className={styles.select}
                  value={groupId}
                  onChange={handleGroupChange}
                  required
                >
                  <option value="" disabled>Select a group</option>
                  {groups.map(g => (
                    <option key={g.id} value={g.groupId}>
                      {g.name} ({g.shortCode}) {g.isOwner ? '★' : '◆'}
                    </option>
                  ))}
                </select>
                <div style={{ marginTop: '0.3rem', fontSize: '0.75rem', textAlign: 'right' }}>
                  <span
                    onClick={handleRefreshGroups}
                    style={{
                      color: (groupRefreshing || refreshCooldown > 0) ? 'var(--text-subtle)' : 'var(--accent-hover)',
                      cursor: (groupRefreshing || refreshCooldown > 0) ? 'default' : 'pointer',
                      textDecoration: (groupRefreshing || refreshCooldown > 0) ? 'none' : 'underline',
                    }}
                  >
                    {groupRefreshing
                      ? '更新中...'
                      : refreshCooldown > 0
                        ? `グループ更新 (${Math.floor(refreshCooldown / 60)}:${String(refreshCooldown % 60).padStart(2, '0')})`
                        : 'グループが見つからない場合はこちら'
                    }
                  </span>
                </div>

                {/* [proto] 投稿権限のプリフライト確認: 権限が確認できない場合の警告 */}
                {permOk === false && (
                  <div style={{ marginTop: '0.4rem', fontSize: '0.8rem', color: 'var(--danger)' }}>
                    このグループの投稿権限が確認できません。権限が変更された可能性があります。「グループ更新」をお試しください。
                  </div>
                )}

                {/* [proto] グループ在席ダッシュボード: 選択グループの薄いインフォ行（非破壊・GETのみ） */}
                {groupId && (statsLoading && !groupStats[groupId] ? (
                  <div
                    style={{
                      marginTop: '0.4rem',
                      padding: '0.4rem 0.6rem',
                      background: 'var(--well)',
                      border: '1px solid var(--border)',
                      borderRadius: '6px',
                      fontSize: '0.75rem',
                      color: 'var(--text-muted)',
                    }}
                  >
                    在席情報を読み込み中…
                  </div>
                ) : groupStats[groupId] ? (
                  <div
                    style={{
                      marginTop: '0.4rem',
                      padding: '0.4rem 0.6rem',
                      background: 'var(--well)',
                      border: '1px solid var(--border)',
                      borderRadius: '6px',
                      fontSize: '0.75rem',
                      color: 'var(--text-muted)',
                      display: 'flex',
                      gap: '0.75rem',
                      flexWrap: 'wrap',
                    }}
                  >
                    <span>👥 {groupStats[groupId].memberCount?.toLocaleString() ?? '—'}</span>
                    <span>🟢 オンライン {groupStats[groupId].onlineMemberCount ?? '—'}</span>
                    <span>🌐 アクティブ {groupStats[groupId].instances.length}</span>
                  </div>
                ) : null)}
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>Title</label>
                <input
                  className={styles.input}
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  required
                />
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>Message</label>
                <textarea
                  className={styles.textarea}
                  value={text}
                  onChange={e => setText(e.target.value)}
                  required
                />
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>Image (Optional, PNG/JPG, ≤5MB)</label>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/gif"
                  onChange={handleImageChange}
                  style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}
                />
                <div style={{ fontSize: '0.7rem', color: 'var(--warn)', marginTop: '0.25rem' }}>
                  ※ VRChat側の画像添付は VRC+ サブスクライブ必須で、最低 512×512px 程度必要です。条件外なら画像なしで投稿継続し、X同時投稿には影響しません。
                </div>
                {imageDataUrl && (
                  <div style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <img
                      src={imageDataUrl}
                      alt="preview"
                      style={{ maxWidth: '120px', maxHeight: '80px', borderRadius: '6px', border: '1px solid var(--border)' }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', wordBreak: 'break-all' }}>{imageName}</div>
                      <button
                        type="button"
                        onClick={() => { setImageDataUrl(''); setImageName(''); }}
                        style={{
                          marginTop: '0.3rem',
                          background: 'var(--surface-2)',
                          color: 'var(--text)',
                          border: '1px solid var(--border)',
                          borderRadius: '6px',
                          padding: '0.2rem 0.6rem',
                          fontSize: '0.75rem',
                          cursor: 'pointer'
                        }}
                      >
                        画像を削除
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>Start Time (First Execution)</label>
                <input
                  type="datetime-local"
                  className={styles.input}
                  value={scheduledAt}
                  onChange={e => setScheduledAt(e.target.value)}
                  required
                />
              </div>

              <div className={styles.formGroup}>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <input
                    type="checkbox"
                    id="recur"
                    checked={isRecurring}
                    onChange={e => setIsRecurring(e.target.checked)}
                  />
                  <label htmlFor="recur" style={{ marginBottom: 0, color: 'var(--text-secondary)', fontWeight: 600 }}>Repeat Schedule</label>
                </div>

                {isRecurring && (
                  <div style={{ marginLeft: '1.5rem', padding: '0.75rem', background: 'var(--well)', border: '1px solid var(--border)', borderRadius: '8px' }}>
                    <div style={{ marginBottom: '0.5rem' }}>
                      <label className={styles.label} style={{ fontSize: '0.9rem' }}>Frequency</label>
                      <select
                        className={styles.select}
                        style={{ fontSize: '0.9rem', padding: '0.4rem' }}
                        value={recurrenceType}
                        onChange={e => setRecurrenceType(e.target.value)}
                      >
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly</option>
                      </select>
                    </div>

                    {recurrenceType === 'weekly' && (
                      <div>
                        <label className={styles.label} style={{ fontSize: '0.9rem' }}>Days</label>
                        <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, idx) => (
                            <button
                              key={day}
                              type="button"
                              onClick={() => handleDayToggle(idx)}
                              style={{
                                background: recurrenceDays.includes(idx) ? 'var(--accent)' : 'transparent',
                                color: recurrenceDays.includes(idx) ? 'var(--on-accent)' : 'var(--text-muted)',
                                border: recurrenceDays.includes(idx) ? '1px solid transparent' : '1px solid var(--border)',
                                borderRadius: '8px',
                                fontWeight: 600,
                                padding: '0.3rem 0.55rem',
                                fontSize: '0.8rem',
                                cursor: 'pointer'
                              }}
                            >
                              {day}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      Will repeat at the same time as "Start Time".
                    </div>
                  </div>
                )}
              </div>

              <div className={styles.formGroup} style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  id="noti"
                  checked={notification}
                  onChange={e => setNotification(e.target.checked)}
                />
                <label htmlFor="noti" style={{ marginBottom: 0, color: 'var(--text-secondary)' }}>Send Notification to Group</label>
              </div>

              <div className={styles.formGroup}>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <input
                    type="checkbox"
                    id="postX"
                    checked={postToX}
                    onChange={e => setPostToX(e.target.checked)}
                  />
                  <label htmlFor="postX" style={{ marginBottom: 0, color: 'var(--text-secondary)', fontWeight: 600 }}>X(Twitter)にも同時投稿</label>
                  <span
                    onClick={handleCheckXLogin}
                    style={{
                      marginLeft: 'auto',
                      color: xLoggedIn === true ? 'var(--ok)' : xLoggedIn === false ? 'var(--danger)' : 'var(--accent-hover)',
                      cursor: 'pointer',
                      textDecoration: 'underline',
                      fontSize: '0.8rem',
                    }}
                    title="X(Twitter)へのログイン状態を確認"
                  >
                    {xLoggedIn === true ? '✓ ログイン済み' : xLoggedIn === false ? '✕ 未ログイン' : 'X ログイン確認'}
                  </span>
                </div>

                {postToX && (
                  <div style={{ marginLeft: '1.5rem', padding: '0.75rem', background: 'var(--well)', border: '1px solid var(--border)', borderRadius: '8px' }}>
                    <label className={styles.label} style={{ fontSize: '0.9rem' }}>
                      Xポスト本文（空欄ならTitle+Messageを使用、280字以内）
                    </label>
                    <textarea
                      className={styles.textarea}
                      style={{ fontSize: '0.9rem', minHeight: '60px' }}
                      value={xText}
                      onChange={e => setXText(e.target.value)}
                      maxLength={280}
                      placeholder={`${title}\n\n${text}`.slice(0, 280)}
                    />
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'right' }}>
                      {(xText || `${title}\n\n${text}`).length} / 280
                    </div>
                    {imageDataUrl && (
                      <div style={{ fontSize: '0.75rem', color: 'var(--accent-hover)' }}>
                        ↑ アップロードした画像も同時に投稿します
                      </div>
                    )}
                    <div style={{ fontSize: '0.75rem', color: 'var(--warn)', marginTop: '0.3rem' }}>
                      ※ ブラウザでX(Twitter)にログイン済みであることが必要です
                    </div>
                  </div>
                )}
              </div>

              {/* [proto] 即時編集モード中の注意書き */}
              {liveEditingId && (
                <div style={{ marginBottom: '0.6rem', padding: '0.6rem 0.75rem', background: 'var(--status-failed-bg)', border: '1px solid var(--danger)', borderRadius: '8px', fontSize: '0.8rem', color: 'var(--danger)' }}>
                  ⚠️ VRChat上の公開投稿「{liveEditingTitle}」を編集中です。「公開中の投稿を更新」を押すと<strong>即時反映</strong>されます（予約ではありません）。
                </div>
              )}

              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <button
                  type="submit"
                  className={styles.button}
                  style={{ flex: 1, ...((!liveEditingId && (permChecking || permOk === false)) ? { opacity: 0.6, cursor: 'not-allowed' } : {}) }}
                  disabled={!liveEditingId && (permChecking || permOk === false)}
                >
                  {liveEditingId ? '公開中の投稿を更新' : editingId ? '更新する' : (permChecking ? '確認中…' : 'Schedule Post')}
                </button>
                {(editingId || liveEditingId) && (
                  <button
                    type="button"
                    className={styles.button}
                    style={{
                      flex: '0 0 auto',
                      width: 'auto',
                      background: 'transparent',
                      color: 'var(--text-muted)',
                      border: '1px solid var(--border)',
                    }}
                    onClick={() => {
                      if (liveEditingId) { cancelLiveEdit(); } else { resetForm(); }
                      setError('');
                    }}
                  >
                    キャンセル
                  </button>
                )}
              </div>
            </form>
          </section>

          <section className={styles.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h2 className={styles.cardTitle} style={{ marginBottom: 0 }}>
                {publishedMode ? 'Published' : (showTrash ? 'Trash Can' : 'Scheduled Queue')}
              </h2>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <button
                  className={styles.retryBtn}
                  style={{ fontSize: '0.85rem', color: 'var(--accent-hover)', marginRight: '0.75rem' }}
                  onClick={publishedMode ? () => fetchPublishedPosts(groupId) : fetchPosts}
                >Refresh</button>

                {/* [proto] 投稿済みお知らせ一覧トグル (GET /groups/{id}/posts) */}
                <button
                  className={`${styles.trashToggle} ${publishedMode ? styles.trashToggleActive : ''}`}
                  style={{ marginRight: '0.5rem' }}
                  onClick={() => setPublishedMode(!publishedMode)}
                >
                  {publishedMode ? 'Hide Published' : 'Published'}
                </button>

                <button
                  className={`${styles.trashToggle} ${showTrash ? styles.trashToggleActive : ''}`}
                  onClick={() => setShowTrash(!showTrash)}
                  disabled={publishedMode}
                  style={publishedMode ? { opacity: 0.4, cursor: 'not-allowed' } : {}}
                >
                  {showTrash ? 'Show Queue' : 'Show Trash'}
                </button>
              </div>
            </div>

            {/* [proto] 投稿済みお知らせ一覧 (VRChat上に実在する公開中のお知らせ)。各行に本番編集/本番削除 */}
            {publishedMode ? (
              <div className={styles.postList}>
                {!groupId && (
                  <div className={styles.emptyState}>
                    <div className={styles.emptyStateIcon}>📢</div>
                    <div className={styles.emptyStateTitle}>グループ未選択</div>
                    <div className={styles.emptyStateHint}>左のフォームでグループを選択してください</div>
                  </div>
                )}
                {groupId && publishedLoading && (
                  <div className={styles.emptyState}>
                    <div className={styles.emptyStateIcon}>⏳</div>
                    <div className={styles.emptyStateTitle}>読み込み中...</div>
                    <div className={styles.emptyStateHint}>Loading published announcements</div>
                  </div>
                )}
                {groupId && !publishedLoading && publishedError && (
                  <div className={styles.emptyState}>
                    <div className={styles.emptyStateIcon}>⚠️</div>
                    <div className={styles.emptyStateTitle} style={{ color: 'var(--danger)' }}>取得に失敗しました</div>
                    <div className={styles.emptyStateHint}>{publishedError}</div>
                  </div>
                )}
                {groupId && !publishedLoading && !publishedError && publishedPosts.length === 0 && (
                  <div className={styles.emptyState}>
                    <div className={styles.emptyStateIcon}>📭</div>
                    <div className={styles.emptyStateTitle}>公開中のお知らせはありません</div>
                    <div className={styles.emptyStateHint}>No published announcements</div>
                  </div>
                )}
                {groupId && !publishedLoading && !publishedError && publishedPosts.map(post => (
                  <div
                    key={post.id}
                    className={styles.postItem}
                    style={liveEditingId === post.id ? { borderLeft: '2px solid var(--accent)' } : {}}
                  >
                    <div className={styles.postInfo}>
                      <div className={styles.postTitle}>
                        {/* visibilityバッジ (group/public) */}
                        <span style={{ fontSize: '0.7rem', fontWeight: 600, background: 'transparent', border: '1px solid var(--badge-border)', color: 'var(--badge-text)', padding: '1px 6px', borderRadius: '6px', marginRight: '6px', verticalAlign: '1px' }}>
                          {post.visibility === 'public' ? 'public' : 'group'}
                        </span>
                        {post.imageId && <span style={{ fontSize: '0.7rem', fontWeight: 600, background: 'transparent', border: '1px solid var(--badge-border)', color: 'var(--badge-text)', padding: '1px 6px', borderRadius: '6px', marginRight: '6px', verticalAlign: '1px' }}>IMG</span>}
                        {post.title}
                      </div>
                      <div className={styles.postMeta}>
                        {post.createdAt ? new Date(post.createdAt).toLocaleString() : '—'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      {/* [proto] この公開投稿を左フォームへ読み込み、即時編集(PUT)へ */}
                      <button
                        className={styles.retryBtn}
                        style={liveEditingId === post.id ? { color: 'var(--accent-hover)' } : {}}
                        onClick={() => startLiveEdit(post)}
                        title="この公開投稿を編集してVRChatに即時反映"
                      >
                        ✎ 本番を編集
                      </button>
                      {/* ⚠️本番削除: ローカルキューの「×」とは別物。VRChat上のお知らせをDELETE */}
                      <button
                        className={styles.deleteLiveBtn}
                        onClick={() => setConfirmDialog({
                          message: 'VRChat上のお知らせ「' + post.title + '」を完全に削除します。元に戻せません。本当に削除しますか？',
                          onConfirm: () => { setConfirmDialog(null); doDeleteLive(post); }
                        })}
                        title="VRChat上のお知らせを削除"
                      >
                        🗑 本番削除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
            <div className={styles.postList}>
              {posts.length === 0 && (
                <div className={styles.emptyState}>
                  <div className={styles.emptyStateIcon}>{showTrash ? '🗑️' : '🗓️'}</div>
                  <div className={styles.emptyStateTitle}>{showTrash ? 'ゴミ箱は空です' : '予約された投稿はありません'}</div>
                  <div className={styles.emptyStateHint}>{showTrash ? 'Trash is empty' : '左のフォームから新しい投稿をスケジュールできます'}</div>
                </div>
              )}
              {posts.map(post => (
                <div key={post.id} className={styles.postItem} style={post.status === 'recurring' ? { borderLeft: '2px solid var(--accent)' } : {}}>
                  <div className={styles.postInfo}>
                    <div className={styles.postTitle}>
                      {post.status === 'recurring' && <span style={{ fontSize: '0.7rem', fontWeight: 600, background: 'transparent', border: '1px solid var(--badge-border)', color: 'var(--badge-text)', padding: '1px 6px', borderRadius: '6px', marginRight: '6px', verticalAlign: '1px' }}>Repeat</span>}
                      {post.imageDataUrl && <span style={{ fontSize: '0.7rem', fontWeight: 600, background: 'transparent', border: '1px solid var(--badge-border)', color: 'var(--badge-text)', padding: '1px 6px', borderRadius: '6px', marginRight: '6px', verticalAlign: '1px' }}>IMG</span>}
                      {post.postToX && <span style={{ fontSize: '0.7rem', fontWeight: 600, background: 'var(--badge-x-bg)', color: 'var(--badge-x-text)', padding: '1px 6px', borderRadius: '6px', marginRight: '6px', verticalAlign: '1px' }}>𝕏</span>}
                      {post.title}
                    </div>
                    <div className={styles.postMeta}>
                      {new Date(post.scheduledAt).toLocaleString()} • {post.groupName || post.groupId}
                      {post.recurrence && (
                        <div style={{ color: 'var(--accent-hover)', fontSize: '0.85rem', marginTop: '2px' }}>
                          ↻ {post.recurrence.type.charAt(0).toUpperCase() + post.recurrence.type.slice(1)}
                          {post.recurrence.type === 'weekly' && post.recurrence.days && ` (${post.recurrence.days.map(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')})`}
                        </div>
                      )}
                      {post.vrcImageError && (
                        <div style={{ color: 'var(--danger)', fontSize: '0.8rem', marginTop: '2px' }}>
                          画像添付失敗: {post.vrcImageError}
                        </div>
                      )}
                      {post.xError && (
                        <div style={{ color: 'var(--danger)', fontSize: '0.8rem', marginTop: '2px' }}>
                          X投稿失敗: {post.xError}
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <span className={`${styles.status} ${styles['status' + (post.status.charAt(0).toUpperCase() + post.status.slice(1))]}`}>
                      {post.status}
                    </span>

                    {!showTrash && (post.status === 'pending' || post.status === 'recurring') && (
                      <button
                        className={styles.retryBtn}
                        style={{ marginRight: '0.5rem' }}
                        onClick={() => handleEdit(post)}
                        title="編集"
                      >
                        ✎
                      </button>
                    )}

                    <button
                      className={styles.retryBtn}
                      style={{ marginRight: '0.5rem' }}
                      onClick={() => handleClone(post)}
                      title="Copy to Form"
                    >
                      Clone
                    </button>

                    <button
                      className={styles.deleteBtn}
                      onClick={() => handleDelete(post.id)}
                      title={showTrash ? "Permanently Delete" : "Move to Trash"}
                    >
                      ×
                    </button>

                    {(post.status === 'failed' || post.status === 'missed' || post.status === 'deleted') && (
                      <button
                        className={styles.retryBtn}
                        onClick={() => handleRetry(post)}
                        title="Retry"
                      >
                        ↻
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            )}
          </section>
        </div>

        {/* Settings Modal */}
        {showSettings && (
          <div className={styles.settingsOverlay} onClick={(e) => { if (e.target === e.currentTarget) setShowSettings(false); }}>
            <div className={styles.settingsModal}>
              <div className={styles.settingsTitle}>⚙ アップデート設定</div>

              <div className={styles.settingsGroup}>
                <label className={styles.settingsLabel}>更新チャネル</label>
                <select
                  className={styles.settingsSelect}
                  value={updateSettings.channel}
                  onChange={(e) => setUpdateSettings({ ...updateSettings, channel: e.target.value })}
                >
                  <option value="stable">Stable（安定版）</option>
                  <option value="beta">Beta（ベータ版 — プレリリースを含む）</option>
                </select>
              </div>

              <div className={styles.settingsGroup}>
                <label className={styles.settingsCheckbox}>
                  <input
                    type="checkbox"
                    checked={updateSettings.autoCheck}
                    onChange={(e) => setUpdateSettings({ ...updateSettings, autoCheck: e.target.checked })}
                  />
                  起動時に自動でアップデートを確認する
                </label>
              </div>

              <div className={styles.settingsGroup}>
                <button
                  className={styles.settingsCheckBtn}
                  onClick={handleCheckUpdate}
                  disabled={checking}
                >
                  {checking ? '確認中...' : 'アップデートを確認'}
                </button>

                {checkResult && !checkResult.error && (
                  <div className={`${styles.settingsResult} ${checkResult.updateAvailable ? styles.settingsResultUpdate : styles.settingsResultOk}`}>
                    {checkResult.updateAvailable
                      ? `🚀 v${checkResult.latestVersion} が利用可能です！${checkResult.isBeta ? '（Beta）' : ''}`
                      : `✅ 最新版です（v${checkResult.currentVersion}）`
                    }
                  </div>
                )}
                {checkResult?.error && (
                  <div className={`${styles.settingsResult} ${styles.settingsResultError}`}>
                    ❌ {checkResult.error}
                  </div>
                )}
              </div>

              <div className={styles.settingsActions}>
                <button className={styles.settingsSaveBtn} onClick={handleSaveSettings}>保存</button>
                <button className={styles.settingsCloseBtn} onClick={() => setShowSettings(false)}>閉じる</button>
              </div>
            </div>
          </div>
        )}

        {/* Toast Notification */}
        {toast && (
          <div
            className={`${styles.toast} ${styles[toast.type === 'success' ? 'toastSuccess' : 'toastError']}`}
            onAnimationEnd={(e) => {
              if (e.animationName.includes('fadeOut') || e.animationName.includes('slideOut')) {
                setToast(null);
              }
            }}
          >
            <span>{toast.type === 'success' ? '✓' : '✕'}</span>
            <span>{toast.message}</span>
            <button className={styles.toastClose} onClick={() => setToast(null)}>×</button>
          </div>
        )}

        {/* Confirm Dialog */}
        {confirmDialog && (
          <div className={styles.modalOverlay}>
            <div className={styles.modalContent}>
              <h3 className={styles.modalTitle}>確認</h3>
              <p className={styles.modalText}>{confirmDialog.message}</p>
              <div className={styles.confirmActions}>
                <button className={styles.confirmCancelBtn} onClick={() => setConfirmDialog(null)}>
                  キャンセル
                </button>
                <button className={styles.confirmOkBtn} onClick={confirmDialog.onConfirm}>
                  OK
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
