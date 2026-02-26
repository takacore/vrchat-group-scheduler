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

  // Recurrence State
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurrenceType, setRecurrenceType] = useState('daily');
  const [recurrenceDays, setRecurrenceDays] = useState([]);

  useEffect(() => {
    checkAuth();
  }, []);

  // Fetch posts whenever showTrash changes
  useEffect(() => {
    if (user) {
      fetchPosts();
    }
  }, [showTrash, user]);

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
      const res = await window.ipc.invoke('posts:create', {
        groupId,
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
          <span className={styles.username}>{user.displayName}</span>
          <img src={user.userIcon || 'https://assets.vrchat.com/www/images/default_avatar.png'} className={styles.avatar} alt="Avatar" />
          <button onClick={handleLogout} className={styles.logoutBtn} style={{ marginLeft: '1rem', padding: '0.25rem 0.5rem', fontSize: '0.8rem', backgroundColor: '#e53e3e', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
            Logout
          </button>
        </div>
      </header>

      {error && (
        <div className={styles.errorBanner}>
          <span>{error}</span>
          <button className={styles.closeError} onClick={() => setError('')}>×</button>
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
                    {new Date(post.scheduledAt).toLocaleString()} • {post.groupId}
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
    </div>
  );
}
