import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import styles from '../styles/Home.module.css';

export default function Dashboard() {
  const [user, setUser] = useState(null);
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

  // Update State
  const [updateInfo, setUpdateInfo] = useState(null);
  const [showUpdateBanner, setShowUpdateBanner] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [updateSettings, setUpdateSettings] = useState({ channel: 'stable', autoCheck: true });
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState(null);

  useEffect(() => {
    checkAuth();
    loadUpdateSettings();

    // Listen for auto-update notification from main process
    const unsubUpdate = window.ipc.on('updater:update-available', (data) => {
      setUpdateInfo(data);
      setShowUpdateBanner(true);
    });

    // Listen for group scan progress
    const unsubScan = window.ipc.on('groups:scan-progress', (data) => {
      setScanProgress(data);
    });

    return () => {
      if (unsubUpdate) unsubUpdate();
      if (unsubScan) unsubScan();
    };
  }, []);

  // Fetch posts whenever showTrash changes
  useEffect(() => {
    if (user) {
      fetchPosts();
    }
  }, [showTrash, user]);

  const loadUpdateSettings = async () => {
    try {
      const settings = await window.ipc.invoke('updater:get-settings');
      setUpdateSettings(settings);
    } catch (err) {
      console.error('Failed to load update settings:', err);
    }
  };

  const handleSaveSettings = async () => {
    try {
      const saved = await window.ipc.invoke('updater:save-settings', updateSettings);
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
      const result = await window.ipc.invoke('updater:check', { channel: updateSettings.channel });
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
    if (updateInfo?.downloadUrl) {
      await window.ipc.invoke('updater:open-download', { url: updateInfo.downloadUrl });
    }
  };

  const checkAuth = async () => {
    try {
      // IPC Call
      const userData = await window.ipc.invoke('auth:get-user');
      if (!userData) {
        router.push('/login');
        return;
      }
      setUser(userData);
      fetchGroups(userData.id); // Optimized: pass user id
      fetchPosts();
    } catch (err) {
      console.error(err);
      router.push('/login');
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
      const result = await window.ipc.invoke('groups:get-all', { userId });
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
      const result = await window.ipc.invoke('groups:refresh', { userId: user?.id });
      if (result.refreshed) {
        setGroups(sortGroups(result.groups));
        setRefreshCooldown(300);
      }
    } catch (err) {
      console.error('Failed to scan groups', err);
      setError('グループのスキャンに失敗しました: ' + err.message);
    } finally {
      setGroupRefreshing(false);
      setScanProgress(null);
    }
  };

  const handleRefreshGroups = async () => {
    if (groupRefreshing || refreshCooldown > 0) return;
    setGroupRefreshing(true);
    setScanProgress({ current: 0, total: 0, groupName: '', phase: 'fetching' });
    try {
      const result = await window.ipc.invoke('groups:refresh', { userId: user?.id });
      if (result.refreshed) {
        setGroups(sortGroups(result.groups));
        setRefreshCooldown(300);
      } else if (result.cooldownRemaining > 0) {
        setRefreshCooldown(result.cooldownRemaining);
        setGroups(sortGroups(result.groups));
      }
    } catch (err) {
      console.error('Failed to refresh groups', err);
      setError('グループの更新に失敗しました: ' + err.message);
    } finally {
      setGroupRefreshing(false);
      setScanProgress(null);
    }
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
      let data = await window.ipc.invoke('posts:get-all', {
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
      const res = await window.ipc.invoke('posts:create', {
        groupId,
        groupName: selectedGroup?.name || groupId,
        title,
        text,
        scheduledAt: new Date(scheduledAt).toISOString(),
        sendNotification: notification,
        recurrence,
        status: isRecurring ? 'recurring' : 'pending'
      });

      if (res) { // res is the new post object
        setTitle('');
        setText('');
        setScheduledAt('');
        setIsRecurring(false);
        setRecurrenceDays([]);
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
          await window.ipc.invoke('posts:delete', { id, force: isTrash });
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

    setError('');
  };

  const handleLogout = async () => {
    try {
      await window.ipc.invoke('auth:logout');
      router.push('/login');
    } catch (err) {
      console.error('Logout failed', err);
      setError('Logout failed: ' + err.message);
    }
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
  if (!user) return null;

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.title}>VRChat Scheduler (Local)</div>
        <div className={styles.userInfo}>
          <span className={styles.versionInfo}>v{updateInfo?.currentVersion || '1.0.0'}</span>
          <button
            className={styles.settingsBtn}
            onClick={() => setShowSettings(true)}
            title="設定"
          >
            ⚙
          </button>
          <span className={styles.username}>{user.displayName}</span>
          <img src={user.userIcon || 'https://assets.vrchat.com/www/images/default_avatar.png'} className={styles.avatar} alt="Avatar" />
          <button onClick={handleLogout} className={styles.logoutBtn} style={{ marginLeft: '1rem', padding: '0.25rem 0.5rem', fontSize: '0.8rem', backgroundColor: '#e53e3e', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
            Logout
          </button>
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
              v{updateInfo.currentVersion} → v{updateInfo.latestVersion}
              {updateInfo.releaseNotes && ` — ${updateInfo.releaseNotes.split('\n')[0].substring(0, 80)}`}
            </div>
          </div>
          <div className={styles.updateBannerActions}>
            <button className={styles.updateDownloadBtn} onClick={handleOpenDownload}>
              ダウンロード
            </button>
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
  );
}
