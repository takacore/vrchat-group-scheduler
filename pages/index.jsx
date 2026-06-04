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
  const [showTrash, setShowTrash] = useState(false);
  const [groupRefreshing, setGroupRefreshing] = useState(false);
  const [refreshCooldown, setRefreshCooldown] = useState(0);
  const [showScanConfirm, setShowScanConfirm] = useState(false);
  const [scanProgress, setScanProgress] = useState(null); // { current, total, groupName, phase }
  const [toast, setToast] = useState(null); // { message, type: 'success'|'error' }
  const [confirmDialog, setConfirmDialog] = useState(null); // { message, onConfirm }

  // Form State
  const [groupId, setGroupId] = useState('');
  const [groups, setGroups] = useState([]);

  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [notification, setNotification] = useState(false);

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
      setAuthNeedLogin(true);
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
      setError('Failed to fetch groups: ' + err.message);
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

  const handleGroupChange = (e) => {
    const newGroupId = e.target.value;
    if (!newGroupId) {
      setGroupId('');
      return;
    }
    setGroupId(newGroupId);
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

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!groupId || !title || !text || !scheduledAt) return;
    setError('');

    // Prepare recurrence object
    let recurrence = null;
    if (isRecurring) {
      recurrence = {
        type: recurrenceType
      };
      if (recurrenceType === 'weekly') {
        if (recurrenceDays.length === 0) {
          setError('Please select at least one day for weekly recurrence.');
          return;
        }
        recurrence.days = recurrenceDays;
      }
    }

    try {
      const selectedGroup = groups.find(g => g.groupId === groupId);
      const res = await invokeBackend('posts:create', {
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
      });

      if (res) { // res is the new post object
        setTitle('');
        setText('');
        setScheduledAt('');
        setIsRecurring(false);
        setRecurrenceDays([]);
        setImageDataUrl('');
        setImageName('');
        setPostToX(false);
        setXText('');
        fetchPosts();
        setToast({ message: '投稿をスケジュールしました！', type: 'success' });
      }
    } catch (err) {
      setError('Error: ' + err.message);
    }
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

    setError('');
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
      <h2 style={{ color: '#fff', marginBottom: '1rem' }}>VRChatのログインが必要です</h2>
      <p style={{ color: '#a0aec0', marginBottom: '2rem' }}>
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
        style={{ padding: '0.6rem 1.5rem', fontSize: '1rem', backgroundColor: '#4a5568', width: 'auto' }}
        onClick={() => window.location.reload()}
      >
        ログイン後に再読み込み
      </button>
    </div>
  );
  if (!user) return null;

  return (
    <>
      <style dangerouslySetInnerHTML={{
        __html: `
        body { 
          margin: 0; 
          background-color: #1a202c; 
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
                fontSize: '0.9rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.4rem 0.8rem',
                background: '#2d3748',
                borderRadius: '6px',
                color: '#e2e8f0',
                fontWeight: 'bold',
                border: '1px solid #4a5568'
              }}
            >
              <span>↗️全画面</span>
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
                <span style={{ color: '#a0aec0', fontSize: '0.85rem' }}>
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
                    <span style={{ color: '#d69e2e', fontWeight: 'bold' }}>
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
                  <div style={{ background: '#1a202c', borderRadius: '3px', height: '4px', overflow: 'hidden' }}>
                    <div style={{ width: `${downloadProgress.percent}%`, height: '100%', background: '#48bb78', transition: 'width 0.3s ease', borderRadius: '3px' }} />
                  </div>
                  <span style={{ fontSize: '0.75rem', opacity: 0.8 }}>ダウンロード中... {downloadProgress.percent}%</span>
                </div>
              )}
            </div>
            <div className={styles.updateBannerActions}>
              {updateDownloaded ? (
                <button className={styles.updateDownloadBtn} onClick={handleInstallUpdate} style={{ backgroundColor: '#48bb78', color: '#1a202c' }}>
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
            <h2 className={styles.cardTitle}>New Scheduled Post</h2>
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
                      color: (groupRefreshing || refreshCooldown > 0) ? '#4a5568' : '#63b3ed',
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
                  style={{ color: '#e2e8f0', fontSize: '0.9rem' }}
                />
                <div style={{ fontSize: '0.7rem', color: '#d69e2e', marginTop: '0.25rem' }}>
                  ※ VRChat側の画像添付は VRC+ サブスクライブ必須で、最低 512×512px 程度必要です。条件外なら画像なしで投稿継続し、X同時投稿には影響しません。
                </div>
                {imageDataUrl && (
                  <div style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <img
                      src={imageDataUrl}
                      alt="preview"
                      style={{ maxWidth: '120px', maxHeight: '80px', borderRadius: '4px', border: '1px solid #4a5568' }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ color: '#a0aec0', fontSize: '0.8rem', wordBreak: 'break-all' }}>{imageName}</div>
                      <button
                        type="button"
                        onClick={() => { setImageDataUrl(''); setImageName(''); }}
                        style={{
                          marginTop: '0.3rem',
                          background: '#4a5568',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '3px',
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
                  <label htmlFor="recur" style={{ marginBottom: 0, color: '#fff', fontWeight: 'bold' }}>Repeat Schedule</label>
                </div>

                {isRecurring && (
                  <div style={{ marginLeft: '1.5rem', padding: '0.5rem', background: '#2d3748', borderRadius: '4px' }}>
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
                                background: recurrenceDays.includes(idx) ? '#63b3ed' : '#4a5568',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '3px',
                                padding: '0.3rem 0.5rem',
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
                    <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: '#a0aec0' }}>
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
                <label htmlFor="noti" style={{ marginBottom: 0, color: '#fff' }}>Send Notification to Group</label>
              </div>

              <div className={styles.formGroup}>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <input
                    type="checkbox"
                    id="postX"
                    checked={postToX}
                    onChange={e => setPostToX(e.target.checked)}
                  />
                  <label htmlFor="postX" style={{ marginBottom: 0, color: '#fff', fontWeight: 'bold' }}>X(Twitter)にも同時投稿</label>
                  <span
                    onClick={handleCheckXLogin}
                    style={{
                      marginLeft: 'auto',
                      color: xLoggedIn === true ? '#48bb78' : xLoggedIn === false ? '#f56565' : '#63b3ed',
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
                  <div style={{ marginLeft: '1.5rem', padding: '0.5rem', background: '#2d3748', borderRadius: '4px' }}>
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
                    <div style={{ fontSize: '0.75rem', color: '#a0aec0', textAlign: 'right' }}>
                      {(xText || `${title}\n\n${text}`).length} / 280
                    </div>
                    {imageDataUrl && (
                      <div style={{ fontSize: '0.75rem', color: '#90cdf4' }}>
                        ↑ アップロードした画像も同時に投稿します
                      </div>
                    )}
                    <div style={{ fontSize: '0.75rem', color: '#d69e2e', marginTop: '0.3rem' }}>
                      ※ ブラウザでX(Twitter)にログイン済みであることが必要です
                    </div>
                  </div>
                )}
              </div>

              <button type="submit" className={styles.button}>Schedule Post</button>
            </form>
          </section>

          <section className={styles.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h2 className={styles.cardTitle} style={{ marginBottom: 0 }}>
                {showTrash ? 'Trash Can' : 'Scheduled Queue'}
              </h2>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <button
                  className={styles.deleteBtn}
                  style={{ fontSize: '1rem', color: '#63b3ed', marginRight: '1rem' }}
                  onClick={fetchPosts}
                >Refresh</button>

                <button
                  className={`${styles.trashToggle} ${showTrash ? styles.trashToggleActive : ''}`}
                  onClick={() => setShowTrash(!showTrash)}
                >
                  {showTrash ? 'Show Queue' : 'Show Trash'}
                </button>
              </div>
            </div>

            <div className={styles.postList}>
              {posts.length === 0 && <p style={{ color: '#718096' }}>No posts found.</p>}
              {posts.map(post => (
                <div key={post.id} className={styles.postItem} style={post.status === 'recurring' ? { borderLeft: '4px solid #63b3ed', background: '#2a4365' } : {}}>
                  <div className={styles.postInfo}>
                    <div className={styles.postTitle}>
                      {post.status === 'recurring' && <span style={{ fontSize: '0.8rem', background: '#3182ce', padding: '2px 6px', borderRadius: '4px', marginRight: '6px' }}>Repeat</span>}
                      {post.imageDataUrl && <span style={{ fontSize: '0.75rem', background: '#48bb78', padding: '2px 6px', borderRadius: '4px', marginRight: '6px' }}>IMG</span>}
                      {post.postToX && <span style={{ fontSize: '0.75rem', background: '#1da1f2', padding: '2px 6px', borderRadius: '4px', marginRight: '6px' }}>X</span>}
                      {post.title}
                    </div>
                    <div className={styles.postMeta}>
                      {new Date(post.scheduledAt).toLocaleString()} • {post.groupName || post.groupId}
                      {post.recurrence && (
                        <div style={{ color: '#90cdf4', fontSize: '0.85rem', marginTop: '2px' }}>
                          ↻ {post.recurrence.type.charAt(0).toUpperCase() + post.recurrence.type.slice(1)}
                          {post.recurrence.type === 'weekly' && post.recurrence.days && ` (${post.recurrence.days.map(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')})`}
                        </div>
                      )}
                      {post.vrcImageError && (
                        <div style={{ color: '#fc8181', fontSize: '0.8rem', marginTop: '2px' }}>
                          画像添付失敗: {post.vrcImageError}
                        </div>
                      )}
                      {post.xError && (
                        <div style={{ color: '#fc8181', fontSize: '0.8rem', marginTop: '2px' }}>
                          X投稿失敗: {post.xError}
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <span className={`${styles.status} ${styles['status' + (post.status.charAt(0).toUpperCase() + post.status.slice(1))]}`}>
                      {post.status}
                    </span>

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
