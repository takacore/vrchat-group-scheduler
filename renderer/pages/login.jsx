import { useState } from 'react';
import { useRouter } from 'next/router';
import styles from '../styles/Login.module.css';

export default function LoginPage() {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');
    const [step, setStep] = useState('login'); // 'login' or '2fa'
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const router = useRouter();

    const handleLogin = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            // IPC Call
            const data = await window.ipc.invoke('auth:login', { username, password });

            if (data.requiresTwoFactorAuth) {
                setStep('2fa');
            } else {
                router.push('/home'); // Go to home
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handleVerify = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            // IPC Call
            await window.ipc.invoke('auth:verify-2fa', { code });
            router.push('/home');
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className={styles.container}>
            <div className={styles.card}>
                <h1 className={styles.title}>VRChat Scheduler (Local)</h1>

                {step === 'login' ? (
                    <form onSubmit={handleLogin}>
                        <div className={styles.formGroup}>
                            <label className={styles.label}>Username / Email</label>
                            <input
                                className={styles.input}
                                type="text"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                required
                            />
                        </div>
                        <div className={styles.formGroup}>
                            <label className={styles.label}>Password</label>
                            <input
                                className={styles.input}
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                            />
                        </div>
                        <button className={styles.button} type="submit" disabled={loading}>
                            {loading ? 'Logging in...' : 'Login'}
                        </button>
                    </form>
                ) : (
                    <form onSubmit={handleVerify}>
                        <div className={styles.formGroup}>
                            <label className={styles.label}>2FA Code</label>
                            <input
                                className={styles.input}
                                type="text"
                                value={code}
                                onChange={(e) => setCode(e.target.value)}
                                placeholder="000000"
                                required
                            />
                        </div>
                        <button className={styles.button} type="submit" disabled={loading}>
                            {loading ? 'Verifying...' : 'Verify'}
                        </button>
                    </form>
                )}

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </div>
    );
}
