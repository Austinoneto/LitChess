/**
 * ============================================================================
 * LITCHESS HYBRID STORAGE ADAPTER (PostgreSQL + Local Atomic JSON Fallback)
 * File: storage.js (Imported by server.js & social-server.js)
 * ============================================================================
 */

const fs = require('fs');
const { Pool } = require('pg');

let pool = null;
let usePostgres = false;
const saveQueues = new Map();

function getQueue(key) {
    if (!saveQueues.has(key)) saveQueues.set(key, Promise.resolve());
    return saveQueues.get(key);
}

async function init() {
    const dbUrl = (process.env.DATABASE_URL || '').trim();
    if (!dbUrl) {
        console.log('[STORAGE] DATABASE_URL not set — using local JSON files (ephemeral on Render free tier).');
        usePostgres = false;
        return;
    }

    try {
        const disableSsl = process.env.PGSSL === 'false' || dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');
        pool = new Pool({
            connectionString: dbUrl,
            ssl: disableSsl ? false : { rejectUnauthorized: false },
            max: 5,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000
        });

        await pool.query(`
            CREATE TABLE IF NOT EXISTS litchess_store (
                key TEXT PRIMARY KEY,
                data JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);

        usePostgres = true;
        console.log('[STORAGE] ✅ PostgreSQL connected — ratings & social data will persist across Render restarts.');
    } catch (err) {
        console.error('[STORAGE] ⚠️ PostgreSQL connection failed — falling back to local JSON:', err.message);
        usePostgres = false;
        if (pool) {
            try { await pool.end(); } catch (_) {}
            pool = null;
        }
    }
}

async function loadJSON(key, localFilePath, defaultValue) {
    if (usePostgres && pool) {
        try {
            const res = await pool.query('SELECT data FROM litchess_store WHERE key = $1', [key]);
            if (res.rows.length > 0 && res.rows[0].data) {
                return res.rows[0].data;
            }
            // One-time seed from local file if present on first boot
            if (localFilePath && fs.existsSync(localFilePath)) {
                const raw = await fs.promises.readFile(localFilePath, 'utf8');
                if (raw && raw.trim()) {
                    const parsed = JSON.parse(raw);
                    await saveJSON(key, localFilePath, parsed);
                    return parsed;
                }
            }
            return defaultValue;
        } catch (err) {
            console.error(`[STORAGE] PG load error for "${key}":`, err.message);
        }
    }

    // Local JSON fallback
    if (localFilePath && fs.existsSync(localFilePath)) {
        try {
            const raw = await fs.promises.readFile(localFilePath, 'utf8');
            if (raw && raw.trim()) {
                return JSON.parse(raw);
            }
        } catch (err) {
            console.error(`[STORAGE] Failed to parse local ${localFilePath}:`, err.message);
        }
    }

    return defaultValue;
}

function saveJSON(key, localFilePath, data) {
    // Snapshot immediately so later mutations don't tear mid-write
    const serialized = JSON.stringify(data, null, 2);

    const next = getQueue(key).then(async () => {
        if (usePostgres && pool) {
            try {
                await pool.query(
                    `INSERT INTO litchess_store (key, data, updated_at)
                     VALUES ($1, $2::jsonb, NOW())
                     ON CONFLICT (key)
                     DO UPDATE SET data = EXCLUDED.data, updated_at = NOW();`,
                    [key, serialized]
                );
                return;
            } catch (err) {
                console.error(`[STORAGE] PG save error for "${key}":`, err.message);
            }
        }

        if (localFilePath) {
            try {
                const tmp = localFilePath + '.tmp';
                await fs.promises.writeFile(tmp, serialized, 'utf8');
                await fs.promises.rename(tmp, localFilePath);
            } catch (err) {
                console.error(`[STORAGE] Local save error for "${key}":`, err.message);
            }
        }
    });

    saveQueues.set(key, next);
    return next;
}

function isPostgresEnabled() {
    return usePostgres;
}

module.exports = {
    init,
    loadJSON,
    saveJSON,
    isPostgresEnabled
};