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

  // Form State
  const [groupId, setGroupId] = useState('');
  const [groups, setGroups] = useState([]);
  const [permissionChecking, setPermissionChecking] = useState(false);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [notification, setNotification] = useState(false);

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
    const unsubscribe = window.ipc.on('updater:update-available', (data) => {
      setUpdateInfo(data);
      setShowUpdateBanner(true);
    });

    return () => {
      if (unsubscribe) unsubscribe();
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

  const fetchGroups = async (userId) => {
    try {
      // IPC Call
      const data = await window.ipc.invoke('groups:get-all', { userId });
      // Sort: Owner first, then by name
      data.sort((a, b) => {
        if (a.isOwner && !b.isOwner) return -1;
        if (!a.isOwner && b.isOwner) return 1;
        return a.name.localeCompare(b.name);
      });
      setGroups(data);
    } catch (err) {
      console.error('Failed to fetch groups', err);
      setError('Failed to fetch groups: ' + err.message);
    }
  };

  const handleGroupChange = async (e) => {
    const newGroupId = e.target.value;
    if (!newGroupId) {
      setGroupId('');
      return;
    }

    const fullGroup = groups.find(g => g.groupId === newGroupId);
    if (!fullGroup) return;

    // Check Owner
    if (fullGroup.isOwner) {
      setGroupId(newGroupId);
      return;
    }

    // Not Owner -> Check Permissions via IPC
    setPermissionChecking(true);
    try {
      const canPost = await window.ipc.invoke('groups:check-permission', { groupId: newGroupId });
      if (canPost) {
        setGroupId(newGroupId);
      } else {
        setError('You do not have permission to post to this group (group-announcement-manage required).');
      }
    } catch (err) {
      console.error(err);
      setError('Failed to check permissions');
    } finally {
      setPermissionChecking(false);
    }
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

      // Sort: Pending first, then by date desc
      data.sort((a, b) => {
        if (a.status === 'pending' && b.status !== 'pending') return -1;
        if (a.status !== 'pending' && b.status === 'pending') return 1;
        return new Date(b.created_at) - new Date(a.created_at);
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

    try {
      const res = await window.ipc.invoke('posts:create', {
        groupId,
        title,
        text,
        scheduledAt: new Date(scheduledAt).toISOString(),
        sendNotification: notification
      });

      if (res) { // res is the new post object
        setTitle('');
        setText('');
        setScheduledAt('');
        fetchPosts();
        alert('Post scheduled!');
      }
    } catch (err) {
      setError('Error: ' + err.message);
    }
  };

  const handleDelete = async (id) => {
    const isTrash = showTrash;
    const msg = isTrash ? 'Permanently delete this post?' : 'Move this post to trash?';

    if (!confirm(msg)) return;
    try {
      await window.ipc.invoke('posts:delete', {
        id,
        force: isTrash
      });
      fetchPosts();
    } catch (err) {
      setError(err.message);
    }
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
        </div>
      </header>

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
                disabled={permissionChecking}
                required
              >
                <option value="" disabled>Select a group {permissionChecking ? '(Checking permissions...)' : ''}</option>
                {groups.map(g => (
                  <option key={g.id} value={g.groupId}>
                    {g.name} ({g.shortCode}) {g.isOwner ? '★' : ''}
                  </option>
                ))}
              </select>
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
              <label className={styles.label}>Schedule Time</label>
              <input
                type="datetime-local"
                className={styles.input}
                value={scheduledAt}
                onChange={e => setScheduledAt(e.target.value)}
                required
              />
            </div>

            <div className={styles.formGroup} style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                type="checkbox"
                id="noti"
                checked={notification}
                onChange={e => setNotification(e.target.checked)}
              />
              <label htmlFor="noti" style={{ marginBottom: 0, color: '#fff' }}>Send Notification</label>
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
              <div key={post.id} className={styles.postItem}>
                <div className={styles.postInfo}>
                  <div className={styles.postTitle}>{post.title}</div>
                  <div className={styles.postMeta}>
                    {new Date(post.scheduledAt).toLocaleString()} • {post.groupId}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <span className={`${styles.status} ${styles['status' + (post.status.charAt(0).toUpperCase() + post.status.slice(1))]}`}>
                    {post.status}
                  </span>

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
    </div>
  );
}
