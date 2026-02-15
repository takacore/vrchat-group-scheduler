import fs from 'fs/promises';
import path from 'path';
import { app, safeStorage } from 'electron';

function getDataDir() {
    return path.join(app.getPath('userData'), 'data');
}

async function ensureDataDir() {
    const dir = getDataDir();
    try {
        await fs.access(dir);
    } catch {
        await fs.mkdir(dir, { recursive: true });
    }
}

export async function readJson(filename, defaultValue = null, options = { encrypted: false }) {
    await ensureDataDir();
    const filePath = path.join(getDataDir(), filename);
    try {
        if (options.encrypted && safeStorage.isEncryptionAvailable()) {
            const buffer = await fs.readFile(filePath);
            const decrypted = safeStorage.decryptString(buffer);
            return JSON.parse(decrypted);
        } else {
            const data = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(data);
        }
    } catch (error) {
        // ENOENT: File not found
        // Other errors: Decryption failed, JSON parse error, etc.
        if (error.code === 'ENOENT') {
            return defaultValue;
        }
        console.error(`Failed to read/decrypt ${filename}:`, error);
        return defaultValue; // Return default if decryption/parsing fails
    }
}

export async function writeJson(filename, data, options = { encrypted: false }) {
    await ensureDataDir();
    const filePath = path.join(getDataDir(), filename);

    if (options.encrypted && safeStorage.isEncryptionAvailable()) {
        const jsonString = JSON.stringify(data);
        const encryptedBuffer = safeStorage.encryptString(jsonString);
        await fs.writeFile(filePath, encryptedBuffer);
    } else {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    }
}
