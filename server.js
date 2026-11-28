/**
 * ============================================================================
 * LITCHESS INSTITUTIONAL ZERO-TRUST ORACLE & WEB SERVER (server.js)
 * ============================================================================
 */

const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const crypto = require('crypto');
const ethers = require('ethers');
const { Chess } = require('chess.js');
const fs = require('fs');
const path = require('path');
const { createSocialServer } = require('./social-server');

// Built-in atomic JSON fallback adapter (guarantees storage is NEVER null)
const localJsonStorageFallback = {
    async initStorage() {},
    async loadJSON(_key, filePath, fallback = null) {
        try {
            if (filePath && fs.existsSync(filePath)) {
                const raw = await fs.promises.readFile(filePath, 'utf8');
                if (raw && raw.trim()) return JSON.parse(raw);
            }
        } catch (err) {
            console.warn(`[STORAGE] Local read warning (${path.basename(filePath)}):`, err.message);
        }
        return fallback;
    },
    async saveJSON(_key, filePath, data) {
        const tmp = filePath + '.tmp';
        await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
        await fs.promises.rename(tmp, filePath);
    }
};

let externalStorage = localJsonStorageFallback;
try {
    const loaded = require('./storage');
    if (loaded && typeof loaded.saveJSON === 'function' && typeof loaded.loadJSON === 'function') {
        externalStorage = loaded;
        console.log('[STORAGE] Loaded external storage.js adapter.');
    } else {
        console.warn('[STORAGE] storage.js missing loadJSON/saveJSON — using local JSON fallback.');
    }
} catch (err) {
    console.warn('[STORAGE] Could not load ./storage.js (' + err.message + ') — using local JSON fallback.');
}

// =====================================================================
// 0. BUILT-IN .ENV AUTO-LOADER (Handles .env and Windows .env.txt)
// =====================================================================
(function loadDotEnv() {
    const candidates = [path.join(__dirname, '.env'), path.join(__dirname, '.env.txt')];
    for (const envPath of candidates) {
        if (fs.existsSync(envPath)) {
            try {
                const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) continue;
                    const eqIdx = trimmed.indexOf('=');
                    if (eqIdx === -1) continue;
                    const key = trimmed.slice(0, eqIdx).trim();
                    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
                    if (key && !process.env[key]) {
                        process.env[key] = val;
                    }
                }
                console.log(`[CONFIG] Loaded environment variables from ${path.basename(envPath)}`);
                break;
            } catch (err) {
                console.warn(`[CONFIG] Could not read ${path.basename(envPath)}:`, err.message);
            }
        }
    }
})();

// =====================================================================
// 1. BLOCKCHAIN & ORACLE CONFIGURATION
// =====================================================================
const RPC_URL = (process.env.RPC_URL || "https://rpc.testnet.liteforge.zeeve.net").trim();
const CONTRACT_ADDRESS = ethers.getAddress((process.env.CONTRACT_ADDRESS || "0xb70B81A22cb63456c9f612B8F4d4082225F6afc4").trim());
const USERNAME_REGISTRY_ADDRESS = ethers.getAddress((process.env.USERNAME_REGISTRY_ADDRESS || "0x7ff44d488B5e75adF4ba35B9fbAca68ce9BE92AE").trim());

const provider = new ethers.JsonRpcProvider(RPC_URL);

const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY;
if (!SERVER_PRIVATE_KEY) {
    console.error('FATAL: SERVER_PRIVATE_KEY is not set in .env or environment.');
    console.error('Add it to .env (local) or the Render dashboard (production).');
    process.exit(1);
}
if (!/^0x[0-9a-fA-F]{64}$/.test(SERVER_PRIVATE_KEY)) {
    console.error('FATAL: SERVER_PRIVATE_KEY is malformed.');
    console.error('Expected: 0x followed by 64 hex chars. Got:', SERVER_PRIVATE_KEY.length, 'chars.');
    process.exit(1);
}

const serverWallet = new ethers.Wallet(SERVER_PRIVATE_KEY, provider);
console.log('🔑 Oracle wallet loaded:', serverWallet.address);

const CONTRACT_ABI = [
    "function resolveMatch(bytes32 _matchId, address _winner) external",
    "function serverAbortMatch(bytes32 _matchId) external",
    "function resolveTournament(bytes32 _tourneyId, address _winner) external",
    "function matches(bytes32) external view returns (bytes32 matchId, address playerWhite, address playerBlack, uint256 wagerAmount, uint8 status, uint256 lastMoveTimestamp, uint8 timeControl)",
    "function tournaments(bytes32) external view returns (bytes32 tourneyId, uint256 entryFee, uint256 totalPot, address creator, bool isActive)",
    "function tournamentParticipants(bytes32, address) external view returns (bool)"
];
const escrowContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, serverWallet);

const USERNAME_REGISTRY_ABI = [
    "function getUsername(address _user) external view returns (string)"
];
const usernameRegistry = new ethers.Contract(USERNAME_REGISTRY_ADDRESS, USERNAME_REGISTRY_ABI, provider);

const RESTRICTED_WORDS = ["fool", "idiot", "you're are crazy", "nonsense", "shit", "kill", "nigga", "cunt"];
const GENERIC_NAMES = new Set(['', 'player', 'guest', 'opponent', 'white', 'black', 'you', 'anon', 'anonymous']);

function ensureBytes32(id) {
    if (!id) return ethers.ZeroHash;
    let cleanId = id.toString().trim();
    if (!cleanId.startsWith('0x')) {
        cleanId = '0x' + cleanId;
    }
    if (cleanId.length > 66) {
        cleanId = cleanId.slice(0, 66);
    }
    return ethers.zeroPadValue(cleanId, 32);
}

// =====================================================================
// CROSS-VERSION CHESS.JS COMPATIBILITY & FIDE MATERIAL VERIFIER
// =====================================================================
function chessIsGameOver(c) {
    if (typeof c.isGameOver === 'function') return c.isGameOver();
    if (typeof c.game_over === 'function') return c.game_over();
    return false;
}

function chessIsCheckmate(c) {
    if (typeof c.isCheckmate === 'function') return c.isCheckmate();
    if (typeof c.in_checkmate === 'function') return c.in_checkmate();
    return false;
}

function chessIsStalemate(c) {
    if (typeof c.isStalemate === 'function') return c.isStalemate();
    if (typeof c.in_stalemate === 'function') return c.in_stalemate();
    return false;
}

function chessIsThreefold(c) {
    if (typeof c.isThreefoldRepetition === 'function') return c.isThreefoldRepetition();
    if (typeof c.in_threefold_repetition === 'function') return c.in_threefold_repetition();
    return false;
}

function chessIsInsufficient(c) {
    if (typeof c.isInsufficientMaterial === 'function') return c.isInsufficientMaterial();
    if (typeof c.insufficient_material === 'function') return c.insufficient_material();
    return false;
}

function getChessGameEndReason(c) {
    if (chessIsCheckmate(c)) return 'checkmate';
    if (chessIsStalemate(c)) return 'stalemate';
    if (chessIsThreefold(c)) return 'threefold_repetition';
    if (chessIsInsufficient(c)) return 'insufficient_material';
    return 'fifty_move_rule';
}

/**
 * FIDE Article 6.9: If a player flags on time, the opponent only wins if the opponent
 * has sufficient mating material (at least a Pawn, Rook, Queen, 2 Bishops, Bishop+Knight, or 3 Knights).
 */
function hasSufficientMatingMaterial(chessInstance, color) {
    const b = chessInstance.board();
    let pawns = 0, rooks = 0, queens = 0, bishops = 0, knights = 0;
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const p = b[r][c];
            if (!p || p.color !== color) continue;
            if (p.type === 'p') pawns++;
            else if (p.type === 'r') rooks++;
            else if (p.type === 'q') queens++;
            else if (p.type === 'b') bishops++;
            else if (p.type === 'n') knights++;
        }
    }
    if (pawns > 0 || rooks > 0 || queens > 0) return true;
    if (bishops >= 2) return true;
    if (bishops >= 1 && knights >= 1) return true;
    if (knights >= 3) return true;
    return false;
}

console.log("=====================================================");
console.log("🛡️  LITCHESS INSTITUTIONAL ZERO-TRUST ORACLE ACTIVE");
console.log("🔑 Oracle Wallet    :", serverWallet.address);
console.log("📜 Escrow Contract  :", CONTRACT_ADDRESS);
console.log("🪪 Username Registry:", USERNAME_REGISTRY_ADDRESS);
console.log("🌐 RPC Endpoint     :", RPC_URL);
console.log("=====================================================");

// =====================================================================
// 2. FAULT-TOLERANT PERSISTENT RATINGS & STATS ENGINE (PG / JSON)
// =====================================================================
const RATINGS_FILE = path.join(__dirname, 'ratings.json');
let playerRatings = {};
let totalGamesPlayedCount = 24837;
let saveChain = Promise.resolve();
const usernameToAddress = new Map();

// Unified storage wrapper that seamlessly works with any storage.js export shape
// OR falls back to local atomic JSON files.
async function initExternalStorage() {
    if (!externalStorage) return;
    const initFn = externalStorage.initStorage || externalStorage.init || externalStorage.initDb || externalStorage.connect;
    if (typeof initFn === 'function') {
        try {
            await initFn();
        } catch (err) {
            console.warn('[STORAGE] External storage init warning:', err.message);
        }
    }
}

async function storageLoadRatingsDoc() {
    try {
        const doc = await externalStorage.loadJSON('ratings', RATINGS_FILE, null);
        if (doc && typeof doc === 'object') return doc;
    } catch (err) {
        console.warn('[RATINGS] Storage read failed, falling back to local file:', err.message);
    }
    if (fs.existsSync(RATINGS_FILE)) {
        const raw = await fs.promises.readFile(RATINGS_FILE, 'utf8');
        if (raw && raw.trim()) return JSON.parse(raw);
    }
    return null;
}

async function storageSaveRatingsDoc(payload) {
    try {
        await externalStorage.saveJSON('ratings', RATINGS_FILE, payload);
        return;
    } catch (err) {
        console.warn('[RATINGS] Storage save failed, falling back to local file:', err.message);
    }
    const tmp = RATINGS_FILE + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await fs.promises.rename(tmp, RATINGS_FILE);
}

async function loadRatings() {
    try {
        const parsed = await storageLoadRatingsDoc();
        if (!parsed) {
            playerRatings = {};
            await saveRatings();
            return;
        }
        const clone = { ...parsed };
        if (clone._meta && typeof clone._meta.totalGames === 'number') {
            totalGamesPlayedCount = clone._meta.totalGames;
            delete clone._meta;
        }
        playerRatings = clone;
        for (const [addr, record] of Object.entries(playerRatings)) {
            if (record && record.username && !GENERIC_NAMES.has(String(record.username).toLowerCase())) {
                usernameToAddress.set(String(record.username).toLowerCase(), addr.toLowerCase());
            }
        }
        console.log(`[RATINGS] Loaded ${Object.keys(playerRatings).length} player rating records.`);
    } catch (e) {
        console.error("[RATINGS] Failed to load ratings – initializing clean store.", e.message);
        playerRatings = {};
        await saveRatings();
    }
}

async function saveRatings() {
    try {
        saveChain = saveChain.then(async () => {
            const payload = {
                _meta: { totalGames: totalGamesPlayedCount, updatedAt: Date.now() },
                ...playerRatings
            };
            await storageSaveRatingsDoc(payload);
        });
        await saveChain;
    } catch (e) {
        console.error("[RATINGS] Save failed:", e.message);
    }
}

function ensurePlayerRecord(addr) {
    addr = String(addr).toLowerCase();
    if (!playerRatings[addr]) {
        playerRatings[addr] = {
            bullet: 2000,
            blitz: 2000,
            rapid: 2000,
            gamesPlayed: 0,
            wins: 0,
            draws: 0,
            losses: 0,
            username: null
        };
    }
    return playerRatings[addr];
}

function ratingBucketForFormat(format) {
    const f = String(format || 'blitz').toLowerCase();
    if (f.startsWith('bullet')) return 'bullet';
    if (f.startsWith('rapid')) return 'rapid';
    return 'blitz';
}

function getRating(addr, format) {
    const rec = ensurePlayerRecord(addr);
    const bucket = ratingBucketForFormat(format);
    return rec[bucket] || 2000;
}

function setRating(addr, format, value) {
    const rec = ensurePlayerRecord(addr);
    const bucket = ratingBucketForFormat(format);
    rec[bucket] = Math.max(100, Math.round(value));
}

function getRatingsObject(addr) {
    const rec = ensurePlayerRecord(addr);
    return {
        bullet: rec.bullet || 2000,
        blitz: rec.blitz || 2000,
        rapid: rec.rapid || 2000,
        gamesPlayed: rec.gamesPlayed || 0,
        wins: rec.wins || 0,
        draws: rec.draws || 0,
        losses: rec.losses || 0
    };
}

// =====================================================================
// TIME CONTROL CONFIGURATION (Standard Lichess / Chess.com Formats)
// Default Blitz is 3+0 (zero surprise increment); 3+2 & 5+0 explicitly available
// =====================================================================
const tcMap = {
    bullet:   { time: 60,  inc: 0, name: 'bullet',   ratingBucket: 'bullet' },
    blitz:    { time: 180, inc: 0, name: 'blitz',    ratingBucket: 'blitz'  },
    blitz3_2: { time: 180, inc: 2, name: 'blitz3_2', ratingBucket: 'blitz'  },
    blitz5:   { time: 300, inc: 0, name: 'blitz5',   ratingBucket: 'blitz'  },
    rapid:    { time: 600, inc: 0, name: 'rapid',    ratingBucket: 'rapid'  }
};

function getTimeControlConfig(nameOrKey) {
    const key = String(nameOrKey || 'blitz').toLowerCase();
    return tcMap[key] || tcMap.blitz;
}

function getTimeControlFromIndex(index) {
    const byIndex = {
        0: tcMap.bullet,
        1: tcMap.blitz,
        2: tcMap.rapid,
        3: tcMap.blitz3_2,
        4: tcMap.blitz5
    };
    return byIndex[Number(index)] || tcMap.blitz;
}

const paidMatchTcHints = new Map();
function registerMatchTcHint(matchId, tcName) {
    if (!matchId || !tcName) return;
    const cfg = tcMap[String(tcName).toLowerCase()];
    if (!cfg) return;
    const cleanId = ensureBytes32(matchId).toLowerCase();
    paidMatchTcHints.set(cleanId, cfg.name);
    if (paidMatchTcHints.size > 4000) {
        const firstKey = paidMatchTcHints.keys().next().value;
        if (firstKey) paidMatchTcHints.delete(firstKey);
    }
}

async function fetchUsername(address) {
    if (!address) return null;
    const cleanAddr = String(address).toLowerCase();
    const rec = ensurePlayerRecord(cleanAddr);
    try {
        const name = await usernameRegistry.getUsername(address);
        if (name && name.trim().length > 0) {
            rec.username = name.trim();
            usernameToAddress.set(rec.username.toLowerCase(), cleanAddr);
            return rec.username;
        }
    } catch (_) {}
    if (rec.username && !GENERIC_NAMES.has(rec.username.toLowerCase())) return rec.username;
    return address.slice(0, 6) + "..." + address.slice(-4);
}

async function resolveParticipantName(rawName, wallet, guestId, sessionId) {
    if (wallet && ethers.isAddress(wallet)) {
        const onChain = await fetchUsername(wallet);
        if (onChain && !GENERIC_NAMES.has(onChain.toLowerCase())) return onChain;
    }
    const cleaned = String(rawName || '').trim().slice(0, 24);
    if (cleaned && !GENERIC_NAMES.has(cleaned.toLowerCase())) {
        return cleaned;
    }
    const seed = String(guestId || sessionId || crypto.randomBytes(2).toString('hex'))
        .replace(/[^a-zA-Z0-9]/g, '');
    const suffix = (seed.slice(-4) || crypto.randomBytes(2).toString('hex')).toUpperCase();
    return `Guest_${suffix}`;
}

function normalizeGuestId(rawGuestId, fallbackSessionId) {
    const cleaned = String(rawGuestId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
    if (cleaned.length >= 4) return cleaned;
    return 'guest_' + String(fallbackSessionId || crypto.randomBytes(4).toString('hex')).slice(0, 12);
}

// =====================================================================
// 3. UNIFIED HTTP STATIC SERVER + WEBSOCKET SERVER (PORT 8080)
// =====================================================================
const PORT = parseInt(process.env.PORT || '8080', 10);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
if (ALLOWED_ORIGINS.length === 0) {
    console.log('[SECURITY] ALLOWED_ORIGINS not set – accepting connections from any Origin (Dev Mode).');
}

const MAX_CONN_PER_IP = 30;
const MAX_ROOMS = 2000;
const MAX_QUEUE_PER_TC = 500;
const MAX_LAG_COMP_MS = 300;
const DEFAULT_LAG_COMP_MS = 80;
const OPENING_ABORT_SECONDS = 42; // 42s per opening ply once both players have joined

const connsPerIp = new Map();
const rooms = new Map();
const tournaments = new Map();
const freeQueues = { bullet: [], blitz: [], blitz3_2: [], blitz5: [], rapid: [] };
const clientMessageCounts = new Map();

function evictCompletedRoomsIfNeeded() {
    if (rooms.size < MAX_ROOMS) return;
    for (const [id, r] of rooms.entries()) {
        if (r.gameEnded) {
            rooms.delete(id);
            if (rooms.size < MAX_ROOMS) return;
        }
    }
}

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.wav': 'image/wav',
    '.ico': 'image/x-icon'
};

const httpServer = http.createServer((req, res) => {
    const cleanUrl = (req.url || '/').split('?')[0];

    if (cleanUrl === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('ok');
        return;
    }

    let safeRelPath = path.normalize(cleanUrl).replace(/^(\.\.[\/\\])+/, '');
    if (safeRelPath === '/' || safeRelPath === '\\') {
        safeRelPath = 'index.html';
    } else {
        safeRelPath = safeRelPath.replace(/^[\/\\]+/, '');
    }

    let filePath = path.join(__dirname, safeRelPath);

    if (!fs.existsSync(filePath)) {
        if (safeRelPath.startsWith('public' + path.sep) || safeRelPath.startsWith('public/')) {
            const stripped = safeRelPath.replace(/^public[\/\\]/, '');
            const rootCandidate = path.join(__dirname, stripped);
            if (fs.existsSync(rootCandidate)) filePath = rootCandidate;
        } else {
            const publicCandidate = path.join(__dirname, 'public', safeRelPath);
            if (fs.existsSync(publicCandidate)) filePath = publicCandidate;
        }
    }

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Not Found');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
        });
        res.end(content);
    });
});

const server = new WebSocket.Server({
    server: httpServer,
    maxPayload: 64 * 1024,
    verifyClient: (info) => ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(info.origin)
});

function checkRateLimit(ws) {
    const now = Date.now();
    const key = ws._rateLimitKey;
    if (!key) return true;
    const entry = clientMessageCounts.get(key);
    if (!entry || now - entry.start > 1000) {
        clientMessageCounts.set(key, { count: 1, start: now });
        return true;
    }
    entry.count++;
    return entry.count <= 40;
}

function sendSafe(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
        } catch (_) {}
    }
}

function broadcastToRoom(matchId, payload, excludeWs = null) {
    const room = rooms.get(matchId);
    if (!room) return;
    const serialized = JSON.stringify(payload);
    room.clients.forEach((client) => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            sendSafe(client, serialized);
        }
    });
}

function broadcastToSpectators(matchId, payload, excludeWs = null) {
    const room = rooms.get(matchId);
    if (!room) return;
    const serialized = JSON.stringify(payload);
    room.clients.forEach((client) => {
        if (
            client !== excludeWs &&
            client.readyState === WebSocket.OPEN &&
            room.spectators.has(client.sessionId)
        ) {
            sendSafe(client, serialized);
        }
    });
}

// =====================================================================
// AUTHORITATIVE MILLISECOND CLOCK ENGINE (ZERO DRIFT, SYMMETRICAL INC)
// =====================================================================
function getLiveClocksMs(room, now = Date.now()) {
    let whiteMs = room.whiteTimeMs ?? ((room.whiteTime ?? 180) * 1000);
    let blackMs = room.blackTimeMs ?? ((room.blackTime ?? 180) * 1000);

    const clocksActive = !room.gameEnded &&
        !chessIsGameOver(room.chess) &&
        room.chess.history().length >= 2 &&
        typeof room.turnStartedAt === 'number';

    if (clocksActive) {
        const elapsed = Math.max(0, now - room.turnStartedAt);
        if (room.chess.turn() === 'w') {
            whiteMs = Math.max(0, whiteMs - elapsed);
        } else {
            blackMs = Math.max(0, blackMs - elapsed);
        }
    }

    return { whiteMs, blackMs, clocksActive };
}

function msToSeconds(ms) {
    return Math.max(0, Number((ms / 1000).toFixed(1)));
}

function getRoomPlayerNames(room) {
    let whiteUser = room.whiteUsername || 'White';
    let blackUser = room.blackUsername || 'Black';
    for (const [, p] of room.players) {
        if (p.color === 'w' && p.username && !GENERIC_NAMES.has(p.username.toLowerCase())) {
            whiteUser = p.username;
        }
        if (p.color === 'b' && p.username && !GENERIC_NAMES.has(p.username.toLowerCase())) {
            blackUser = p.username;
        }
    }
    return { whiteUser, blackUser };
}

function buildGameStateSnapshot(room) {
    const now = Date.now();
    const { whiteMs, blackMs, clocksActive } = getLiveClocksMs(room, now);
    const { whiteUser, blackUser } = getRoomPlayerNames(room);
    const verboseHistory = room.chess.history({ verbose: true });

    return {
        type: 'GAME_STATE',
        fen: room.chess.fen(),
        moves: verboseHistory.map(m => ({ from: m.from, to: m.to, promotion: m.promotion || 'q', san: m.san })),
        turn: room.chess.turn(),
        whiteTime: msToSeconds(whiteMs),
        blackTime: msToSeconds(blackMs),
        clocksActive,
        inc: room.inc || 0,
        serverNow: now,
        whiteWallet: room.whiteWallet,
        blackWallet: room.blackWallet,
        whiteUsername: whiteUser,
        blackUsername: blackUser,
        whiteRatings: room.whiteWallet ? getRatingsObject(room.whiteWallet) : { bullet: 2000, blitz: 2000, rapid: 2000 },
        blackRatings: room.blackWallet ? getRatingsObject(room.blackWallet) : { bullet: 2000, blitz: 2000, rapid: 2000 },
        isPaidMode: room.isPaidMode,
        timeControlName: room.timeControlName,
        gameEnded: room.gameEnded,
        spectatorCount: Math.max(0, room.clients.size - room.players.size)
    };
}

/**
 * Synchronizes opponent usernames, colors, wallets, and Elo ratings across both players in a room.
 */
function syncRoomPlayerIdentities(room) {
    if (!room) return;
    for (const [, p] of room.players) {
        const oppEntry = [...room.players.entries()].find(([, other]) => other !== p);
        if (oppEntry) {
            const [oppSid, opp] = oppEntry;
            if (opp && opp.username) {
                sendSafe(p.ws, {
                    type: 'USER_INFO',
                    fromClientId: oppSid,
                    username: opp.username,
                    wallet: opp.wallet || null,
                    color: opp.color,
                    ratings: opp.wallet ? getRatingsObject(opp.wallet) : { bullet: 2000, blitz: 2000, rapid: 2000 }
                });
            }
        }
    }
}

// =====================================================================
// 3B. ROOM FACTORY & SOCIAL SERVER ENGINE HOOKUP
// =====================================================================
function createRoomInstance(matchId, overrides = {}) {
    const initialSec = overrides.whiteTime ?? 180;
    const initialInc = overrides.inc ?? 0;
    return {
        matchId,
        clients: new Set(),
        players: new Map(),
        spectators: new Set(),
        chess: new Chess(),
        idleTime: 0,
        txPending: false,
        isPaidMode: false,
        isFreeMode: false,
        onChainVerified: false,
        challengePendingOpponent: false,
        whiteWallet: null,
        blackWallet: null,
        whiteGuestId: null,
        blackGuestId: null,
        whiteUsername: null,
        blackUsername: null,
        wagerEth: 0,
        whiteTime: initialSec,
        blackTime: initialSec,
        whiteTimeMs: initialSec * 1000,
        blackTimeMs: initialSec * 1000,
        inc: initialInc,
        incMs: initialInc * 1000,
        turnStartedAt: null,
        lastSyncBroadcastAt: 0,
        openingTimerStart: null,
        nonces: new Map(),
        drawOfferFrom: null,
        takebackOffer: null,
        moveIncHistory: [],
        requestedTimeControlName: null,
        timeControlName: 'blitz',
        gameEnded: false,
        createdAt: Date.now(),
        ...overrides
    };
}

const social = createSocialServer({
    rooms,
    playerRatings,
    usernameToAddress,
    ensurePlayerRecord,
    getRatingsObject,
    fetchUsername,
    sendSafe,
    RESTRICTED_WORDS,
    storage: externalStorage,
    registerMatchTcHint,
    createDirectFreeRoom: ({ whiteWallet, blackWallet, timeControl }) => {
        evictCompletedRoomsIfNeeded();
        const tcCfg = getTimeControlConfig(timeControl);
        const matchId = "0x" + crypto.randomBytes(32).toString('hex');
        const room = createRoomInstance(matchId, {
            isPaidMode: false,
            isFreeMode: true,
            whiteTime: tcCfg.time,
            blackTime: tcCfg.time,
            whiteTimeMs: tcCfg.time * 1000,
            blackTimeMs: tcCfg.time * 1000,
            inc: tcCfg.inc,
            incMs: tcCfg.inc * 1000,
            timeControlName: tcCfg.name,
            whiteWallet: whiteWallet || null,
            blackWallet: blackWallet || null,
            openingTimerStart: null
        });
        rooms.set(matchId, room);
        return matchId;
    }
});

// =====================================================================
// 4. ELO RATING & MATCH STATISTICS ENGINE
// =====================================================================
async function updateRatingsAfterGame(whiteWallet, blackWallet, winnerWallet, room) {
    totalGamesPlayedCount++;
    if (!whiteWallet || !blackWallet) {
        await saveRatings();
        return null;
    }
    const cleanWhite = whiteWallet.toLowerCase();
    const cleanBlack = blackWallet.toLowerCase();
    const format = ratingBucketForFormat(room.timeControlName);

    const recW = ensurePlayerRecord(cleanWhite);
    const recB = ensurePlayerRecord(cleanBlack);

    const R_white = getRating(cleanWhite, format);
    const R_black = getRating(cleanBlack, format);
    const K = 24;
    let scoreWhite = 0.5;
    let scoreBlack = 0.5;

    recW.gamesPlayed = (recW.gamesPlayed || 0) + 1;
    recB.gamesPlayed = (recB.gamesPlayed || 0) + 1;

    if (!winnerWallet || winnerWallet === ethers.ZeroAddress) {
        scoreWhite = 0.5;
        scoreBlack = 0.5;
        recW.draws = (recW.draws || 0) + 1;
        recB.draws = (recB.draws || 0) + 1;
    } else if (winnerWallet.toLowerCase() === cleanWhite) {
        scoreWhite = 1;
        scoreBlack = 0;
        recW.wins = (recW.wins || 0) + 1;
        recB.losses = (recB.losses || 0) + 1;
    } else {
        scoreWhite = 0;
        scoreBlack = 1;
        recW.losses = (recW.losses || 0) + 1;
        recB.wins = (recB.wins || 0) + 1;
    }

    const expectedWhite = 1 / (1 + Math.pow(10, (R_black - R_white) / 400));
    const expectedBlack = 1 - expectedWhite;
    const newWhite = Math.round(R_white + K * (scoreWhite - expectedWhite));
    const newBlack = Math.round(R_black + K * (scoreBlack - expectedBlack));

    setRating(cleanWhite, format, newWhite);
    setRating(cleanBlack, format, newBlack);
    await saveRatings();

    for (const [, player] of room.players) {
        if (player.wallet) {
            sendSafe(player.ws, {
                type: 'RATINGS_UPDATED',
                ratings: getRatingsObject(player.wallet)
            });
        }
    }

    return { oldWhite: R_white, newWhite, oldBlack: R_black, newBlack };
}

function recordRoomOutcomeToSocial(room, matchId, winnerColor, winnerWallet, reason, ratingDelta = null) {
    try {
        const snap = buildGameStateSnapshot(room);
        social.recordMatchCompleted({
            matchId,
            whiteWallet: room.whiteWallet,
            blackWallet: room.blackWallet,
            whiteUsername: snap.whiteUsername,
            blackUsername: snap.blackUsername,
            winnerWallet,
            winnerColor,
            reason,
            timeControl: ratingBucketForFormat(room.timeControlName),
            isPaid: room.isPaidMode,
            wagerEth: room.wagerEth || 0,
            pgn: typeof room.chess.pgn === 'function' ? room.chess.pgn() : '',
            moveCount: room.chess.history().length,
            oldWhiteRating: ratingDelta ? ratingDelta.oldWhite : null,
            newWhiteRating: ratingDelta ? ratingDelta.newWhite : null,
            oldBlackRating: ratingDelta ? ratingDelta.oldBlack : null,
            newBlackRating: ratingDelta ? ratingDelta.newBlack : null
        });
    } catch (e) {
        console.warn('[SOCIAL] Failed to record match history:', e.message);
    }
}

// =====================================================================
// 5. SEQUENTIAL TRANSACTION RELAYER (RESOLVE + ABORT + TOURNEY)
// =====================================================================
class TransactionRelayer {
    constructor(wallet) {
        this.wallet = wallet;
        this.queue = [];
        this.isProcessing = false;
        this.localNonce = null;
    }

    enqueueResolve(matchId, winnerWallet, room, winnerColor = null, reason = 'completed') {
        this.queue.push({ action: 'RESOLVE', matchId, winnerWallet, room, winnerColor, reason });
        this.processQueue();
    }

    enqueueAbort(matchId, room) {
        this.queue.push({ action: 'ABORT', matchId, room });
        this.processQueue();
    }

    enqueueTourneyResolve(tourneyId, winnerWallet, tourney) {
        this.queue.push({ action: 'TOURNEY_RESOLVE', matchId: ethers.id(tourneyId), winnerWallet, tourney });
        this.processQueue();
    }

    async processQueue() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;

        const job = this.queue.shift();
        const { action, matchId, winnerWallet, room, tourney, winnerColor, reason } = job;
        const cleanMatchId = ensureBytes32(matchId);
        const maxRetries = 3;
        let attempt = 0;

        while (attempt < maxRetries) {
            try {
                if (action !== 'TOURNEY_RESOLVE') {
                    try {
                        const mData = await escrowContract.matches(cleanMatchId);
                        const statusNum = Number(mData.status);
                        if (statusNum === 2 || statusNum === 3) {
                            console.log(`[RELAYER] Match ${cleanMatchId} already settled/aborted on-chain (status=${statusNum}).`);
                            if (action === 'ABORT') {
                                broadcastToRoom(matchId, { type: 'MATCH_ABORTED' });
                            }
                            break;
                        }
                    } catch (_) {}
                }

                if (this.localNonce === null) {
                    this.localNonce = await this.wallet.provider.getTransactionCount(this.wallet.address, 'pending');
                }

                let tx;
                if (action === 'ABORT') {
                    console.log(`[RELAYER] Submitting serverAbortMatch for ${cleanMatchId} (nonce ${this.localNonce})`);
                    tx = await escrowContract.serverAbortMatch(cleanMatchId, {
                        nonce: this.localNonce,
                        gasLimit: 250000
                    });
                } else if (action === 'TOURNEY_RESOLVE') {
                    console.log(`[RELAYER] Submitting resolveTournament for ${cleanMatchId} -> Winner: ${winnerWallet} (nonce ${this.localNonce})`);
                    tx = await escrowContract.resolveTournament(cleanMatchId, winnerWallet, {
                        nonce: this.localNonce,
                        gasLimit: 300000
                    });
                } else {
                    const targetWinner = winnerWallet || ethers.ZeroAddress;
                    console.log(`[RELAYER] Submitting resolveMatch for ${cleanMatchId} -> Winner: ${targetWinner} (nonce ${this.localNonce})`);
                    tx = await escrowContract.resolveMatch(cleanMatchId, targetWinner, {
                        nonce: this.localNonce,
                        gasLimit: 300000
                    });
                }

                if (action !== 'TOURNEY_RESOLVE') {
                    broadcastToRoom(matchId, {
                        type: 'TX_SUBMITTED',
                        action,
                        txHash: tx.hash
                    });
                }

                const receipt = await tx.wait();
                this.localNonce++;
                console.log(`[RELAYER] Confirmed (${action}): ${receipt.hash}`);

                if (action === 'ABORT') {
                    broadcastToRoom(matchId, {
                        type: 'MATCH_ABORTED',
                        txHash: receipt.hash
                    });
                } else if (action === 'TOURNEY_RESOLVE' && tourney) {
                    tourney.players.forEach(p => {
                        sendSafe(p.ws, {
                            type: 'TX_SETTLED',
                            txHash: receipt.hash,
                            winnerWallet
                        });
                    });
                } else {
                    broadcastToRoom(matchId, {
                        type: 'TX_SETTLED',
                        txHash: receipt.hash,
                        winnerWallet: winnerWallet || ethers.ZeroAddress
                    });
                    if (room && room.isPaidMode && room.whiteWallet && room.blackWallet) {
                        const delta = await updateRatingsAfterGame(room.whiteWallet, room.blackWallet, winnerWallet || ethers.ZeroAddress, room);
                        recordRoomOutcomeToSocial(room, matchId, winnerColor, winnerWallet || ethers.ZeroAddress, reason, delta);
                    }
                }
                break;
            } catch (err) {
                attempt++;
                this.localNonce = null;
                console.error(`[RELAYER] Attempt ${attempt}/${maxRetries} failed for ${action} (${cleanMatchId}):`, err.shortMessage || err.message);
                if (attempt >= maxRetries) {
                    if (room) {
                        room.txPending = false;
                        broadcastToRoom(matchId, {
                            type: 'ERROR',
                            reason: `On-chain ${action.toLowerCase()} failed after ${maxRetries} retries.`
                        });
                    }
                } else {
                    await new Promise(r => setTimeout(r, 2000 * attempt));
                }
            }
        }

        this.isProcessing = false;
        this.processQueue();
    }
}

const relayer = new TransactionRelayer(serverWallet);

// =====================================================================
// 6. ON-CHAIN ROOM VERIFIER & 250ms AUTHORITATIVE CLOCK WATCHDOG
// =====================================================================
async function verifyPaidRoomOnChain(room, matchId, maxAttempts = 5) {
    if (!room || room.onChainVerified) return true;
    if (room._verifyingOnChain) return false;
    room._verifyingOnChain = true;

    const cleanMatchId = ensureBytes32(matchId);
    try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const matchData = await escrowContract.matches(cleanMatchId);
                const whiteWallet = (matchData.playerWhite || "").toLowerCase();
                const blackWallet = (matchData.playerBlack || "").toLowerCase();
                const chainTcIdx = Number(matchData.timeControl);
                let tcConfig = getTimeControlFromIndex(chainTcIdx);

                // If on-chain contract uses legacy 3-enum Blitz (1), preserve any explicit
                // blitz sub-variant (blitz3_2 or blitz5) hinted by challenge/client before move 1.
                const hintedTc = paidMatchTcHints.get(cleanMatchId.toLowerCase()) || room.requestedTimeControlName || room.timeControlName;
                if (chainTcIdx === 1 && (hintedTc === 'blitz3_2' || hintedTc === 'blitz5')) {
                    tcConfig = getTimeControlConfig(hintedTc);
                }

                if (matchData.wagerAmount) {
                    room.wagerEth = Number(ethers.formatEther(matchData.wagerAmount));
                }

                if (room.chess.history().length === 0) {
                    room.whiteTime = tcConfig.time;
                    room.blackTime = tcConfig.time;
                    room.whiteTimeMs = tcConfig.time * 1000;
                    room.blackTimeMs = tcConfig.time * 1000;
                }
                room.inc = tcConfig.inc;
                room.incMs = tcConfig.inc * 1000;
                room.timeControlName = tcConfig.name;
                room.isPaidMode = true;

                // Case A: Both players are registered on-chain (Match is Active)
                if (
                    whiteWallet &&
                    blackWallet &&
                    whiteWallet !== ethers.ZeroAddress &&
                    blackWallet !== ethers.ZeroAddress
                ) {
                    room.whiteWallet = whiteWallet;
                    room.blackWallet = blackWallet;
                    room.challengePendingOpponent = false;
                    room.onChainVerified = true;

                    console.log(`[ORACLE] Room verified on-chain – White: ${room.whiteWallet} | Black: ${room.blackWallet} | Wager: ${room.wagerEth} zkLTC`);

                    for (const [, p] of room.players) {
                        if (p.authenticated && (p.wallet === whiteWallet || p.wallet === blackWallet)) {
                            p.color = (p.wallet === whiteWallet) ? 'w' : 'b';
                            p.fixedColor = true;
                            if (p.color === 'w') room.whiteUsername = p.username;
                            else room.blackUsername = p.username;
                            sendSafe(p.ws, {
                                type: 'WALLET_REGISTERED',
                                color: p.color,
                                username: p.username
                            });
                        }
                    }
                    broadcastToRoom(matchId, buildGameStateSnapshot(room));
                    syncRoomPlayerIdentities(room);
                    social.notifyPresenceChange(whiteWallet);
                    social.notifyPresenceChange(blackWallet);
                    room._verifyingOnChain = false;
                    return true;
                }

                // Case B: Challenge Link created on-chain by White, waiting for Black to accept
                if (whiteWallet && whiteWallet !== ethers.ZeroAddress && blackWallet === ethers.ZeroAddress) {
                    room.whiteWallet = whiteWallet;
                    room.challengePendingOpponent = true;
                    room._verifyingOnChain = false;
                    return true;
                }
            } catch (e) {
                console.warn(`[ORACLE] On-chain read attempt ${attempt}/${maxAttempts} warning:`, e.message);
            }
            if (attempt < maxAttempts) {
                await new Promise(r => setTimeout(r, 1500));
            }
        }
    } finally {
        room._verifyingOnChain = false;
    }
    return false;
}

function abortRoomAndRefund(room, matchId, reason = 'opening_timeout') {
    if (!room || room.gameEnded) return;
    room.gameEnded = true;
    room.turnStartedAt = null;
    room.takebackOffer = null;
    console.log(`[ORACLE] Aborting match ${matchId} (reason: ${reason}, isPaidMode: ${room.isPaidMode})`);

    if (room.isPaidMode && !room.txPending) {
        room.txPending = true;
        relayer.enqueueAbort(matchId, room);
    } else {
        broadcastToRoom(matchId, { type: 'MATCH_ABORTED' });
    }

    if (room.whiteWallet) social.notifyPresenceChange(room.whiteWallet);
    if (room.blackWallet) social.notifyPresenceChange(room.blackWallet);
}

function finalizeGameEnd(room, matchId, winnerColor, reason) {
    if (!room || room.gameEnded) return;
    room.gameEnded = true;
    room.turnStartedAt = null;
    room.takebackOffer = null;

    let winnerWallet = ethers.ZeroAddress;
    if (winnerColor === 'w') winnerWallet = room.whiteWallet || ethers.ZeroAddress;
    else if (winnerColor === 'b') winnerWallet = room.blackWallet || ethers.ZeroAddress;

    if (room.isPaidMode) {
        room.txPending = true;
        relayer.enqueueResolve(matchId, winnerWallet, room, winnerColor, reason);
    } else {
        updateRatingsAfterGame(room.whiteWallet, room.blackWallet, winnerWallet, room).then((delta) => {
            recordRoomOutcomeToSocial(room, matchId, winnerColor, winnerWallet, reason, delta);
        });
    }

    if (room.tourneyId && tournaments.has(room.tourneyId)) {
        recordTournamentResult(room.tourneyId, room.whiteWallet, room.blackWallet, winnerColor);
    }

    broadcastToRoom(matchId, {
        type: 'GAME_ENDED',
        winnerColor: winnerColor || null,
        reason: reason || 'completed',
        fen: room.chess.fen()
    });
}

function triggerFlagTimeout(room, matchId, flaggedColor) {
    if (!room || room.gameEnded) return;

    if (flaggedColor === 'w') {
        room.whiteTimeMs = 0;
        room.whiteTime = 0;
    } else {
        room.blackTimeMs = 0;
        room.blackTime = 0;
    }
    room.turnStartedAt = null;

    const opponentColor = flaggedColor === 'w' ? 'b' : 'w';
    const opponentCanMate = hasSufficientMatingMaterial(room.chess, opponentColor);
    const winnerColor = opponentCanMate ? opponentColor : null;
    const reason = opponentCanMate ? 'timeout' : 'timeout_vs_insufficient_material';

    broadcastToRoom(matchId, {
        type: 'TIME_OUT',
        winnerColor,
        flaggedColor,
        whiteTime: msToSeconds(room.whiteTimeMs),
        blackTime: msToSeconds(room.blackTimeMs)
    });
    finalizeGameEnd(room, matchId, winnerColor, reason);
}

// Fast 250ms watchdog: catches timeouts instantly without drifting clocks
setInterval(() => {
    const now = Date.now();
    rooms.forEach((room, matchId) => {
        if (room.gameEnded) return;

        // Opening Move Watchdog: active once both players have joined until ply 2
        if (room.chess.history().length < 2) {
            if (room.openingTimerStart) {
                const ageSeconds = (now - room.openingTimerStart) / 1000;
                if (ageSeconds >= OPENING_ABORT_SECONDS && !room.txPending) {
                    abortRoomAndRefund(room, matchId, 'opening_move_timeout');
                }
            }
            return;
        }

        if (chessIsGameOver(room.chess)) return;

        // Ensure turnStartedAt is initialized as soon as ply >= 2
        if (!room.turnStartedAt) {
            room.turnStartedAt = now;
        }

        const { whiteMs, blackMs, clocksActive } = getLiveClocksMs(room, now);

        if (room.chess.turn() === 'w' && whiteMs <= 0) {
            triggerFlagTimeout(room, matchId, 'w');
            return;
        }
        if (room.chess.turn() === 'b' && blackMs <= 0) {
            triggerFlagTimeout(room, matchId, 'b');
            return;
        }

        // Sync every 250ms when in time trouble (<10s), otherwise every 1000ms
        const lowTime = whiteMs < 10000 || blackMs < 10000;
        const syncInterval = lowTime ? 250 : 1000;
        if (now - (room.lastSyncBroadcastAt || 0) >= syncInterval) {
            room.lastSyncBroadcastAt = now;
            broadcastToRoom(matchId, {
                type: 'CLOCK_SYNC',
                whiteTime: msToSeconds(whiteMs),
                blackTime: msToSeconds(blackMs),
                turn: room.chess.turn(),
                clocksActive,
                inc: room.inc || 0,
                serverNow: now
            });
        }
    });
}, 250);

function noop() {}
function heartbeat() {
    this.isAlive = true;
    if (this._pingSentAt) {
        const measured = Date.now() - this._pingSentAt;
        if (measured >= 0 && measured < 5000) {
            this.rttMs = this.rttMs ? Math.round((this.rttMs * 0.6) + (measured * 0.4)) : measured;
        }
        this._pingSentAt = null;
    }
}

const heartbeatInterval = setInterval(() => {
    const now = Date.now();
    server.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws._pingSentAt = now;
        ws.ping(noop);
    });

    for (const tc of Object.keys(freeQueues)) {
        freeQueues[tc] = freeQueues[tc].filter(entry => entry.ws && entry.ws.readyState === WebSocket.OPEN);
    }

    rooms.forEach((room, matchId) => {
        let activeClients = 0;
        room.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) activeClients++; });
        if (activeClients === 0) {
            room.idleTime = (room.idleTime || 0) + 1;
            const maxIdle = room.gameEnded ? 2 : (room.isPaidMode ? 120 : 30);
            if (room.idleTime >= maxIdle) {
                rooms.delete(matchId);
                console.log(`[GC] Purged idle room: ${matchId}`);
            }
        } else {
            room.idleTime = 0;
        }
    });

    tournaments.forEach((t, tourneyId) => {
        let activePlayers = 0;
        t.players.forEach(p => { if (p.ws && p.ws.readyState === WebSocket.OPEN) activePlayers++; });
        if (activePlayers === 0 && Date.now() - t.createdAt > 3600000) {
            tournaments.delete(tourneyId);
        }
    });
}, 20000);

// =====================================================================
// 7. TOURNAMENT ARENA COORDINATOR
// =====================================================================
function getTourneySummaryList() {
    const list = [];
    tournaments.forEach((t) => {
        const standings = [];
        t.players.forEach((p, wallet) => {
            standings.push({
                wallet,
                username: p.username,
                points: p.points,
                wins: p.wins,
                games: p.games
            });
        });
        standings.sort((a, b) => b.points - a.points || b.wins - a.wins);
        list.push({
            id: t.id,
            name: t.name,
            entryFee: t.entryFee,
            timeControl: t.timeControl,
            isPaid: t.isPaid,
            status: t.status,
            playerCount: t.players.size,
            standings: standings.slice(0, 10)
        });
    });
    return list;
}

function recordTournamentResult(tourneyId, whiteWallet, blackWallet, winnerColor) {
    const t = tournaments.get(tourneyId);
    if (!t || t.status !== 'active') return;
    const pW = whiteWallet ? t.players.get(whiteWallet.toLowerCase()) : null;
    const pB = blackWallet ? t.players.get(blackWallet.toLowerCase()) : null;
    if (pW) {
        pW.games++;
        pW.inMatch = false;
        if (winnerColor === 'w') { pW.points += 3; pW.wins++; }
        else if (!winnerColor) { pW.points += 1; }
    }
    if (pB) {
        pB.games++;
        pB.inMatch = false;
        if (winnerColor === 'b') { pB.points += 3; pB.wins++; }
        else if (!winnerColor) { pB.points += 1; }
    }

    let championWallet = null;
    t.players.forEach((p, wallet) => {
        if (p.points >= 9 && !championWallet) {
            championWallet = wallet;
        }
    });

    if (championWallet) {
        t.status = 'completed';
        if (t.isPaid && ethers.isAddress(championWallet)) {
            relayer.enqueueTourneyResolve(tourneyId, championWallet, t);
        }
        social.emitActivityEvent(championWallet, 'tournament', `won Tournament Arena "${t.name}"! 🏆`);
        broadcastTournamentUpdate(tourneyId);
        return;
    }

    broadcastTournamentUpdate(tourneyId);
    pairAvailableTournamentPlayers(tourneyId);
}

function broadcastTournamentUpdate(tourneyId) {
    const list = getTourneySummaryList();
    const target = list.find(x => x.id === tourneyId);
    if (!target) return;
    const t = tournaments.get(tourneyId);
    t.players.forEach((p) => {
        sendSafe(p.ws, { type: 'TOURNEY_STATE', tournament: target });
    });
}

function pairAvailableTournamentPlayers(tourneyId) {
    const t = tournaments.get(tourneyId);
    if (!t || t.status !== 'active') return;
    const waiting = [];
    t.players.forEach((p, wallet) => {
        if (!p.inMatch && p.ws && p.ws.readyState === WebSocket.OPEN) {
            waiting.push({ wallet, ...p });
        }
    });

    while (waiting.length >= 2) {
        const p1 = waiting.shift();
        const p2 = waiting.shift();
        const p1Rec = t.players.get(p1.wallet);
        const p2Rec = t.players.get(p2.wallet);
        if (p1Rec) p1Rec.inMatch = true;
        if (p2Rec) p2Rec.inMatch = true;

        const tcCfg = getTimeControlConfig(t.timeControl);
        const matchId = "0x" + crypto.randomBytes(32).toString('hex');
        const room = createRoomInstance(matchId, {
            isPaidMode: false,
            isFreeMode: true,
            timeControlName: tcCfg.name,
            whiteTime: tcCfg.time,
            blackTime: tcCfg.time,
            whiteTimeMs: tcCfg.time * 1000,
            blackTimeMs: tcCfg.time * 1000,
            inc: tcCfg.inc,
            incMs: tcCfg.inc * 1000,
            whiteUsername: p1.username,
            blackUsername: p2.username,
            tourneyId,
            openingTimerStart: Date.now()
        });

        room.clients.add(p1.ws);
        room.clients.add(p2.ws);
        room.players.set(p1.ws.sessionId, { ws: p1.ws, color: 'w', wallet: p1.wallet, guestId: p1.guestId || null, authenticated: true, fixedColor: true, username: p1.username });
        room.players.set(p2.ws.sessionId, { ws: p2.ws, color: 'b', wallet: p2.wallet, guestId: p2.guestId || null, authenticated: true, fixedColor: true, username: p2.username });
        room.whiteWallet = ethers.isAddress(p1.wallet) ? p1.wallet : null;
        room.blackWallet = ethers.isAddress(p2.wallet) ? p2.wallet : null;
        rooms.set(matchId, room);

        sendSafe(p1.ws, { type: 'FREE_MATCH_FOUND', matchId, color: 'w', tourneyId, sessionId: p1.ws.sessionId, timeControl: tcCfg.name, myName: p1.username, opponentName: p2.username });
        sendSafe(p2.ws, { type: 'FREE_MATCH_FOUND', matchId, color: 'b', tourneyId, sessionId: p2.ws.sessionId, timeControl: tcCfg.name, myName: p2.username, opponentName: p1.username });
        if (room.whiteWallet) social.notifyPresenceChange(room.whiteWallet);
        if (room.blackWallet) social.notifyPresenceChange(room.blackWallet);
    }
}

// =====================================================================
// 8. WEBSOCKET CONNECTION & MESSAGE ROUTER
// =====================================================================
server.on('connection', (ws, req) => {
    const ip = (process.env.TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress;
    const nConn = (connsPerIp.get(ip) || 0) + 1;
    if (nConn > MAX_CONN_PER_IP) {
        ws.close(1013, 'Too many connections from this IP');
        return;
    }
    connsPerIp.set(ip, nConn);

    ws.sessionId = crypto.randomBytes(16).toString('hex');
    ws._rateLimitKey = ws.sessionId;
    ws.isAlive = true;
    ws.rttMs = DEFAULT_LAG_COMP_MS * 2;
    ws._pingSentAt = Date.now();
    ws.on('pong', heartbeat);
    try { ws.ping(noop); } catch (_) {}

    let currentMatchId = null;

    // Initialize social handshake nonce on every connection
    social.onConnect(ws);

    sendSafe(ws, {
        type: 'LOBBY_TELEMETRY',
        totalGames: totalGamesPlayedCount,
        activeGames: rooms.size,
        playersOnline: server.clients.size,
        tournaments: getTourneySummaryList()
    });

    ws.on('message', async (data) => {
        try {
            if (!checkRateLimit(ws)) {
                sendSafe(ws, { type: 'ERROR', reason: 'Too many messages. Slow down.' });
                return;
            }
            const raw = data.toString().trim();
            if (!raw || raw === 'undefined') return;
            const message = JSON.parse(raw);
            const { type } = message;

            if (type === 'SOLO_RESULT') {
                return;
            }

            // Route all social, presence, DM, club & direct challenge messages to social-server.js
            if (await social.handleMessage(ws, message)) {
                return;
            }

            // ---------- TELEMETRY & LIVE MATCHES ----------
            if (type === 'GET_LOBBY_TELEMETRY') {
                const liveMatches = [];
                rooms.forEach((r, id) => {
                    if (!r.gameEnded) {
                        const snap = buildGameStateSnapshot(r);
                        liveMatches.push({
                            matchId: id,
                            white: snap.whiteUsername,
                            black: snap.blackUsername,
                            timeControl: r.timeControlName,
                            isPaid: r.isPaidMode,
                            moveCount: r.chess.history().length
                        });
                    }
                });
                sendSafe(ws, {
                    type: 'LOBBY_TELEMETRY',
                    totalGames: totalGamesPlayedCount,
                    activeGames: rooms.size,
                    playersOnline: server.clients.size,
                    liveMatches: liveMatches.slice(0, 15),
                    tournaments: getTourneySummaryList()
                });
                return;
            }

            // ---------- LEGACY SINGLE-RESULT PLAYER SEARCH ----------
            if (type === 'SEARCH_USER') {
                const query = String(message.query || '').trim().toLowerCase();
                if (!query) return;

                let matchedAddr = null;
                if (query.startsWith('0x') && query.length >= 10) {
                    matchedAddr = Object.keys(playerRatings).find(a => a.startsWith(query)) || (query.length === 42 ? query : null);
                } else if (usernameToAddress.has(query)) {
                    matchedAddr = usernameToAddress.get(query);
                } else {
                    for (const [uname, addr] of usernameToAddress.entries()) {
                        if (uname.includes(query)) {
                            matchedAddr = addr;
                            break;
                        }
                    }
                }

                let activeRoomId = null;
                let isOnline = false;
                rooms.forEach((r, rId) => {
                    for (const [, p] of r.players) {
                        if (
                            (matchedAddr && p.wallet && p.wallet.toLowerCase() === matchedAddr) ||
                            (p.username && p.username.toLowerCase().includes(query))
                        ) {
                            matchedAddr = matchedAddr || (p.wallet ? p.wallet.toLowerCase() : null);
                            if (!r.gameEnded) activeRoomId = rId;
                            if (p.ws && p.ws.readyState === WebSocket.OPEN) isOnline = true;
                        }
                    }
                });

                if (!matchedAddr) {
                    sendSafe(ws, {
                        type: 'SEARCH_USER_RESULT',
                        query: message.query,
                        found: false
                    });
                    return;
                }

                const presence = social.computePresence(matchedAddr);
                const ratings = getRatingsObject(matchedAddr);
                const resolvedName = await fetchUsername(matchedAddr);

                sendSafe(ws, {
                    type: 'SEARCH_USER_RESULT',
                    query: message.query,
                    found: true,
                    username: resolvedName,
                    wallet: matchedAddr,
                    ratings,
                    isOnline: isOnline || presence.status !== 'offline',
                    presence,
                    activeMatchId: activeRoomId || presence.activeMatchId
                });
                return;
            }

            // ---------- TOURNAMENT ARENA (ZERO-TRUST DEPOSIT VERIFIED) ----------
            if (type === 'CREATE_OR_JOIN_TOURNEY') {
                const tourneyId = String(message.tourneyId || 'litforge-main-arena').trim().toLowerCase();
                const rawWallet = String(message.wallet || '').toLowerCase();
                const guestId = normalizeGuestId(message.guestId, ws.sessionId);
                const participantKey = rawWallet || guestId;

                let t = tournaments.get(tourneyId);
                const wantPaid = t ? t.isPaid : !!message.isPaid;

                if (wantPaid) {
                    if (!ethers.isAddress(rawWallet)) {
                        sendSafe(ws, { type: 'ERROR', reason: 'Valid Web3 wallet required for staked tournaments.' });
                        return;
                    }
                    try {
                        const tourneyBytes32 = ethers.id(tourneyId);
                        const hasPaidEntry = await escrowContract.tournamentParticipants(tourneyBytes32, rawWallet);
                        if (!hasPaidEntry) {
                            sendSafe(ws, { type: 'ERROR', reason: 'On-chain tournament entry deposit not verified.' });
                            return;
                        }
                    } catch (err) {
                        sendSafe(ws, { type: 'ERROR', reason: 'Failed to verify tournament deposit on LitVM.' });
                        return;
                    }
                }

                const username = await resolveParticipantName(
                    message.username,
                    ethers.isAddress(rawWallet) ? rawWallet : null,
                    guestId,
                    ws.sessionId
                );

                const tcCfg = getTimeControlConfig(message.timeControl);
                if (!t) {
                    t = {
                        id: tourneyId,
                        name: message.name || `Arena #${tourneyId.slice(0, 8)}`,
                        entryFee: message.entryFee || '0.01',
                        timeControl: tcCfg.name,
                        isPaid: wantPaid,
                        status: 'active',
                        players: new Map(),
                        createdAt: Date.now()
                    };
                    tournaments.set(tourneyId, t);
                }

                if (!t.players.has(participantKey)) {
                    t.players.set(participantKey, { ws, username, guestId, points: 0, wins: 0, games: 0, inMatch: false });
                    if (ethers.isAddress(rawWallet)) {
                        social.emitActivityEvent(rawWallet, 'tournament', `entered Tournament Arena "${t.name}"`);
                    }
                } else {
                    const existing = t.players.get(participantKey);
                    existing.ws = ws;
                    existing.username = username;
                }

                broadcastTournamentUpdate(tourneyId);
                pairAvailableTournamentPlayers(tourneyId);
                return;
            }

            // ---------- FREE MATCHMAKING ----------
            if (type === 'QUEUE_FREE_MATCH') {
                const tcCfg = getTimeControlConfig(message.timeControl);
                const timeControl = tcCfg.name;
                const sidePref = Number(message.sidePref ?? 2);
                const wallet = (message.wallet && ethers.isAddress(message.wallet))
                    ? String(message.wallet).toLowerCase()
                    : null;
                const guestId = normalizeGuestId(message.guestId, ws.sessionId);
                const username = await resolveParticipantName(message.username, wallet, guestId, ws.sessionId);

                for (const tc of Object.keys(freeQueues)) {
                    freeQueues[tc] = freeQueues[tc].filter(e =>
                        e.ws !== ws &&
                        (!wallet || e.wallet !== wallet) &&
                        (!guestId || e.guestId !== guestId)
                    );
                }

                const queue = freeQueues[timeControl];
                if (queue.length >= MAX_QUEUE_PER_TC) {
                    sendSafe(ws, { type: 'ERROR', reason: 'Queue full, try again later.' });
                    return;
                }

                queue.push({ ws, timeControl, sidePref, wallet, guestId, username, queuedAt: Date.now() });
                sendSafe(ws, { type: 'QUEUED_FREE_MATCH', timeControl, queueSize: queue.length, username });

                if (queue.length >= 2) {
                    const p1 = queue.shift();
                    const p2 = queue.shift();

                    if (!p1.ws || p1.ws.readyState !== WebSocket.OPEN) {
                        if (p2.ws && p2.ws.readyState === WebSocket.OPEN) queue.unshift(p2);
                        return;
                    }
                    if (!p2.ws || p2.ws.readyState !== WebSocket.OPEN) {
                        queue.unshift(p1);
                        return;
                    }

                    const newMatchId = "0x" + crypto.randomBytes(32).toString('hex');

                    let p1Color = 'w';
                    if (p1.sidePref === 0 && p2.sidePref !== 0) p1Color = 'w';
                    else if (p1.sidePref === 1 && p2.sidePref !== 1) p1Color = 'b';
                    else if (p2.sidePref === 0) p1Color = 'b';
                    else if (p2.sidePref === 1) p1Color = 'w';
                    else p1Color = Math.random() < 0.5 ? 'w' : 'b';
                    const p2Color = p1Color === 'w' ? 'b' : 'w';

                    evictCompletedRoomsIfNeeded();
                    const room = createRoomInstance(newMatchId, {
                        isPaidMode: false,
                        isFreeMode: true,
                        whiteTime: tcCfg.time,
                        blackTime: tcCfg.time,
                        whiteTimeMs: tcCfg.time * 1000,
                        blackTimeMs: tcCfg.time * 1000,
                        inc: tcCfg.inc,
                        incMs: tcCfg.inc * 1000,
                        timeControlName: timeControl,
                        whiteWallet: p1Color === 'w' ? p1.wallet : p2.wallet,
                        blackWallet: p1Color === 'w' ? p2.wallet : p1.wallet,
                        whiteGuestId: p1Color === 'w' ? p1.guestId : p2.guestId,
                        blackGuestId: p1Color === 'w' ? p2.guestId : p1.guestId,
                        whiteUsername: p1Color === 'w' ? p1.username : p2.username,
                        blackUsername: p1Color === 'w' ? p2.username : p1.username,
                        openingTimerStart: Date.now()
                    });

                    room.clients.add(p1.ws);
                    room.clients.add(p2.ws);

                    room.players.set(p1.ws.sessionId, {
                        ws: p1.ws,
                        color: p1Color,
                        wallet: p1.wallet,
                        guestId: p1.guestId,
                        authenticated: true,
                        fixedColor: true,
                        username: p1.username
                    });

                    room.players.set(p2.ws.sessionId, {
                        ws: p2.ws,
                        color: p2Color,
                        wallet: p2.wallet,
                        guestId: p2.guestId,
                        authenticated: true,
                        fixedColor: true,
                        username: p2.username
                    });

                    rooms.set(newMatchId, room);

                    sendSafe(p1.ws, {
                        type: 'FREE_MATCH_FOUND',
                        matchId: newMatchId,
                        color: p1Color,
                        sessionId: p1.ws.sessionId,
                        timeControl,
                        myName: p1.username,
                        opponentName: p2.username
                    });

                    sendSafe(p2.ws, {
                        type: 'FREE_MATCH_FOUND',
                        matchId: newMatchId,
                        color: p2Color,
                        sessionId: p2.ws.sessionId,
                        timeControl,
                        myName: p2.username,
                        opponentName: p1.username
                    });

                    if (p1.wallet) social.notifyPresenceChange(p1.wallet);
                    if (p2.wallet) social.notifyPresenceChange(p2.wallet);
                }
                return;
            }

            if (type === 'CANCEL_FREE_QUEUE') {
                for (const tc of Object.keys(freeQueues)) {
                    freeQueues[tc] = freeQueues[tc].filter(entry => entry.ws !== ws);
                }
                sendSafe(ws, { type: 'QUEUE_CANCELLED' });
                return;
            }

            // ---------- JOIN OR SPECTATE A ROOM (ZERO-TRUST IN PAID MODE) ----------
            if (type === 'JOIN_ROOM') {
                const {
                    matchId,
                    color,
                    isPaidMode: isPaid,
                    spectate,
                    timeControlVal,
                    timeControlName: reqTcName,
                    username: clientUsername,
                    wallet: rawClientWallet,
                    guestId: rawGuestId
                } = message;
                if (!matchId) return;
                currentMatchId = matchId;
                const clientWallet = (rawClientWallet && ethers.isAddress(rawClientWallet))
                    ? String(rawClientWallet).toLowerCase()
                    : null;
                const clientGuestId = normalizeGuestId(rawGuestId, ws.sessionId);

                evictCompletedRoomsIfNeeded();
                if (rooms.size >= MAX_ROOMS && !rooms.has(matchId)) {
                    sendSafe(ws, { type: 'ERROR', reason: 'Server full, please try again later.' });
                    return;
                }

                if (isPaid && reqTcName && tcMap[String(reqTcName).toLowerCase()]) {
                    registerMatchTcHint(matchId, reqTcName);
                }

                let room = rooms.get(matchId);
                if (!room) {
                    const cleanKey = ensureBytes32(matchId).toLowerCase();
                    const effectiveTcName = reqTcName || paidMatchTcHints.get(cleanKey) || null;
                    const tcInfo = effectiveTcName ? getTimeControlConfig(effectiveTcName) : getTimeControlFromIndex(timeControlVal ?? 1);
                    room = createRoomInstance(matchId, {
                        isPaidMode: !!isPaid,
                        isFreeMode: !isPaid,
                        whiteTime: tcInfo.time,
                        blackTime: tcInfo.time,
                        whiteTimeMs: tcInfo.time * 1000,
                        blackTimeMs: tcInfo.time * 1000,
                        inc: tcInfo.inc,
                        incMs: tcInfo.inc * 1000,
                        requestedTimeControlName: effectiveTcName ? tcInfo.name : null,
                        timeControlName: tcInfo.name
                    });
                    rooms.set(matchId, room);
                } else {
                    if (isPaid && !room.isPaidMode) {
                        room.isPaidMode = true;
                        room.isFreeMode = false;
                    }
                    if (room.chess.history().length === 0 && (reqTcName === 'blitz3_2' || reqTcName === 'blitz5')) {
                        const tcInfo = getTimeControlConfig(reqTcName);
                        room.requestedTimeControlName = tcInfo.name;
                        room.timeControlName = tcInfo.name;
                        room.whiteTime = tcInfo.time;
                        room.blackTime = tcInfo.time;
                        room.whiteTimeMs = tcInfo.time * 1000;
                        room.blackTimeMs = tcInfo.time * 1000;
                        room.inc = tcInfo.inc;
                        room.incMs = tcInfo.inc * 1000;
                    }
                }

                room.clients.add(ws);

                if (spectate) {
                    room.spectators.add(ws.sessionId);
                    ws._spectatorName = await resolveParticipantName(clientUsername, clientWallet, clientGuestId, ws.sessionId);
                    sendSafe(ws, { type: 'SPECTATOR_MODE', matchId, sessionId: ws.sessionId });
                    sendSafe(ws, buildGameStateSnapshot(room));
                    return;
                }

                const nonce = crypto.randomBytes(16).toString('hex');
                room.nonces.set(ws.sessionId, nonce);

                // =========================================================
                // PAID MODE: Strict Zero-Trust Challenge
                // =========================================================
                if (room.isPaidMode) {
                    await verifyPaidRoomOnChain(room, matchId, 4);

                    if (
                        room.onChainVerified &&
                        room.whiteWallet &&
                        room.blackWallet &&
                        clientWallet &&
                        clientWallet !== room.whiteWallet &&
                        clientWallet !== room.blackWallet
                    ) {
                        room.spectators.add(ws.sessionId);
                        ws._spectatorName = await resolveParticipantName(clientUsername, clientWallet, clientGuestId, ws.sessionId);
                        sendSafe(ws, { type: 'SPECTATOR_MODE', matchId, sessionId: ws.sessionId });
                        sendSafe(ws, buildGameStateSnapshot(room));
                        return;
                    }

                    let expectedColor = color || 'w';
                    if (clientWallet && room.whiteWallet) {
                        expectedColor = (clientWallet === room.whiteWallet) ? 'w' : 'b';
                    }

                    sendSafe(ws, {
                        type: 'ROOM_JOINED',
                        nonce,
                        sessionId: ws.sessionId,
                        color: expectedColor,
                        isPaidMode: true,
                        authenticated: false
                    });

                    sendSafe(ws, buildGameStateSnapshot(room));
                    return;
                }

                // =========================================================
                // FREE MODE: Reliable Session Reclaim (Wallet + GuestId)
                // =========================================================
                const resolvedName = await resolveParticipantName(clientUsername, clientWallet, clientGuestId, ws.sessionId);
                let existingPlayer = room.players.get(ws.sessionId);

                if (!existingPlayer) {
                    for (const [sid, p] of [...room.players.entries()]) {
                        const sameWallet = clientWallet && p.wallet && p.wallet.toLowerCase() === clientWallet;
                        const sameGuest = clientGuestId && p.guestId && p.guestId === clientGuestId;
                        const deadSocketSameColor = (!p.ws || p.ws.readyState !== WebSocket.OPEN) && (!color || p.color === color);

                        if (sameWallet || sameGuest || deadSocketSameColor) {
                            if (p.disconnectTimer) {
                                clearTimeout(p.disconnectTimer);
                                p.disconnectTimer = null;
                            }
                            if (p.ws && p.ws !== ws) {
                                room.clients.delete(p.ws);
                                try { p.ws.terminate(); } catch (_) {}
                            }
                            existingPlayer = {
                                ...p,
                                ws,
                                wallet: clientWallet || p.wallet,
                                guestId: clientGuestId || p.guestId,
                                username: (p.username && !GENERIC_NAMES.has(p.username.toLowerCase())) ? p.username : resolvedName
                            };
                            room.players.delete(sid);
                            room.players.set(ws.sessionId, existingPlayer);
                            room.spectators.delete(ws.sessionId);
                            if (room.drawOfferFrom === sid) room.drawOfferFrom = ws.sessionId;
                            if (room.takebackOffer && room.takebackOffer.fromSessionId === sid) {
                                room.takebackOffer.fromSessionId = ws.sessionId;
                            }
                            broadcastToRoom(matchId, { type: 'OPPONENT_RECONNECTED' }, ws);
                            break;
                        }
                    }
                }

                if (!existingPlayer && room.players.size >= 2) {
                    for (const [sid, p] of [...room.players.entries()]) {
                        if (!p.ws || p.ws.readyState !== WebSocket.OPEN) {
                            if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
                            room.players.delete(sid);
                            break;
                        }
                    }
                }

                if (!existingPlayer && room.players.size >= 2) {
                    room.spectators.add(ws.sessionId);
                    ws._spectatorName = resolvedName;
                    sendSafe(ws, { type: 'SPECTATOR_MODE', matchId, sessionId: ws.sessionId });
                    sendSafe(ws, buildGameStateSnapshot(room));
                    return;
                }

                if (!existingPlayer) {
                    const takenColors = [...room.players.values()].map(p => p.color);
                    let assignedColor = color;
                    if (clientWallet && room.whiteWallet && clientWallet === room.whiteWallet) assignedColor = 'w';
                    else if (clientWallet && room.blackWallet && clientWallet === room.blackWallet) assignedColor = 'b';
                    else if (clientGuestId && room.whiteGuestId && clientGuestId === room.whiteGuestId) assignedColor = 'w';
                    else if (clientGuestId && room.blackGuestId && clientGuestId === room.blackGuestId) assignedColor = 'b';

                    if (!assignedColor || takenColors.includes(assignedColor)) {
                        assignedColor = takenColors.includes('w') ? 'b' : 'w';
                    }
                    room.players.set(ws.sessionId, {
                        ws,
                        color: assignedColor,
                        wallet: clientWallet,
                        guestId: clientGuestId,
                        authenticated: true,
                        username: resolvedName,
                        fixedColor: !!color
                    });
                } else {
                    existingPlayer.ws = ws;
                    if (clientWallet) existingPlayer.wallet = clientWallet;
                    if (clientGuestId) existingPlayer.guestId = clientGuestId;
                    if (!existingPlayer.username || GENERIC_NAMES.has(existingPlayer.username.toLowerCase())) {
                        existingPlayer.username = resolvedName;
                    }
                    if (existingPlayer.disconnectTimer) {
                        clearTimeout(existingPlayer.disconnectTimer);
                        existingPlayer.disconnectTimer = null;
                    }
                }

                const myPlayer = room.players.get(ws.sessionId);
                if (myPlayer.color === 'w') {
                    if (myPlayer.wallet && !room.whiteWallet) room.whiteWallet = myPlayer.wallet;
                    if (myPlayer.guestId && !room.whiteGuestId) room.whiteGuestId = myPlayer.guestId;
                    room.whiteUsername = myPlayer.username;
                } else {
                    if (myPlayer.wallet && !room.blackWallet) room.blackWallet = myPlayer.wallet;
                    if (myPlayer.guestId && !room.blackGuestId) room.blackGuestId = myPlayer.guestId;
                    room.blackUsername = myPlayer.username;
                }

                if (room.players.size === 2 && !room.openingTimerStart) {
                    room.openingTimerStart = Date.now();
                }

                sendSafe(ws, {
                    type: 'ROOM_JOINED',
                    nonce,
                    sessionId: ws.sessionId,
                    color: myPlayer.color,
                    username: myPlayer.username,
                    isPaidMode: false,
                    authenticated: true
                });

                sendSafe(ws, buildGameStateSnapshot(room));

                if (room.players.size === 2) {
                    broadcastToRoom(matchId, { type: 'OPPONENT_JOINED' }, ws);
                    syncRoomPlayerIdentities(room);
                }
                if (myPlayer.wallet) social.notifyPresenceChange(myPlayer.wallet);
                return;
            }

            // ---------- WALLET AUTHENTICATION (DIRECT OR DELEGATED SESSION KEY) ----------
            if (type === 'SET_WALLET') {
                if (!currentMatchId || !message.wallet || !message.signature) {
                    sendSafe(ws, { type: 'ERROR', reason: 'Missing authentication parameters.' });
                    return;
                }
                const room = rooms.get(currentMatchId);
                if (!room) return;

                try {
                    const storedNonce = room.nonces.get(ws.sessionId);
                    if (!storedNonce) {
                        sendSafe(ws, { type: 'ERROR', reason: 'No session nonce. Rejoin.' });
                        return;
                    }

                    const cleanWallet = String(message.wallet).toLowerCase();
                    const expectedRoomMsg = `LITCHESS_AUTH_${cleanWallet}_${storedNonce}`;
                    let recovered = null;

                    if (message.delegateAddress && message.delegateSignature) {
                        const cleanDelegate = String(message.delegateAddress).toLowerCase();
                        const expectedDelegateMsg = `LITCHESS_DELEGATE_${cleanWallet}_${cleanDelegate}`;
                        const delegateSigner = ethers.verifyMessage(expectedDelegateMsg, message.delegateSignature).toLowerCase();
                        const nonceSigner = ethers.verifyMessage(expectedRoomMsg, message.signature).toLowerCase();

                        if (delegateSigner === cleanWallet && nonceSigner === cleanDelegate) {
                            recovered = cleanWallet;
                        }
                    } else {
                        const directSigner = ethers.verifyMessage(expectedRoomMsg, message.signature).toLowerCase();
                        if (directSigner === cleanWallet) {
                            recovered = cleanWallet;
                        }
                    }

                    if (recovered !== cleanWallet) {
                        sendSafe(ws, { type: 'ERROR', reason: 'Invalid cryptographic signature.' });
                        return;
                    }

                    room.nonces.set(ws.sessionId, crypto.randomBytes(16).toString('hex'));

                    if (message.isPaidMode || room.isPaidMode) {
                        room.isPaidMode = true;
                        room.isFreeMode = false;
                        await verifyPaidRoomOnChain(room, currentMatchId, 5);

                        if (room.challengePendingOpponent && room.whiteWallet === recovered && !room.blackWallet) {
                            const resolvedCreatorName = await fetchUsername(recovered);
                            room.whiteUsername = resolvedCreatorName;
                            room.players.set(ws.sessionId, {
                                ws,
                                color: 'w',
                                wallet: recovered,
                                authenticated: true,
                                fixedColor: true,
                                username: resolvedCreatorName
                            });
                            sendSafe(ws, {
                                type: 'WALLET_REGISTERED',
                                color: 'w',
                                username: resolvedCreatorName,
                                waitingForOpponent: true
                            });
                            sendSafe(ws, { type: 'RATINGS_UPDATED', ratings: getRatingsObject(recovered) });
                            return;
                        }

                        if (!room.onChainVerified || !room.whiteWallet || !room.blackWallet) {
                            sendSafe(ws, { type: 'ERROR', reason: 'Match not yet verified on-chain. Retrying...' });
                            return;
                        }

                        if (recovered !== room.whiteWallet && recovered !== room.blackWallet) {
                            room.players.delete(ws.sessionId);
                            room.spectators.add(ws.sessionId);
                            ws._spectatorName = await fetchUsername(recovered);
                            sendSafe(ws, { type: 'SPECTATOR_MODE', matchId: currentMatchId, sessionId: ws.sessionId });
                            sendSafe(ws, buildGameStateSnapshot(room));
                            return;
                        }
                    }

                    const authoritativeColor = (room.isPaidMode && room.whiteWallet && room.blackWallet)
                        ? ((recovered === room.whiteWallet) ? 'w' : 'b')
                        : null;

                    let player = room.players.get(ws.sessionId);
                    let wasReconnect = false;

                    for (const [sid, oldPlayer] of [...room.players.entries()]) {
                        if (sid !== ws.sessionId && (oldPlayer.wallet === recovered || (authoritativeColor && oldPlayer.color === authoritativeColor))) {
                            if (oldPlayer.disconnectTimer) {
                                clearTimeout(oldPlayer.disconnectTimer);
                                oldPlayer.disconnectTimer = null;
                            }
                            if (oldPlayer.ws && oldPlayer.ws !== ws) {
                                room.clients.delete(oldPlayer.ws);
                                try { oldPlayer.ws.terminate(); } catch (_) {}
                            }
                            player = {
                                ...oldPlayer,
                                ws,
                                wallet: recovered,
                                authenticated: true
                            };
                            room.players.delete(sid);
                            room.players.set(ws.sessionId, player);
                            room.spectators.delete(ws.sessionId);
                            if (room.drawOfferFrom === sid) room.drawOfferFrom = ws.sessionId;
                            if (room.takebackOffer && room.takebackOffer.fromSessionId === sid) {
                                room.takebackOffer.fromSessionId = ws.sessionId;
                            }
                            wasReconnect = true;
                        }
                    }

                    const resolvedUsername = await fetchUsername(recovered);

                    if (!player) {
                        let assignedColor = authoritativeColor;
                        if (!assignedColor) {
                            const takenColors = [...room.players.values()].map(p => p.color);
                            assignedColor = takenColors.includes('w') ? 'b' : 'w';
                        }
                        player = {
                            ws,
                            color: assignedColor,
                            wallet: recovered,
                            authenticated: true,
                            fixedColor: !!authoritativeColor,
                            username: resolvedUsername
                        };
                    } else {
                        if (authoritativeColor) {
                            player.color = authoritativeColor;
                            player.fixedColor = true;
                        } else if (!player.fixedColor) {
                            const otherAuth = [...room.players.values()].find(p => p !== player && p.authenticated);
                            if (otherAuth) {
                                player.color = otherAuth.color === 'w' ? 'b' : 'w';
                            }
                        }
                        player.wallet = recovered;
                        player.authenticated = true;
                        player.username = resolvedUsername;
                    }

                    if (!room.isPaidMode) {
                        if (player.color === 'w') room.whiteWallet = recovered;
                        else room.blackWallet = recovered;
                    }
                    if (player.color === 'w') room.whiteUsername = resolvedUsername;
                    else room.blackUsername = resolvedUsername;

                    room.players.set(ws.sessionId, player);
                    room.spectators.delete(ws.sessionId);

                    if (room.players.size === 2 && !room.openingTimerStart) {
                        room.openingTimerStart = Date.now();
                    }

                    sendSafe(ws, { type: 'WALLET_REGISTERED', color: player.color, username: player.username });
                    sendSafe(ws, { type: 'RATINGS_UPDATED', ratings: getRatingsObject(recovered) });
                    broadcastToRoom(currentMatchId, buildGameStateSnapshot(room));

                    if (wasReconnect) {
                        broadcastToRoom(currentMatchId, { type: 'OPPONENT_RECONNECTED' }, ws);
                    } else if (room.players.size === 2) {
                        broadcastToRoom(currentMatchId, { type: 'OPPONENT_JOINED' }, ws);
                    }

                    syncRoomPlayerIdentities(room);
                    social.notifyPresenceChange(recovered);
                } catch (e) {
                    console.error('[SET_WALLET] Error:', e.message);
                    sendSafe(ws, { type: 'ERROR', reason: 'Authentication failure.' });
                }
                return;
            }

            // ---------- INSTANT CLIENT TIMEOUT CLAIM / CLOCK CHECK ----------
            if (type === 'CLAIM_TIMEOUT' || type === 'CHECK_CLOCK') {
                if (!currentMatchId) return;
                const room = rooms.get(currentMatchId);
                if (!room || room.gameEnded) return;
                if (room.chess.history().length < 2) return;

                const now = Date.now();
                const { whiteMs, blackMs, clocksActive } = getLiveClocksMs(room, now);
                if (room.chess.turn() === 'w' && whiteMs <= 0) {
                    triggerFlagTimeout(room, currentMatchId, 'w');
                    return;
                }
                if (room.chess.turn() === 'b' && blackMs <= 0) {
                    triggerFlagTimeout(room, currentMatchId, 'b');
                    return;
                }

                sendSafe(ws, {
                    type: 'CLOCK_SYNC',
                    whiteTime: msToSeconds(whiteMs),
                    blackTime: msToSeconds(blackMs),
                    turn: room.chess.turn(),
                    clocksActive,
                    inc: room.inc || 0,
                    serverNow: now
                });
                return;
            }

            // ---------- CHESS MOVE (STRICT FLAG CHECK + FAIR LAG COMP + SYMMETRICAL INC) ----------
            if (type === 'CHESS_MOVE') {
                if (!currentMatchId) return;
                const room = rooms.get(currentMatchId);
                if (!room || room.gameEnded) return;

                const player = room.players.get(ws.sessionId);
                if (!player) {
                    sendSafe(ws, { type: 'MOVE_ERROR', reason: 'Player not found' });
                    return;
                }
                if (room.isPaidMode && !player.authenticated) {
                    sendSafe(ws, { type: 'MOVE_ERROR', reason: 'Not authenticated' });
                    return;
                }
                if (room.chess.turn() !== player.color) {
                    sendSafe(ws, { type: 'MOVE_ERROR', reason: 'Not your turn' });
                    return;
                }

                const now = Date.now();
                const plyBeforeMove = room.chess.history().length;

                // 1. Check timeout BEFORE applying the move (only once clocks are actively running: ply >= 2)
                if (plyBeforeMove >= 2 && room.turnStartedAt) {
                    const oneWayCompMs = Math.min(
                        MAX_LAG_COMP_MS,
                        Math.max(0, Math.round((ws.rttMs || (DEFAULT_LAG_COMP_MS * 2)) / 2))
                    );
                    const rawElapsedMs = Math.max(0, now - room.turnStartedAt);
                    const effectiveElapsedMs = Math.max(0, rawElapsedMs - oneWayCompMs);

                    const currentRemainingMs = player.color === 'w' ? room.whiteTimeMs : room.blackTimeMs;
                    const updatedRemainingMs = currentRemainingMs - effectiveElapsedMs;

                    if (updatedRemainingMs <= 0) {
                        // Flagged before the move arrived — reject move & end game by FIDE timeout
                        triggerFlagTimeout(room, currentMatchId, player.color);
                        return;
                    }

                    if (player.color === 'w') {
                        room.whiteTimeMs = updatedRemainingMs;
                        room.whiteTime = msToSeconds(room.whiteTimeMs);
                    } else {
                        room.blackTimeMs = updatedRemainingMs;
                        room.blackTime = msToSeconds(room.blackTimeMs);
                    }
                }

                // 2. Validate & apply move on authoritative board
                let move = null;
                try {
                    if (typeof message.from !== 'string' || typeof message.to !== 'string') throw new Error('bad input');
                    const promo = ['q', 'r', 'b', 'n'].includes(message.promotion) ? message.promotion : 'q';
                    move = room.chess.move({ from: message.from, to: message.to, promotion: promo });
                } catch (_) {
                    move = null;
                }

                if (!move) {
                    sendSafe(ws, { type: 'MOVE_ERROR', reason: 'Illegal move' });
                    return;
                }

                room.drawOfferFrom = null;
                if (room.takebackOffer) {
                    room.takebackOffer = null;
                    broadcastToRoom(currentMatchId, { type: 'TAKEBACK_CANCELLED', reason: 'move_played' });
                }
                const plyAfterMove = room.chess.history().length;
                let incAddedThisMove = 0;

                // 3. Symmetrical Lichess/Chess.com Clock Transitions:
                // - Ply 1 (White move 1): clocks still paused; reset opening abort timer for Black
                // - Ply 2 (Black move 1): clocks start NOW (turnStartedAt = now); NO free +inc on move 1
                // - Ply 3+ (White move 2+): clocks running; add +incMs symmetrically to the mover
                if (plyAfterMove === 1) {
                    room.openingTimerStart = now;
                    room.turnStartedAt = null;
                } else if (plyAfterMove === 2) {
                    room.openingTimerStart = null;
                    room.turnStartedAt = now;
                } else {
                    if (room.incMs > 0) {
                        incAddedThisMove = room.incMs;
                        if (player.color === 'w') {
                            room.whiteTimeMs += room.incMs;
                            room.whiteTime = msToSeconds(room.whiteTimeMs);
                        } else {
                            room.blackTimeMs += room.incMs;
                            room.blackTime = msToSeconds(room.blackTimeMs);
                        }
                    }
                    room.turnStartedAt = now;
                }
                room.moveIncHistory.push({ color: player.color, incAddedMs: incAddedThisMove });

                room.lastSyncBroadcastAt = now;
                const clocksActive = plyAfterMove >= 2 && !chessIsGameOver(room.chess);
                const wSec = msToSeconds(room.whiteTimeMs);
                const bSec = msToSeconds(room.blackTimeMs);

                broadcastToRoom(currentMatchId, {
                    type: 'OPPONENT_MOVE',
                    fromClientId: ws.sessionId,
                    from: move.from,
                    to: move.to,
                    promotion: move.promotion || 'q',
                    san: move.san,
                    fen: room.chess.fen(),
                    whiteTime: wSec,
                    blackTime: bSec,
                    turn: room.chess.turn(),
                    clocksActive,
                    inc: room.inc || 0,
                    serverNow: now
                }, ws);

                sendSafe(ws, {
                    type: 'CLOCK_SYNC',
                    whiteTime: wSec,
                    blackTime: bSec,
                    turn: room.chess.turn(),
                    clocksActive,
                    inc: room.inc || 0,
                    serverNow: now
                });

                if (chessIsGameOver(room.chess)) {
                    const isMate = chessIsCheckmate(room.chess);
                    const winnerColor = isMate ? (room.chess.turn() === 'w' ? 'b' : 'w') : null;
                    const reason = getChessGameEndReason(room.chess);
                    finalizeGameEnd(room, currentMatchId, winnerColor, reason);
                }
                return;
            }

            // ---------- RESIGN ----------
            if (type === 'RESIGN') {
                if (!currentMatchId) return;
                const room = rooms.get(currentMatchId);
                if (!room || room.gameEnded) return;
                const player = room.players.get(ws.sessionId);
                if (!player || (room.isPaidMode && !player.authenticated)) {
                    sendSafe(ws, { type: 'ERROR', reason: 'Not authenticated.' });
                    return;
                }

                if (room.chess.history().length < 2) {
                    sendSafe(ws, { type: 'ERROR', reason: 'Use Abort before the game has started.' });
                    return;
                }

                const winnerColor = player.color === 'w' ? 'b' : 'w';
                broadcastToRoom(currentMatchId, { type: 'RESIGN', fromClientId: ws.sessionId, winnerColor }, ws);
                finalizeGameEnd(room, currentMatchId, winnerColor, 'resignation');
                return;
            }

            // ---------- ABORT MATCH ----------
            if (type === 'ABORT_MATCH') {
                if (!currentMatchId) return;
                const room = rooms.get(currentMatchId);
                if (!room || room.gameEnded) return;
                const player = room.players.get(ws.sessionId);
                if (!player || (room.isPaidMode && !player.authenticated)) {
                    sendSafe(ws, { type: 'ERROR', reason: 'Not authenticated to abort this match.' });
                    return;
                }

                if (room.chess.history().length >= 2) {
                    sendSafe(ws, { type: 'ERROR', reason: 'Cannot abort after game has started.' });
                    return;
                }

                abortRoomAndRefund(room, currentMatchId, 'player_abort');
                return;
            }

            // ---------- DRAW OFFER & RESPONSE ----------
            if (type === 'DRAW_OFFER') {
                if (!currentMatchId) return;
                const room = rooms.get(currentMatchId);
                if (!room || chessIsGameOver(room.chess) || room.gameEnded) return;
                const player = room.players.get(ws.sessionId);
                if (player && (!room.isPaidMode || player.authenticated)) {
                    room.drawOfferFrom = ws.sessionId;
                    broadcastToRoom(currentMatchId, { type: 'DRAW_OFFER', fromClientId: ws.sessionId }, ws);
                }
                return;
            }

            if (type === 'DRAW_RESPONSE') {
                if (!currentMatchId) return;
                const room = rooms.get(currentMatchId);
                if (!room || room.gameEnded) return;
                const responder = room.players.get(ws.sessionId);
                if (responder && (!room.isPaidMode || responder.authenticated) && room.drawOfferFrom && room.drawOfferFrom !== ws.sessionId) {
                    if (message.accepted) {
                        broadcastToRoom(currentMatchId, { type: 'DRAW_RESPONSE', fromClientId: ws.sessionId, accepted: true });
                        finalizeGameEnd(room, currentMatchId, null, 'mutual_agreement');
                    } else {
                        broadcastToRoom(currentMatchId, { type: 'DRAW_RESPONSE', fromClientId: ws.sessionId, accepted: false }, ws);
                    }
                    room.drawOfferFrom = null;
                }
                return;
            }

            // ---------- TAKEBACK REQUEST & RESPONSE (STANDARD CHESS TAKEBACK) ----------
            if (type === 'TAKEBACK_OFFER') {
                if (!currentMatchId) return;
                const room = rooms.get(currentMatchId);
                if (!room || room.gameEnded || chessIsGameOver(room.chess)) return;
                const player = room.players.get(ws.sessionId);
                if (!player || (room.isPaidMode && !player.authenticated)) {
                    sendSafe(ws, { type: 'ERROR', reason: 'Not authenticated.' });
                    return;
                }

                const historyLen = room.chess.history().length;
                // Standard Lichess/Chess.com rule:
                // - If it is opponent's turn (requester just moved), undo 1 ply (returns turn to requester).
                // - If it is requester's turn (opponent already replied), undo 2 plies (returns turn to requester).
                const pliesToUndo = (room.chess.turn() !== player.color) ? 1 : 2;
                if (historyLen < pliesToUndo) {
                    sendSafe(ws, { type: 'ERROR', reason: 'No move available to take back.' });
                    return;
                }

                if (room.takebackOffer) {
                    if (room.takebackOffer.fromSessionId === ws.sessionId) {
                        sendSafe(ws, { type: 'ERROR', reason: 'Takeback request already pending.' });
                        return;
                    }
                }

                room.takebackOffer = {
                    fromSessionId: ws.sessionId,
                    fromColor: player.color,
                    pliesToUndo,
                    plyCountAtOffer: historyLen
                };

                broadcastToRoom(currentMatchId, {
                    type: 'TAKEBACK_OFFER',
                    fromClientId: ws.sessionId,
                    fromColor: player.color,
                    fromName: player.username || 'Opponent',
                    pliesToUndo
                }, ws);

                sendSafe(ws, {
                    type: 'TAKEBACK_SENT',
                    pliesToUndo
                });
                return;
            }

            if (type === 'TAKEBACK_RESPONSE') {
                if (!currentMatchId) return;
                const room = rooms.get(currentMatchId);
                if (!room || room.gameEnded || chessIsGameOver(room.chess)) return;
                const responder = room.players.get(ws.sessionId);
                if (!responder || (room.isPaidMode && !responder.authenticated)) return;

                const offer = room.takebackOffer;
                if (!offer || offer.fromSessionId === ws.sessionId) return;

                room.takebackOffer = null;

                if (!message.accepted) {
                    broadcastToRoom(currentMatchId, {
                        type: 'TAKEBACK_DECLINED',
                        fromClientId: ws.sessionId
                    });
                    return;
                }

                if (room.chess.history().length !== offer.plyCountAtOffer) {
                    broadcastToRoom(currentMatchId, {
                        type: 'TAKEBACK_CANCELLED',
                        reason: 'board_changed'
                    });
                    return;
                }

                const now = Date.now();
                const { whiteMs, blackMs } = getLiveClocksMs(room, now);
                room.whiteTimeMs = whiteMs;
                room.blackTimeMs = blackMs;

                let actuallyUndone = 0;
                for (let i = 0; i < offer.pliesToUndo; i++) {
                    const undone = room.chess.undo();
                    if (!undone) break;
                    actuallyUndone++;
                    // Reverse any increment granted on the undone ply to prevent time farming
                    const incRec = room.moveIncHistory.pop();
                    if (incRec && incRec.incAddedMs > 0) {
                        if (incRec.color === 'w') {
                            room.whiteTimeMs = Math.max(1000, room.whiteTimeMs - incRec.incAddedMs);
                        } else {
                            room.blackTimeMs = Math.max(1000, room.blackTimeMs - incRec.incAddedMs);
                        }
                    }
                }

                room.whiteTime = msToSeconds(room.whiteTimeMs);
                room.blackTime = msToSeconds(room.blackTimeMs);
                room.drawOfferFrom = null;

                const plyAfter = room.chess.history().length;
                if (plyAfter >= 2) {
                    room.turnStartedAt = now;
                    room.openingTimerStart = null;
                } else {
                    room.turnStartedAt = null;
                    room.openingTimerStart = now;
                }
                room.lastSyncBroadcastAt = now;

                const verboseHistory = room.chess.history({ verbose: true });
                broadcastToRoom(currentMatchId, {
                    type: 'TAKEBACK_ACCEPTED',
                    fen: room.chess.fen(),
                    moves: verboseHistory.map(m => ({ from: m.from, to: m.to, promotion: m.promotion || 'q', san: m.san })),
                    turn: room.chess.turn(),
                    whiteTime: room.whiteTime,
                    blackTime: room.blackTime,
                    clocksActive: plyAfter >= 2,
                    inc: room.inc || 0,
                    serverNow: now,
                    undonePlies: actuallyUndone,
                    requestedByColor: offer.fromColor
                });
                return;
            }

            // ---------- SPECTATOR LOUNGE / RAILBIRD CHAT ----------
            if (type === 'SPECTATOR_CHAT') {
                if (!currentMatchId) return;
                const room = rooms.get(currentMatchId);
                if (!room || !room.spectators.has(ws.sessionId)) return;

                const cleanText = String(message.text || '').trim();
                if (!cleanText) return;
                if (RESTRICTED_WORDS.some(w => cleanText.toLowerCase().includes(w))) {
                    sendSafe(ws, { type: 'ERROR', reason: 'Message blocked by server moderation.' });
                    return;
                }

                const senderName = ws._spectatorName || String(message.sender || 'Spectator').slice(0, 24);
                broadcastToSpectators(currentMatchId, {
                    type: 'RECEIVE_SPECTATOR_CHAT',
                    fromClientId: ws.sessionId,
                    sender: senderName,
                    text: cleanText.slice(0, 200)
                }, ws);
                return;
            }

            // ---------- CHAT & REMATCH ----------
            if (['CHAT_MESSAGE', 'REMATCH_OFFER', 'REMATCH_RESPONSE'].includes(type)) {
                if (!currentMatchId) return;
                const room = rooms.get(currentMatchId);
                if (!room) return;
                const rp = room.players.get(ws.sessionId);
                if (!rp || (room.isPaidMode && !rp.authenticated)) return;

                if (type === 'CHAT_MESSAGE') {
                    const cleanText = String(message.text || '').toLowerCase();
                    if (RESTRICTED_WORDS.some(w => cleanText.includes(w))) {
                        sendSafe(ws, { type: 'ERROR', reason: 'Message blocked by server moderation.' });
                        return;
                    }
                    const sanitizedText = String(message.text || '').slice(0, 200);
                    const sanitizedSender = rp.username || 'Player';
                    broadcastToRoom(currentMatchId, {
                        type: 'RECEIVE_CHAT',
                        fromClientId: ws.sessionId,
                        sender: sanitizedSender,
                        text: sanitizedText
                    }, ws);
                } else {
                    broadcastToRoom(currentMatchId, { ...message, fromClientId: ws.sessionId }, ws);
                }
                return;
            }
        } catch (err) {
            console.error('[WS ERROR] Failed to process message:', err.message);
        }
    });

    ws.on('close', () => {
        const c = (connsPerIp.get(ip) || 1) - 1;
        if (c <= 0) connsPerIp.delete(ip);
        else connsPerIp.set(ip, c);

        if (ws.sessionId) {
            clientMessageCounts.delete(ws.sessionId);
        }

        // Clean up social presence on disconnect
        social.onDisconnect(ws);

        for (const tc of Object.keys(freeQueues)) {
            freeQueues[tc] = freeQueues[tc].filter(entry => entry.ws !== ws);
        }

        if (currentMatchId && rooms.has(currentMatchId)) {
            const room = rooms.get(currentMatchId);
            room.clients.delete(ws);
            room.spectators.delete(ws.sessionId);
            room.nonces.delete(ws.sessionId);

            const player = room.players.get(ws.sessionId);
            if (player && (!room.isPaidMode || player.authenticated) && !room.gameEnded && !room.txPending) {
                broadcastToRoom(currentMatchId, { type: 'OPPONENT_DISCONNECTED' }, ws);

                if (room.chess.history().length < 2) {
                    player.disconnectTimer = setTimeout(() => {
                        const currentRoom = rooms.get(currentMatchId);
                        if (currentRoom && !currentRoom.gameEnded && currentRoom.chess.history().length < 2) {
                            const activePlayer = currentRoom.players.get(ws.sessionId);
                            if (activePlayer && (!activePlayer.ws || activePlayer.ws.readyState !== WebSocket.OPEN)) {
                                abortRoomAndRefund(currentRoom, currentMatchId, 'disconnect_before_start');
                            }
                        }
                    }, 25000);
                } else if (!chessIsGameOver(room.chess)) {
                    player.disconnectTimer = setTimeout(() => {
                        const currentRoom = rooms.get(currentMatchId);
                        if (currentRoom && !currentRoom.gameEnded) {
                            const activePlayer = currentRoom.players.get(ws.sessionId);
                            if (activePlayer && (!activePlayer.ws || activePlayer.ws.readyState !== WebSocket.OPEN)) {
                                const winnerColor = player.color === 'w' ? 'b' : 'w';
                                broadcastToRoom(currentMatchId, { type: 'TIME_OUT', winnerColor, flaggedColor: player.color });
                                finalizeGameEnd(currentRoom, currentMatchId, winnerColor, 'abandonment');
                            }
                        }
                    }, 60000);
                }
            }
        }
    });
});

server.on('close', () => clearInterval(heartbeatInterval));

// =====================================================================
// 9. BOOT SEQUENCE (Initialize Storage -> Load Ratings -> Listen)
// =====================================================================
(async function bootServer() {
    await initExternalStorage();
    await loadRatings();
    if (typeof social.init === 'function') {
        await social.init();
    } else if (typeof social.loadDb === 'function') {
        await social.loadDb();
    }

    httpServer.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 LitChess Web App & WebSocket Oracle live at: http://localhost:${PORT}`);

        // =================================================================
        // RENDER KEEP-ALIVE SELF-PING (Uses https for https:// URLs)
        // =================================================================
        const SELF_URL = process.env.RENDER_EXTERNAL_URL;
        if (SELF_URL) {
            const clientLib = SELF_URL.startsWith('https://') ? https : http;
            console.log(`[KEEPALIVE] Self-ping enabled → ${SELF_URL}/health every 10 min`);
            setInterval(() => {
                clientLib.get(`${SELF_URL}/health`, r => r.resume()).on('error', () => {});
            }, 10 * 60 * 1000);
        } else {
            console.log('[KEEPALIVE] RENDER_EXTERNAL_URL not set – self-ping disabled (local/dev mode).');
        }
    });
})();

process.on('unhandledRejection', e => console.error('[UNHANDLED]', e));