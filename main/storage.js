import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';

// In production, app.getPath('userData') points to user's AppData/Application Support
// In dev (nextron), it points to default electron user data.
// We can use a subfolder 'data' inside userData to be clean.
const USER_DATA_PATH = app.getPath('userData');
const DATA_DIR = path.join(USER_DATA_PATH, 'data');

async function ensureDataDir() {
    try {
        await fs.access(DATA_DIR);
    } catch {
        await fs.mkdir(DATA_DIR, { recursive: true });
    }
}

export async function readJson(filename, defaultValue = null) {
    await ensureDataDir();
    const filePath = path.join(DATA_DIR, filename);
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return defaultValue;
        }
        throw error;
    }
}

export async function writeJson(filename, data) {
    await ensureDataDir();
    const filePath = path.join(DATA_DIR, filename);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}
