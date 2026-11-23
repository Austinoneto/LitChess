/**
 * ============================================================================
 * LITCHESS INSTITUTIONAL CLIENT ENGINE (public/app.js)
 * Wired to LitSocial (public/social.js) + Zero-Trust Oracle (server.js)
 * ============================================================================
 */

var board = null;
var game = new Chess();
var analysisGame = new Chess();

const WS_URL = window.LITCHESS_WS_URL ||
    (location.protocol === 'https:' ? `wss://${location.host}/ws` : `ws://${location.hostname || 'localhost'}:${location.port || '8080'}`);

const MAX_STAKE_ZKLTC = 5;
function normalizeStake(raw) {
    const n = Number(raw);
    if (!isFinite(n) || n <= 0 || n > MAX_STAKE_ZKLTC) return null;
    const s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return (s === '' || s === '0') ? null : s;
}

var myUsername = "Player";
var opponentUsername = "Opponent";
var opponentWallet = null;
var spectatorWhiteName = "White";
var spectatorBlackName = "Black";
var isReplayMode = false;
var replayWhiteName = "White";
var replayBlackName = "Black";
var localClientId = "client_" + Math.random().toString(36).substring(2, 15);
var mySessionId = null;

var userWalletAddress = null;
var authSignature = null;
var web3Provider = null;
var chessContractInstance = null;
var activeMatchId = null;
var createdChallengeMatchId = null;
var pendingChallengeInvite = null;
var signer = null;
var p2pSocket = null;
var lobbySocket = null;
var lobbyReconnectTimer = null;
var myAssignedColor = 'w';

var currentMode = '2p';
var isPaidMode = true;
var isBotThinking = false;
var gameResultSettled = false;
var isMatchActive = false;
var isAnalysisMode = false;
var pendingDrawOffer = false;
var pendingRematchOffer = false;
var opponentDisconnectTimer = null;
var isAuthenticated = false;
var pendingPremoves = [];
var selectedSquare = null;

const STORAGE_KEY = 'litchess_game_state';
const SESSION_DELEGATE_PREFIX = 'litchess_delegate_auth_';
const CONTRACT_ADDRESS = "0xB04bAF7F9784491A7041b25Bc7d3191c46Cdf73e";
const USERNAME_REGISTRY_ADDRESS = "0x7ff44d488B5e75adF4ba35B9fbAca68ce9BE92AE";
const USERNAME_REGISTRY_ABI = [
    "function registerUsername(string _name) external",
    "function getUsername(address _user) external view returns (string)"
];
var completedMatches = new Set();

// ============================================================================
// 0. CRYPTOGRAPHIC DELEGATED SESSION KEY MANAGER (1-PROMPT UX, ZERO-TRUST AUTH)
// ============================================================================
let pendingDelegatePromise = null;

function getCachedDelegatedSession(walletAddress) {
    if (!walletAddress) return null;
    const cleanWallet = walletAddress.toLowerCase();
    const storageKey = SESSION_DELEGATE_PREFIX + cleanWallet;
    try {
        const cachedRaw = localStorage.getItem(storageKey);
        if (cachedRaw) {
            const cached = JSON.parse(cachedRaw);
            if (cached && cached.delegatePrivateKey && cached.delegateAddress && cached.delegateSignature) {
                const delegateWallet = new ethers.Wallet(cached.delegatePrivateKey);
                const cleanDelegate = delegateWallet.address.toLowerCase();
                const expectedMsg = `LITCHESS_DELEGATE_${cleanWallet}_${cleanDelegate}`;
                const recovered = ethers.utils.verifyMessage(expectedMsg, cached.delegateSignature).toLowerCase();
                if (recovered === cleanWallet && cleanDelegate === cached.delegateAddress.toLowerCase()) {
                    return {
                        delegateWallet,
                        delegateAddress: cleanDelegate,
                        delegateSignature: cached.delegateSignature
                    };
                }
            }
        }
    } catch (_) {
        localStorage.removeItem(storageKey);
    }
    return null;
}

async function getOrCreateDelegatedSession(walletAddress, signerInstance) {
    if (!walletAddress || !signerInstance) return null;
    const cleanWallet = walletAddress.toLowerCase();
    const cached = getCachedDelegatedSession(cleanWallet);
    if (cached) return cached;

    if (pendingDelegatePromise) return pendingDelegatePromise;

    const storageKey = SESSION_DELEGATE_PREFIX + cleanWallet;
    pendingDelegatePromise = (async () => {
        try {
            const delegateWallet = ethers.Wallet.createRandom();
            const cleanDelegate = delegateWallet.address.toLowerCase();
            const expectedMsg = `LITCHESS_DELEGATE_${cleanWallet}_${cleanDelegate}`;
            const delegateSignature = await signerInstance.signMessage(expectedMsg);

            const payload = {
                wallet: cleanWallet,
                delegateAddress: cleanDelegate,
                delegatePrivateKey: delegateWallet.privateKey,
                delegateSignature
            };
            localStorage.setItem(storageKey, JSON.stringify(payload));
            return {
                delegateWallet,
                delegateAddress: cleanDelegate,
                delegateSignature
            };
        } finally {
            pendingDelegatePromise = null;
        }
    })();

    return pendingDelegatePromise;
}

// ============================================================================
// 1. NON-BLOCKING TOAST NOTIFICATION SYSTEM
// ============================================================================
function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `lit-toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.25s ease';
        setTimeout(() => toast.remove(), 260);
    }, duration);
}

// ============================================================================
// 2. PROCEDURAL WEB AUDIO SYNTHESIZER & GLOBAL EVENT BUS
// ============================================================================
class SoundManager {
    constructor() {
        this.audioCtx = null;
        this.buffers = {};
        this.enabled = true;
        this.volume = 0.55;
    }

    init() {
        if (!this.audioCtx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) this.audioCtx = new AudioContextClass();
        }
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }
    }

    async loadSound(name, url) {
        try {
            const response = await fetch(url);
            if (!response.ok) return;
            this.init();
            const arrayBuffer = await response.arrayBuffer();
            this.buffers[name] = await this.audioCtx.decodeAudioData(arrayBuffer);
        } catch (_) {}
    }

    play(name) {
        if (!this.enabled) return;
        this.init();
        if (!this.audioCtx) return;

        if (this.buffers[name]) {
            const source = this.audioCtx.createBufferSource();
            source.buffer = this.buffers[name];
            const gainNode = this.audioCtx.createGain();
            gainNode.gain.value = this.volume;
            source.connect(gainNode);
            gainNode.connect(this.audioCtx.destination);
            source.start(0);
            return;
        }

        const ctx = this.audioCtx;
        const now = ctx.currentTime;

        if (name === 'move') {
            this._synthTone(ctx, 155, 85, 0.075, 'triangle', now, 0.45);
        } else if (name === 'capture') {
            this._synthTone(ctx, 290, 95, 0.095, 'sawtooth', now, 0.6);
            this._synthTone(ctx, 180, 65, 0.08, 'triangle', now + 0.015, 0.5);
        } else if (name === 'castle') {
            this._synthTone(ctx, 160, 90, 0.07, 'triangle', now, 0.45);
            this._synthTone(ctx, 145, 80, 0.075, 'triangle', now + 0.085, 0.45);
        } else if (name === 'check') {
            this._synthTone(ctx, 587.33, 580, 0.22, 'sine', now, 0.45);
            this._synthTone(ctx, 880, 875, 0.25, 'sine', now + 0.05, 0.35);
        } else if (name === 'promotion') {
            [523.25, 659.25, 783.99, 1046.5].forEach((freq, idx) => {
                this._synthTone(ctx, freq, freq, 0.12, 'triangle', now + idx * 0.06, 0.35);
            });
        } else if (name === 'gameStart') {
            this._synthTone(ctx, 440, 440, 0.14, 'sine', now, 0.35);
            this._synthTone(ctx, 659.25, 659.25, 0.22, 'sine', now + 0.1, 0.4);
        } else if (name === 'gameEnd') {
            [523.25, 659.25, 783.99].forEach((freq, idx) => {
                this._synthTone(ctx, freq, freq, 0.28, 'sine', now + idx * 0.09, 0.38);
            });
        } else if (name === 'notification') {
            this._synthTone(ctx, 740, 740, 0.12, 'sine', now, 0.3);
            this._synthTone(ctx, 987.77, 987.77, 0.18, 'sine', now + 0.09, 0.3);
        }
    }

    _synthTone(ctx, startFreq, endFreq, duration, waveType, startTime, gainScale) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = waveType;
        osc.frequency.setValueAtTime(startFreq, startTime);
        if (startFreq !== endFreq) {
            osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), startTime + duration);
        }
        gain.gain.setValueAtTime(this.volume * gainScale, startTime);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(startTime);
        osc.stop(startTime + duration + 0.01);
    }
}

const soundManager = new SoundManager();

const EventBus = {
    events: {},
    on(event, callback) { (this.events[event] = this.events[event] || []).push(callback); },
    off(event, callback) {
        if (!this.events[event]) return;
        this.events[event] = this.events[event].filter(cb => cb !== callback);
    },
    emit(event, data) { (this.events[event] || []).forEach(cb => cb(data)); }
};
window.EventBus = EventBus;

// ============================================================================
// 3. ALPHA-BETA BOT ENGINE (QUIESCENCE, CHECK EXTENSIONS, BISHOP PAIR & KING PST)
// ============================================================================
const botWorkerCode = `
    importScripts('https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js');

    const PIECE_VALUES = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 20000 };

    const PST = {
        p: [
             0,  0,  0,  0,  0,  0,  0,  0,
            55, 60, 60, 65, 65, 60, 60, 55,
            15, 15, 25, 35, 35, 25, 15, 15,
             5,  5, 12, 28, 28, 12,  5,  5,
             0,  0,  0, 22, 22,  0,  0,  0,
             5, -5,-10,  0,  0,-10, -5,  5,
             5, 10, 10,-22,-22, 10, 10,  5,
             0,  0,  0,  0,  0,  0,  0,  0
        ],
        n: [
            -50,-40,-30,-30,-30,-30,-40,-50,
            -40,-20,  0,  0,  0,  0,-20,-40,
            -30,  0, 12, 16, 16, 12,  0,-30,
            -30,  5, 16, 22, 22, 16,  5,-30,
            -30,  0, 16, 22, 22, 16,  0,-30,
            -30,  5, 12, 16, 16, 12,  5,-30,
            -40,-20,  0,  5,  5,  0,-20,-40,
            -50,-40,-30,-30,-30,-30,-40,-50
        ],
        b: [
            -20,-10,-10,-10,-10,-10,-10,-20,
            -10,  0,  0,  0,  0,  0,  0,-10,
            -10,  0,  8, 12, 12,  8,  0,-10,
            -10,  6,  6, 12, 12,  6,  6,-10,
            -10,  0, 12, 12, 12, 12,  0,-10,
            -10, 10, 10, 10, 10, 10, 10,-10,
            -10,  6,  0,  0,  0,  0,  6,-10,
            -20,-10,-10,-10,-10,-10,-10,-20
        ],
        r: [
              0,  0,  0,  0,  0,  0,  0,  0,
              8, 14, 14, 14, 14, 14, 14,  8,
             -5,  0,  0,  0,  0,  0,  0, -5,
             -5,  0,  0,  0,  0,  0,  0, -5,
             -5,  0,  0,  0,  0,  0,  0, -5,
             -5,  0,  0,  0,  0,  0,  0, -5,
             -5,  0,  0,  0,  0,  0,  0, -5,
              0,  0,  0,  6,  6,  0,  0,  0
        ],
        q: [
            -20,-10,-10, -5, -5,-10,-10,-20,
            -10,  0,  0,  0,  0,  0,  0,-10,
            -10,  0,  5,  5,  5,  5,  0,-10,
             -5,  0,  5,  5,  5,  5,  0, -5,
              0,  0,  5,  5,  5,  5,  0, -5,
            -10,  5,  5,  5,  5,  5,  0,-10,
            -10,  0,  5,  0,  0,  0,  0,-10,
            -20,-10,-10, -5, -5,-10,-10,-20
        ],
        k_midgame: [
            -30,-40,-40,-50,-50,-40,-40,-30,
            -30,-40,-40,-50,-50,-40,-40,-30,
            -30,-40,-40,-50,-50,-40,-40,-30,
            -30,-40,-40,-50,-50,-40,-40,-30,
            -20,-30,-30,-40,-40,-30,-30,-20,
            -10,-20,-20,-20,-20,-20,-20,-10,
             20, 20,  0,  0,  0,  0, 20, 20,
             20, 30, 10,  0,  0, 10, 30, 20
        ],
        k_endgame: [
            -50,-40,-30,-20,-20,-30,-40,-50,
            -30,-20,-10,  0,  0,-10,-20,-30,
            -30,-10, 20, 30, 30, 20,-10,-30,
            -30,-10, 30, 42, 42, 30,-10,-30,
            -30,-10, 30, 42, 42, 30,-10,-30,
            -30,-10, 20, 30, 30, 20,-10,-30,
            -30,-30,  0,  0,  0,  0,-30,-30,
            -50,-30,-30,-30,-30,-30,-30,-50
        ]
    };

    function isEndgamePhase(board) {
        let queens = 0;
        let minorMajor = 0;
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const p = board[r][c];
                if (!p || p.type === 'k' || p.type === 'p') continue;
                if (p.type === 'q') queens++;
                else minorMajor++;
            }
        }
        return queens === 0 || (queens <= 2 && minorMajor <= 2);
    }

    function evaluateWhitePerspective(game) {
        if (game.in_checkmate()) return game.turn() === 'w' ? -99999 : 99999;
        if (game.in_draw() || game.in_stalemate() || game.in_threefold_repetition() || game.insufficient_material()) return 0;

        const board = game.board();
        const endgame = isEndgamePhase(board);
        let score = 0;
        let wBishops = 0, bBishops = 0;

        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const piece = board[r][c];
                if (!piece) continue;
                if (piece.type === 'b') piece.color === 'w' ? wBishops++ : bBishops++;
                const base = PIECE_VALUES[piece.type] || 0;
                const sqIdx = piece.color === 'w' ? (r * 8 + c) : ((7 - r) * 8 + c);
                let table = PST[piece.type];
                if (piece.type === 'k') {
                    table = endgame ? PST.k_endgame : PST.k_midgame;
                }
                const bonus = (table && table[sqIdx]) || 0;
                if (piece.color === 'w') score += (base + bonus);
                else score -= (base + bonus);
            }
        }

        if (wBishops >= 2) score += 35;
        if (bBishops >= 2) score -= 35;
        return score;
    }

    function orderMoves(moves) {
        return moves.sort((a, b) => {
            const scoreA = (a.captured ? (PIECE_VALUES[a.captured] * 10 - PIECE_VALUES[a.piece]) : 0) + (a.promotion ? 850 : 0);
            const scoreB = (b.captured ? (PIECE_VALUES[b.captured] * 10 - PIECE_VALUES[b.piece]) : 0) + (b.promotion ? 850 : 0);
            return scoreB - scoreA;
        });
    }

    function quiescence(game, alpha, beta, maximizingWhite, qDepth) {
        const standPat = evaluateWhitePerspective(game);
        if (qDepth <= 0 || game.game_over()) {
            return standPat;
        }

        if (maximizingWhite) {
            if (standPat >= beta) return beta;
            if (alpha < standPat) alpha = standPat;
        } else {
            if (standPat <= alpha) return alpha;
            if (beta > standPat) beta = standPat;
        }

        const tacticalMoves = orderMoves(
            game.moves({ verbose: true }).filter(m => m.captured || m.promotion)
        );

        if (maximizingWhite) {
            for (let i = 0; i < tacticalMoves.length; i++) {
                game.move(tacticalMoves[i]);
                const score = quiescence(game, alpha, beta, false, qDepth - 1);
                game.undo();
                if (score >= beta) return beta;
                if (score > alpha) alpha = score;
            }
            return alpha;
        } else {
            for (let i = 0; i < tacticalMoves.length; i++) {
                game.move(tacticalMoves[i]);
                const score = quiescence(game, alpha, beta, true, qDepth - 1);
                game.undo();
                if (score <= alpha) return alpha;
                if (score < beta) beta = score;
            }
            return beta;
        }
    }

    function alphabeta(game, depth, alpha, beta, maximizingWhite, checkExtensions) {
        if (game.game_over()) {
            return evaluateWhitePerspective(game);
        }

        let effectiveDepth = depth;
        if (effectiveDepth <= 0 && game.in_check() && checkExtensions < 2) {
            effectiveDepth = 1;
            checkExtensions++;
        }

        if (effectiveDepth <= 0) {
            return quiescence(game, alpha, beta, maximizingWhite, 4);
        }

        const moves = orderMoves(game.moves({ verbose: true }));
        if (maximizingWhite) {
            let maxEval = -Infinity;
            for (let i = 0; i < moves.length; i++) {
                game.move(moves[i]);
                const ev = alphabeta(game, effectiveDepth - 1, alpha, beta, false, checkExtensions);
                game.undo();
                if (ev > maxEval) maxEval = ev;
                if (ev > alpha) alpha = ev;
                if (beta <= alpha) break;
            }
            return maxEval;
        } else {
            let minEval = Infinity;
            for (let i = 0; i < moves.length; i++) {
                game.move(moves[i]);
                const ev = alphabeta(game, effectiveDepth - 1, alpha, beta, true, checkExtensions);
                game.undo();
                if (ev < minEval) minEval = ev;
                if (ev < beta) beta = ev;
                if (beta <= alpha) break;
            }
            return minEval;
        }
    }

    function findBestMoveForPosition(game, depth) {
        const moves = orderMoves(game.moves({ verbose: true }));
        if (moves.length === 0) return { bestMove: null, bestValue: evaluateWhitePerspective(game) };

        const isWhite = game.turn() === 'w';
        let bestMove = moves[0];
        let bestValue = isWhite ? -Infinity : Infinity;
        let alpha = -Infinity;
        let beta = Infinity;

        for (let i = 0; i < moves.length; i++) {
            game.move(moves[i]);
            const val = alphabeta(game, depth - 1, alpha, beta, !isWhite, 0);
            game.undo();
            if (isWhite) {
                if (val > bestValue) {
                    bestValue = val;
                    bestMove = moves[i];
                }
                if (val > alpha) alpha = val;
            } else {
                if (val < bestValue) {
                    bestValue = val;
                    bestMove = moves[i];
                }
                if (val < beta) beta = val;
            }
        }
        return { bestMove, bestValue };
    }

    self.onmessage = function(e) {
        const { type, fen, difficulty } = e.data;
        const game = new Chess(fen);

        if (type === 'EVAL') {
            const searchRes = findBestMoveForPosition(game, 2);
            self.postMessage({
                type: 'EVAL_RESULT',
                centipawns: searchRes.bestValue,
                bestMoveSan: searchRes.bestMove ? searchRes.bestMove.san : null,
                bestMoveFrom: searchRes.bestMove ? searchRes.bestMove.from : null,
                bestMoveTo: searchRes.bestMove ? searchRes.bestMove.to : null
            });
            return;
        }

        const moves = orderMoves(game.moves({ verbose: true }));
        if (moves.length === 0) {
            self.postMessage({ type: 'BOT_MOVE', move: null });
            return;
        }

        if (difficulty === 'easy') {
            const topPool = moves.slice(0, Math.min(moves.length, 4));
            const randomMove = topPool[Math.floor(Math.random() * topPool.length)];
            self.postMessage({ type: 'BOT_MOVE', move: randomMove });
            return;
        }

        const depthMap = { medium: 2, hard: 3, master: 3 };
        const depth = depthMap[difficulty] || 3;
        const result = findBestMoveForPosition(game, depth);

        self.postMessage({ type: 'BOT_MOVE', move: result.bestMove, evalCp: result.bestValue });
    };
`;
const botBlob = new Blob([botWorkerCode], { type: 'application/javascript' });
var botWorker = new Worker(URL.createObjectURL(botBlob));

// ============================================================================
// 4. CONTRACT CONFIGURATION
// ============================================================================
const CONTRACT_ABI = [
    {"inputs":[{"internalType":"bytes32","name":"_matchId","type":"bytes32"}],"name":"cancelCreatedMatch","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"address","name":"_serverOracle","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},
    {"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"player","type":"address"},{"indexed":false,"internalType":"uint256","name":"stake","type":"uint256"},{"indexed":false,"internalType":"enum LitChessEscrowclean.TimeControl","name":"tc","type":"uint8"}],"name":"CancelledQueue","type":"event"},
    {"inputs":[{"internalType":"uint256","name":"_stake","type":"uint256"},{"internalType":"enum LitChessEscrowclean.TimeControl","name":"_tc","type":"uint8"}],"name":"cancelQueue","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"anonymous":false,"inputs":[{"indexed":true,"internalType":"bytes32","name":"matchId","type":"bytes32"},{"indexed":true,"internalType":"address","name":"creator","type":"address"},{"indexed":false,"internalType":"uint256","name":"wager","type":"uint256"},{"indexed":false,"internalType":"enum LitChessEscrowclean.TimeControl","name":"tc","type":"uint8"},{"indexed":false,"internalType":"address","name":"ephemeralKey","type":"address"}],"name":"ChallengeCreated","type":"event"},
    {"inputs":[],"name":"claimFailedPayout","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"uint256","name":"_stake","type":"uint256"},{"internalType":"enum LitChessEscrowclean.TimeControl","name":"_tc","type":"uint8"}],"name":"clearPendingMatches","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"bytes32","name":"_matchId","type":"bytes32"},{"internalType":"enum LitChessEscrowclean.TimeControl","name":"_tc","type":"uint8"},{"internalType":"address","name":"_ephemeralPublicKey","type":"address"}],"name":"createChallenge","outputs":[],"stateMutability":"payable","type":"function"},
    {"inputs":[{"internalType":"bytes32","name":"_matchId","type":"bytes32"},{"internalType":"enum LitChessEscrowclean.TimeControl","name":"_tc","type":"uint8"}],"name":"createMatch","outputs":[],"stateMutability":"payable","type":"function"},
    {"inputs":[{"internalType":"bytes32","name":"_tourneyId","type":"bytes32"},{"internalType":"uint256","name":"_entryFee","type":"uint256"}],"name":"createTournament","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"user","type":"address"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"}],"name":"FallbackBalanceCredited","type":"event"},
    {"inputs":[{"internalType":"bytes32","name":"_matchId","type":"bytes32"},{"internalType":"bytes","name":"_signature","type":"bytes"}],"name":"joinChallenge","outputs":[],"stateMutability":"payable","type":"function"},
    {"inputs":[{"internalType":"bytes32","name":"_matchId","type":"bytes32"}],"name":"joinMatch","outputs":[],"stateMutability":"payable","type":"function"},
    {"inputs":[{"internalType":"bytes32","name":"_tourneyId","type":"bytes32"}],"name":"joinTournament","outputs":[],"stateMutability":"payable","type":"function"},
    {"anonymous":false,"inputs":[{"indexed":true,"internalType":"bytes32","name":"matchId","type":"bytes32"}],"name":"MatchAborted","type":"event"},
    {"anonymous":false,"inputs":[{"indexed":true,"internalType":"bytes32","name":"matchId","type":"bytes32"},{"indexed":true,"internalType":"address","name":"creator","type":"address"},{"indexed":false,"internalType":"uint256","name":"wager","type":"uint256"},{"indexed":false,"internalType":"enum LitChessEscrowclean.TimeControl","name":"tc","type":"uint8"}],"name":"MatchCreated","type":"event"},
    {"anonymous":false,"inputs":[{"indexed":true,"internalType":"bytes32","name":"matchId","type":"bytes32"},{"indexed":false,"internalType":"address","name":"winner","type":"address"},{"indexed":false,"internalType":"uint256","name":"payout","type":"uint256"}],"name":"MatchResolved","type":"event"},
    {"anonymous":false,"inputs":[{"indexed":true,"internalType":"bytes32","name":"matchId","type":"bytes32"},{"indexed":false,"internalType":"address","name":"white","type":"address"},{"indexed":false,"internalType":"address","name":"black","type":"address"}],"name":"MatchStarted","type":"event"},
    {"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"oracle","type":"address"},{"indexed":false,"internalType":"bool","name":"authorized","type":"bool"}],"name":"OracleAuthorizationUpdated","type":"event"},
    {"inputs":[],"name":"pause","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"anonymous":false,"inputs":[],"name":"Paused","type":"event"},
    {"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"player","type":"address"},{"indexed":false,"internalType":"uint256","name":"stake","type":"uint256"},{"indexed":false,"internalType":"enum LitChessEscrowclean.TimeControl","name":"tc","type":"uint8"},{"indexed":false,"internalType":"enum LitChessEscrowclean.ColorPref","name":"pref","type":"uint8"}],"name":"QueuedForMatch","type":"event"},
    {"inputs":[{"internalType":"uint256","name":"_stake","type":"uint256"},{"internalType":"enum LitChessEscrowclean.TimeControl","name":"_tc","type":"uint8"},{"internalType":"enum LitChessEscrowclean.ColorPref","name":"_pref","type":"uint8"}],"name":"queueForMatch","outputs":[],"stateMutability":"payable","type":"function"},
    {"inputs":[{"internalType":"bytes32","name":"_matchId","type":"bytes32"}],"name":"refundStalledMatch","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"bytes32","name":"_matchId","type":"bytes32"},{"internalType":"address","name":"_winner","type":"address"}],"name":"resolveMatch","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"bytes32","name":"_matchId","type":"bytes32"},{"internalType":"address","name":"_winner","type":"address"},{"internalType":"uint256","name":"_moveCount","type":"uint256"},{"internalType":"bytes32","name":"_fenHash","type":"bytes32"},{"internalType":"bytes","name":"_sigWhite","type":"bytes"},{"internalType":"bytes","name":"_sigBlack","type":"bytes"}],"name":"resolveMatchBySignedState","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"bytes32","name":"_tourneyId","type":"bytes32"},{"internalType":"address","name":"_winner","type":"address"}],"name":"resolveTournament","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"bytes32","name":"_matchId","type":"bytes32"}],"name":"serverAbortMatch","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"address","name":"_oracle","type":"address"},{"internalType":"bool","name":"_authorized","type":"bool"}],"name":"setOracleAuthorization","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"address","name":"_newOracle","type":"address"}],"name":"setServerOracle","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"anonymous":false,"inputs":[{"indexed":true,"internalType":"bytes32","name":"tourneyId","type":"bytes32"},{"indexed":false,"internalType":"uint256","name":"entryFee","type":"uint256"}],"name":"TournamentCreated","type":"event"},
    {"anonymous":false,"inputs":[{"indexed":true,"internalType":"bytes32","name":"tourneyId","type":"bytes32"},{"indexed":false,"internalType":"address","name":"player","type":"address"}],"name":"TournamentJoined","type":"event"},
    {"anonymous":false,"inputs":[{"indexed":true,"internalType":"bytes32","name":"tourneyId","type":"bytes32"},{"indexed":false,"internalType":"address","name":"winner","type":"address"},{"indexed":false,"internalType":"uint256","name":"payout","type":"uint256"}],"name":"TournamentResolved","type":"event"},
    {"inputs":[],"name":"unpause","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"anonymous":false,"inputs":[],"name":"Unpaused","type":"event"},
    {"inputs":[{"internalType":"address payable","name":"_to","type":"address"}],"name":"withdrawProtocolFees","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[],"name":"accumulatedProtocolFees","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"authorizedOracles","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"name":"challengeEphemeralKeys","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"claimableBalances","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"DOMAIN_SEPARATOR","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"uint256","name":"_stake","type":"uint256"},{"internalType":"enum LitChessEscrowclean.TimeControl","name":"_tc","type":"uint8"}],"name":"getPendingMatches","outputs":[{"components":[{"internalType":"address","name":"player","type":"address"},{"internalType":"uint256","name":"stake","type":"uint256"},{"internalType":"enum LitChessEscrowclean.TimeControl","name":"tc","type":"uint8"},{"internalType":"uint256","name":"timestamp","type":"uint256"},{"internalType":"enum LitChessEscrowclean.ColorPref","name":"pref","type":"uint8"}],"internalType":"struct LitChessEscrowclean.PendingMatch[]","name":"","type":"tuple[]"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"name":"matches","outputs":[{"internalType":"bytes32","name":"matchId","type":"bytes32"},{"internalType":"address payable","name":"playerWhite","type":"address"},{"internalType":"address payable","name":"playerBlack","type":"address"},{"internalType":"uint256","name":"wagerAmount","type":"uint256"},{"internalType":"enum LitChessEscrowclean.MatchStatus","name":"status","type":"uint8"},{"internalType":"uint256","name":"lastMoveTimestamp","type":"uint256"},{"internalType":"enum LitChessEscrowclean.TimeControl","name":"timeControl","type":"uint8"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"paused","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"uint256","name":"","type":"uint256"},{"internalType":"enum LitChessEscrowclean.TimeControl","name":"","type":"uint8"},{"internalType":"uint256","name":"","type":"uint256"}],"name":"pendingMatches","outputs":[{"internalType":"address","name":"player","type":"address"},{"internalType":"uint256","name":"stake","type":"uint256"},{"internalType":"enum LitChessEscrowclean.TimeControl","name":"tc","type":"uint8"},{"internalType":"uint256","name":"timestamp","type":"uint256"},{"internalType":"enum LitChessEscrowclean.ColorPref","name":"pref","type":"uint8"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"serverOracle","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"STALLED_HATCH_TIME","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"STATE_SETTLEMENT_TYPEHASH","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"TAX_RATE","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"bytes32","name":"","type":"bytes32"},{"internalType":"address","name":"","type":"address"}],"name":"tournamentParticipants","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"name":"tournaments","outputs":[{"internalType":"bytes32","name":"tourneyId","type":"bytes32"},{"internalType":"uint256","name":"entryFee","type":"uint256"},{"internalType":"uint256","name":"totalPot","type":"uint256"},{"internalType":"address","name":"creator","type":"address"},{"internalType":"bool","name":"isActive","type":"bool"}],"stateMutability":"view","type":"function"}
];

var playerRatings = { blitz: 2000, bullet: 2000, rapid: 2000 };
var opponentRatings = { blitz: 2000, bullet: 2000, rapid: 2000 };

var analysisMovesList = [];
var analysisCurrentIndex = -1;

var openingMoveTimer = null;
var chessClockTicker = null;
var timeControlLimits = { bullet: 60, blitz: 180, rapid: 600 };
var timeControlIncrements = { bullet: 0, blitz: 2, rapid: 0 };

var userTimeRemaining = 180;
var opponentTimeRemaining = 180;

var queueTimeout = null;
var isInQueue = false;
var queuedStake = 0;
var queuedTc = 0;
const QUEUE_TIMEOUT_SECONDS = 600;
let pairingTimeoutId = null;
let globalMatchStartedListener = null;
let queuePollingInterval = null;
var pendingDrawOfferFromOpponent = false;
var isSpectator = false;
var abortFallbackTimer = null;

// ============================================================================
// 5. BOARD THEMES, DYNAMIC PIECE RENDERER & MATERIAL CALCULATOR
// ============================================================================
var currentPieceTheme = 'wikipedia';
var currentBoardTheme = 'default';

function getPieceThemeUrl(piece) {
    if (!piece) return '';
    if (currentPieceTheme === 'alpha') {
        return `https://chessboardjs.com/img/chesspieces/alpha/${piece}.png`;
    }
    if (currentPieceTheme === 'merida') {
        return `https://raw.githubusercontent.com/lichess-org/lila/master/public/piece/merida/${piece}.svg`;
    }
    return `https://chessboardjs.com/img/chesspieces/wikipedia/${piece}.png`;
}

function applyBoardTheme(theme) {
    currentBoardTheme = theme;
    localStorage.setItem('litchess_boardTheme', theme);
    document.body.className = document.body.className.replace(/theme-\w+/g, '').trim();
    if (theme !== 'default') {
        document.body.classList.add(`theme-${theme}`);
    }
}

function applyPieceTheme(theme) {
    currentPieceTheme = theme;
    localStorage.setItem('litchess_pieceTheme', theme);
    if (board) {
        const activeChess = isAnalysisMode ? analysisGame : game;
        const currentFen = activeChess.fen();

        board.clear(false);
        board.position(currentFen, false);
        $('#myBoard img[data-piece]').each(function () {
            const p = $(this).attr('data-piece');
            if (p) $(this).attr('src', getPieceThemeUrl(p));
        });

        reapplyBoardHighlights();
    }
}

function loadSettings() {
    const savedBoard = localStorage.getItem('litchess_boardTheme');
    const savedPieces = localStorage.getItem('litchess_pieceTheme');
    if (savedBoard) { applyBoardTheme(savedBoard); $('#board-theme-select').val(savedBoard); }
    if (savedPieces) { applyPieceTheme(savedPieces); $('#piece-theme-select').val(savedPieces); }
    const soundEnabled = localStorage.getItem('litchess_soundEnabled');
    if (soundEnabled !== null) {
        soundManager.enabled = soundEnabled === 'true';
        $('#sound-toggle').prop('checked', soundEnabled === 'true');
    }
}

function updateCapturedPiecesAndMaterial() {
    const startCounts = { p: 8, n: 2, b: 2, r: 2, q: 1 };
    const currentWhite = { p: 0, n: 0, b: 0, r: 0, q: 0 };
    const currentBlack = { p: 0, n: 0, b: 0, r: 0, q: 0 };
    const weights = { p: 1, n: 3, b: 3, r: 5, q: 9 };
    const glyphs = {
        w: { q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
        b: { q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' }
    };

    const activeChess = isAnalysisMode ? analysisGame : game;
    const bState = activeChess.board();
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const sq = bState[r][c];
            if (!sq || sq.type === 'k') continue;
            if (sq.color === 'w') currentWhite[sq.type]++;
            else currentBlack[sq.type]++;
        }
    }

    let whiteCapturedStr = '';
    let blackCapturedStr = '';
    let whiteMatScore = 0;
    let blackMatScore = 0;

    ['q', 'r', 'b', 'n', 'p'].forEach(t => {
        whiteMatScore += currentWhite[t] * weights[t];
        blackMatScore += currentBlack[t] * weights[t];
        const missingBlack = Math.max(0, startCounts[t] - currentBlack[t]);
        const missingWhite = Math.max(0, startCounts[t] - currentWhite[t]);
        whiteCapturedStr += glyphs.b[t].repeat(missingBlack);
        blackCapturedStr += glyphs.w[t].repeat(missingWhite);
    });

    const diff = whiteMatScore - blackMatScore;
    const bottomIsWhite = (isSpectator || isReplayMode) ? true : (myAssignedColor === 'w');

    $('#user-captured-pieces').text(bottomIsWhite ? whiteCapturedStr : blackCapturedStr);
    $('#opponent-captured-pieces').text(bottomIsWhite ? blackCapturedStr : whiteCapturedStr);

    const userAdv = bottomIsWhite ? diff : -diff;
    const oppAdv = -userAdv;

    if (userAdv > 0) {
        $('#user-material-diff').text(`+${userAdv}`).removeClass('hidden-element');
    } else {
        $('#user-material-diff').addClass('hidden-element');
    }

    if (oppAdv > 0) {
        $('#opponent-material-diff').text(`+${oppAdv}`).removeClass('hidden-element');
    } else {
        $('#opponent-material-diff').addClass('hidden-element');
    }
}

// ============================================================================
// 6. HIGHLIGHTS, CLICK/TAP-AND-DROP, CHECK GLOW, PREMOVES & PROMOTIONS
// ============================================================================
var lastMoveFrom = null;
var lastMoveTo = null;

function clearSquareSelection() {
    selectedSquare = null;
    $('.square-55d63').removeClass('square-selected square-selected-premove square-legal-move square-legal-capture');
}

function clearMoveHighlights() {
    if (!board) return;
    if (lastMoveFrom) $(`.square-${lastMoveFrom}`).removeClass('square-highlight-from');
    if (lastMoveTo) $(`.square-${lastMoveTo}`).removeClass('square-highlight-to');
    lastMoveFrom = null;
    lastMoveTo = null;
    clearSquareSelection();
    $('.square-55d63').removeClass('checkmate-king king-in-check square-premove');
}

function highlightLastMove(from, to) {
    if (lastMoveFrom) $(`.square-${lastMoveFrom}`).removeClass('square-highlight-from');
    if (lastMoveTo) $(`.square-${lastMoveTo}`).removeClass('square-highlight-to');
    if (!from || !to) return;
    lastMoveFrom = from;
    lastMoveTo = to;
    $(`.square-${from}`).addClass('square-highlight-from');
    $(`.square-${to}`).addClass('square-highlight-to');
}

function renderPremoveHighlights() {
    $('.square-55d63').removeClass('square-premove');
    pendingPremoves.forEach(pm => {
        $(`.square-${pm.from}`).addClass('square-premove');
        $(`.square-${pm.to}`).addClass('square-premove');
    });
    if (pendingPremoves.length > 0) {
        $('#btn-clear-premove').removeClass('hidden-element');
    } else {
        $('#btn-clear-premove').addClass('hidden-element');
    }
}

function clearPendingPremoves() {
    pendingPremoves = [];
    renderPremoveHighlights();
}

function updateCheckHighlight() {
    $('.square-55d63').removeClass('king-in-check checkmate-king');
    const activeChess = isAnalysisMode ? analysisGame : game;
    const isMate = activeChess.in_checkmate();
    const isCheck = activeChess.in_check();
    if (!isMate && !isCheck) return;

    const turn = activeChess.turn();
    const pieces = activeChess.board();
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const piece = pieces[r][c];
            if (piece && piece.type === 'k' && piece.color === turn) {
                const square = 'abcdefgh'[c] + (8 - r);
                $(`.square-${square}`).addClass('king-in-check');
                if (isMate) {
                    $(`.square-${square}`).addClass('checkmate-king');
                }
                return;
            }
        }
    }
}

function reapplyBoardHighlights() {
    if (lastMoveFrom && lastMoveTo) {
        $(`.square-${lastMoveFrom}`).addClass('square-highlight-from');
        $(`.square-${lastMoveTo}`).addClass('square-highlight-to');
    }
    renderPremoveHighlights();
    updateCheckHighlight();
    if (selectedSquare) {
        selectSquareAndHighlightTargets(selectedSquare);
    }
}

function flashCheckmatedKing() {
    updateCheckHighlight();
}

var pendingPromotion = null;
function showPromotionSelector(color, callback) {
    const selector = $('#promotion-selector');
    $('#promo-queen').attr('src', getPieceThemeUrl(`${color}Q`));
    $('#promo-rook').attr('src', getPieceThemeUrl(`${color}R`));
    $('#promo-bishop').attr('src', getPieceThemeUrl(`${color}B`));
    $('#promo-knight').attr('src', getPieceThemeUrl(`${color}N`));
    selector.removeClass('hidden-element');
    pendingPromotion = { callback };
}

function hidePromotionSelector() {
    $('#promotion-selector').addClass('hidden-element');
    pendingPromotion = null;
}

// ============================================================================
// 7. OPENING BOOK EXPLORER & LIVE NOTATION LOG
// ============================================================================
const ECO_OPENING_BOOK = [
    { moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6", name: "B90 Sicilian Defense: Najdorf Variation" },
    { moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6", name: "B70 Sicilian Defense: Dragon Variation" },
    { moves: "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4", name: "B32 Sicilian Defense: Open" },
    { moves: "e4 c5 Nf3 Nc6", name: "B30 Sicilian: Old Sicilian" },
    { moves: "e4 c5 c3", name: "B22 Sicilian Defense: Alapin Variation" },
    { moves: "e4 c5 Nc3", name: "B23 Sicilian Defense: Closed" },
    { moves: "e4 c5 Nf3", name: "B27 Sicilian Defense" },
    { moves: "e4 c5", name: "B20 Sicilian Defense" },
    { moves: "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O", name: "C84 Ruy Lopez: Closed" },
    { moves: "e4 e5 Nf3 Nc6 Bb5 a6", name: "C70 Ruy Lopez: Morphy Defense" },
    { moves: "e4 e5 Nf3 Nc6 Bb5 Nf6", name: "C65 Ruy Lopez: Berlin Defense" },
    { moves: "e4 e5 Nf3 Nc6 Bb5", name: "C60 Ruy Lopez" },
    { moves: "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4", name: "C54 Giuoco Piano" },
    { moves: "e4 e5 Nf3 Nc6 Bc4 Bc5", name: "C50 Italian Game: Giuoco Piano" },
    { moves: "e4 e5 Nf3 Nc6 Bc4 Nf6", name: "C55 Italian Game: Two Knights Defense" },
    { moves: "e4 e5 Nf3 Nc6 Bc4", name: "C50 Italian Game" },
    { moves: "e4 e5 Nf3 Nc6 d4 exd4 Nxd4", name: "C45 Scotch Game" },
    { moves: "e4 e5 Nf3 Nc6 d4", name: "C45 Scotch Game" },
    { moves: "e4 e5 Nf3 Nf6", name: "C42 Petrov's Defense" },
    { moves: "e4 e5 f4", name: "C30 King's Gambit" },
    { moves: "e4 e5 Nc3", name: "C25 Vienna Game" },
    { moves: "e4 e6 d4 d5 Nc3", name: "C10 French Defense: Classical" },
    { moves: "e4 e6 d4 d5 Nd2", name: "C03 French Defense: Tarrasch" },
    { moves: "e4 e6 d4 d5 e5", name: "C02 French Defense: Advance" },
    { moves: "e4 e6 d4 d5", name: "C00 French Defense" },
    { moves: "e4 e6", name: "C00 French Defense" },
    { moves: "e4 c6 d4 d5 Nc3", name: "B15 Caro-Kann Defense: Main Line" },
    { moves: "e4 c6 d4 d5 e5", name: "B12 Caro-Kann Defense: Advance" },
    { moves: "e4 c6 d4 d5", name: "B12 Caro-Kann Defense" },
    { moves: "e4 c6", name: "B10 Caro-Kann Defense" },
    { moves: "e4 d5 exd5 Qxd5", name: "B01 Scandinavian Defense" },
    { moves: "e4 d5", name: "B01 Scandinavian Defense" },
    { moves: "e4 d6 d4 Nf6 Nc3 g6", name: "B07 Pirc Defense" },
    { moves: "e4 g6", name: "B06 Modern Defense" },
    { moves: "e4 Nf6", name: "B02 Alekhine's Defense" },
    { moves: "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6", name: "E60 King's Indian Defense" },
    { moves: "d4 Nf6 c4 g6 Nc3 Bg7", name: "E60 King's Indian Defense" },
    { moves: "d4 Nf6 c4 g6 Nc3 d5", name: "D80 Grünfeld Defense" },
    { moves: "d4 Nf6 c4 e6 Nc3 Bb4", name: "E20 Nimzo-Indian Defense" },
    { moves: "d4 Nf6 c4 e6 Nf3 b6", name: "E12 Queen's Indian Defense" },
    { moves: "d4 Nf6 c4 c5 d5 b5", name: "A57 Benko Gambit" },
    { moves: "d4 Nf6 c4 c5 d5", name: "A56 Benoni Defense" },
    { moves: "d4 d5 c4 e6 Nc3 Nf6", name: "D37 Queen's Gambit Declined" },
    { moves: "d4 d5 c4 e6", name: "D30 Queen's Gambit Declined" },
    { moves: "d4 d5 c4 c6", name: "D10 Slav Defense" },
    { moves: "d4 d5 c4 dxc4", name: "D20 Queen's Gambit Accepted" },
    { moves: "d4 d5 c4", name: "D06 Queen's Gambit" },
    { moves: "d4 d5 Bf4", name: "D00 London System" },
    { moves: "d4 Nf6 Bf4", name: "A45 London System" },
    { moves: "d4 f5", name: "A80 Dutch Defense" },
    { moves: "c4 e5", name: "A20 English Opening: King's English" },
    { moves: "c4 c5", name: "A30 English Opening: Symmetrical" },
    { moves: "c4", name: "A10 English Opening" },
    { moves: "Nf3 d5 c4", name: "A09 Réti Opening" },
    { moves: "Nf3", name: "A04 Zukertort Opening" },
    { moves: "e4 e5", name: "C20 Open Game" },
    { moves: "e4", name: "B00 King's Pawn Opening" },
    { moves: "d4", name: "A40 Queen's Pawn Opening" }
];

function updateOpeningExplorerBadge(movesArray) {
    const historySan = movesArray || game.history();
    if (!historySan || historySan.length === 0) {
        $('#opening-name-badge').text("Starting Position");
        return;
    }
    const line = historySan.join(" ");
    for (let i = 0; i < ECO_OPENING_BOOK.length; i++) {
        if (line.startsWith(ECO_OPENING_BOOK[i].moves)) {
            $('#opening-name-badge').text(ECO_OPENING_BOOK[i].name);
            return;
        }
    }
    $('#opening-name-badge').text("Standard Match");
}

function renderLiveMoveNotation() {
    const moves = game.history();
    analysisMovesList = moves.slice();
    if (!isAnalysisMode) {
        analysisCurrentIndex = analysisMovesList.length - 1;
    }

    if (moves.length > 0 || isMatchActive || isAnalysisMode) {
        $('#analysis-moves-panel').removeClass('hidden-element');
    }

    updateOpeningExplorerBadge(moves);

    const logsBox = $('#notation-list-box').empty();
    let moveNum = 1;
    for (let i = 0; i < analysisMovesList.length; i += 2) {
        const wMove = analysisMovesList[i];
        const bMove = analysisMovesList[i + 1] || "";
        logsBox.append(`
            <div class="notation-row-num">${moveNum}.</div>
            <div class="notation-move-cell ${analysisCurrentIndex === i ? 'active-move' : ''}" data-idx="${i}" id="move-index-${i}">${sanitizeHTML(wMove)}</div>
            <div class="notation-move-cell ${analysisCurrentIndex === i + 1 ? 'active-move' : ''}" data-idx="${i + 1}" id="move-index-${i + 1}">${sanitizeHTML(bMove)}</div>
        `);
        moveNum++;
    }

    if (logsBox[0] && !isAnalysisMode) {
        logsBox.scrollTop(logsBox[0].scrollHeight);
    }

    $('.notation-move-cell').off('click').on('click', function () {
        const idx = parseInt($(this).data('idx'), 10);
        if (!isNaN(idx) && idx < analysisMovesList.length && (gameResultSettled || isSpectator || isAnalysisMode)) {
            isAnalysisMode = true;
            analysisCurrentIndex = idx;
            displayHistoricalMoveIndex();
        }
    });
}

function displayHistoricalMoveIndex() {
    analysisGame.reset();
    let lastMoveObj = null;
    for (let i = 0; i <= analysisCurrentIndex && i < analysisMovesList.length; i++) {
        lastMoveObj = analysisGame.move(analysisMovesList[i]);
    }
    board.position(analysisGame.fen(), false);
    clearSquareSelection();
    if (lastMoveObj) {
        highlightLastMove(lastMoveObj.from, lastMoveObj.to);
    } else {
        clearMoveHighlights();
    }
    updateCheckHighlight();
    updateCapturedPiecesAndMaterial();
    calculateSimulatedEvaluation(analysisGame.fen());
    updateOpeningExplorerBadge(analysisMovesList.slice(0, analysisCurrentIndex + 1));

    $('.notation-move-cell').removeClass('active-move');
    if (analysisCurrentIndex >= 0) {
        $(`#move-index-${analysisCurrentIndex}`).addClass('active-move');
    }
}

// ============================================================================
// 8. CLOCK ENGINE (ISOLATED FOR BOTH PLAYERS & SPECTATORS)
// ============================================================================
function formatSecondsToDigitalString(totalSeconds) {
    if (totalSeconds <= 0) return "00:00";
    if (totalSeconds < 10) {
        return "00:0" + Math.max(0, totalSeconds).toFixed(1);
    }
    var whole = Math.ceil(totalSeconds);
    var minutes = Math.floor(whole / 60);
    var seconds = whole % 60;
    return (minutes < 10 ? "0" : "") + minutes + ":" + (seconds < 10 ? "0" : "") + seconds;
}

function updateActiveClockGlow() {
    if (!isMatchActive || gameResultSettled) {
        $('#user-clock, #opponent-clock').removeClass('clock-running');
        return;
    }
    const bottomColor = isSpectator ? 'w' : myAssignedColor;
    if (game.turn() === bottomColor) {
        $('#user-clock').addClass('clock-running');
        $('#opponent-clock').removeClass('clock-running');
    } else {
        $('#opponent-clock').addClass('clock-running');
        $('#user-clock').removeClass('clock-running');
    }
}

function runChessClockEngine() {
    clearInterval(chessClockTicker);
    if (!isMatchActive || gameResultSettled) return;
    updateActiveClockGlow();

    let lastFrame = Date.now();
    chessClockTicker = setInterval(function () {
        if (game.game_over() || gameResultSettled || !isMatchActive) {
            clearInterval(chessClockTicker);
            return;
        }
        if (currentMode !== 'solo' && game.history().length < 2) {
            lastFrame = Date.now();
            return;
        }

        const now = Date.now();
        const dt = (now - lastFrame) / 1000;
        lastFrame = now;

        const bottomColor = isSpectator ? 'w' : myAssignedColor;
        if (bottomColor === game.turn()) {
            userTimeRemaining = Math.max(0, userTimeRemaining - dt);
            $('#user-clock').text(formatSecondsToDigitalString(userTimeRemaining));
            if (userTimeRemaining <= 0 && currentMode === 'solo') {
                $('#user-clock').text("00:00").addClass('clock-flagged').removeClass('clock-running');
                handleMatchCompletion('loss', 'timeout');
            }
        } else {
            opponentTimeRemaining = Math.max(0, opponentTimeRemaining - dt);
            $('#opponent-clock').text(formatSecondsToDigitalString(opponentTimeRemaining));
            if (opponentTimeRemaining <= 0 && currentMode === 'solo') {
                $('#opponent-clock').text("00:00").addClass('clock-flagged').removeClass('clock-running');
                handleMatchCompletion('win', 'timeout');
            }
        }
    }, 100);
}

// ============================================================================
// 9. BOT WORKER & EVALUATION
// ============================================================================
function executeBotTurn() {
    if (game.game_over() || !isMatchActive) return;
    isBotThinking = true;
    $('#game-phase').text(`Status: Engine computing...`);
    botWorker.postMessage({
        type: 'MOVE',
        fen: game.fen(),
        difficulty: $('#bot-difficulty-select').val()
    });
}

botWorker.onmessage = function (e) {
    const data = e.data;
    if (!data) return;

    if (data.type === 'EVAL_RESULT') {
        renderEvalGauge(data.centipawns, data.bestMoveSan);
        return;
    }

    if (data.type === 'BOT_MOVE') {
        if (!isBotThinking || !isMatchActive) return;
        isBotThinking = false;
        const move = data.move;
        if (move) {
            const applied = game.move(move);
            if (applied) {
                clearSquareSelection();
                highlightLastMove(applied.from, applied.to);
                board.position(game.fen());
                updateCheckHighlight();
                updateCapturedPiecesAndMaterial();
                renderLiveMoveNotation();
                EventBus.emit('moveMade', { captured: !!applied.captured });
                if (applied.flags && (applied.flags.includes('k') || applied.flags.includes('q'))) EventBus.emit('castle');
                if (applied.promotion) EventBus.emit('promotion');
            }
        }
        runChessClockEngine();
        checkGameStatus();
        updateLifecycleButtons();
        updateTurnStatusDisplay();
    }
};

function renderEvalGauge(centipawns, bestMoveSan = null) {
    const pawns = (centipawns || 0) / 100;
    const clamped = Math.max(-10, Math.min(10, pawns));
    const percentageFill = Math.max(5, Math.min(95, 50 + (clamped * 4.5)));
    $('#eval-bar-fill').css('height', percentageFill + '%');
    $('#eval-text').text((pawns >= 0 ? "+" : "") + pawns.toFixed(1));

    if (bestMoveSan && (isAnalysisMode || gameResultSettled)) {
        $('#engine-best-move-badge').text(`Best: ${bestMoveSan}`).removeClass('hidden-element');
    } else if (!bestMoveSan) {
        $('#engine-best-move-badge').addClass('hidden-element');
    }
}

function calculateSimulatedEvaluation(targetFen) {
    if (!targetFen || targetFen === 'start') {
        renderEvalGauge(0, null);
        return;
    }
    botWorker.postMessage({ type: 'EVAL', fen: targetFen });
}

// ============================================================================
// 10. STATE PERSISTENCE & LIFECYCLE
// ============================================================================
function saveGameState() {
    if (!activeMatchId || isSpectator || isReplayMode) return;
    const state = {
        fen: game.fen(),
        pgn: game.pgn(),
        userTimeRemaining,
        opponentTimeRemaining,
        myAssignedColor,
        activeMatchId,
        userWalletAddress,
        playerRatings,
        opponentRatings,
        timeControl: $('#time-control-select').val(),
        stake: $('#stake-amount-input').val(),
        gameResultSettled,
        isMatchActive,
        isPaidMode,
        myUsername,
        opponentUsername,
        opponentWallet,
        localClientId
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function restoreGameState() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return false;
    try {
        const state = JSON.parse(saved);
        if (!state.activeMatchId || state.gameResultSettled) {
            localStorage.removeItem(STORAGE_KEY);
            return false;
        }

        activeMatchId = state.activeMatchId;
        myAssignedColor = state.myAssignedColor || 'w';
        isPaidMode = !!state.isPaidMode;
        userTimeRemaining = state.userTimeRemaining || 180;
        opponentTimeRemaining = state.opponentTimeRemaining || 180;
        gameResultSettled = false;
        isMatchActive = state.isMatchActive || false;
        mySessionId = null;
        isAuthenticated = !isPaidMode;

        if (!userWalletAddress && state.userWalletAddress) {
            userWalletAddress = state.userWalletAddress.toLowerCase();
        }
        if (state.opponentUsername) opponentUsername = state.opponentUsername;
        if (state.opponentWallet) opponentWallet = state.opponentWallet;
        if (state.opponentRatings) opponentRatings = state.opponentRatings;

        if (state.pgn) {
            game.load_pgn(state.pgn);
        } else if (state.fen) {
            game.load(state.fen);
        }

        $('#home-view-container').addClass('hidden-element');
        $('#arena-app-wrapper').removeClass('hidden-element');

        if (board === null) initChessboard();
        else board.position(game.fen(), false);

        board.orientation(myAssignedColor === 'b' ? 'black' : 'white');
        updateProfileRatingsDisplay();
        updateCapturedPiecesAndMaterial();
        reapplyBoardHighlights();
        renderLiveMoveNotation();
        updateFloatingControls();

        $('#user-clock').text(formatSecondsToDigitalString(userTimeRemaining));
        $('#opponent-clock').text(formatSecondsToDigitalString(opponentTimeRemaining));

        establishP2PConnection(activeMatchId, true);
        return true;
    } catch (e) {
        console.error("Restore failed:", e);
        return false;
    }
}

function strengthenReconnection() {
    if (!activeMatchId) {
        showToast("No active match to reconnect to.", "warn");
        return;
    }
    establishP2PConnection(activeMatchId, true, true);
    appendSystemMessage("🔄 Re-synchronizing board & clocks with Oracle...", false);
}

function updateLifecycleButtons() {
    var historyCount = game.history().length;
    const canAct = !gameResultSettled && historyCount >= 2 && isMatchActive && !isSpectator && (!isPaidMode || isAuthenticated);
    $('#btn-resign').prop('disabled', !canAct);
    $('#btn-draw').prop('disabled', !(canAct && currentMode !== 'solo'));
    $('#btn-abort').prop('disabled', historyCount >= 2 || !isMatchActive || isSpectator || (isPaidMode && !isAuthenticated));
}

// ============================================================================
// 11. CHALLENGE LINKS (WITH CANCEL/REFUND & CLEAN URL RESTORATION) & SPECTATOR
// ============================================================================
function clearChallengeQueryFromUrl() {
    if (window.location.search.includes('challengeMatchId') || window.location.hash) {
        const cleanUrl = window.location.origin + window.location.pathname;
        window.history.replaceState({}, document.title, cleanUrl);
    }
}

async function createChallengeLink() {
    if (currentMode === 'solo') {
        showToast("Switch to Two Players mode to create a challenge link.", "warn");
        return;
    }
    const stake = normalizeStake($('#stake-amount-input').val() || 0.01);
    if (isPaidMode && (!userWalletAddress || !stake)) {
        showToast("Connect your wallet and enter a valid wager amount.", "error");
        return;
    }
    const tc = getTimeControlValue();
    const sidePref = 0; // On-chain createChallenge assigns creator to playerWhite
    const matchId = "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('');

    const ephemeralWallet = ethers.Wallet.createRandom();
    const ephemeralPublicKey = ephemeralWallet.address;
    const ephemeralPrivateKey = ephemeralWallet.privateKey;

    activeMatchId = matchId;
    createdChallengeMatchId = matchId;
    myAssignedColor = 'w';

    const base = window.location.origin + window.location.pathname;
    const link = `${base}?challengeMatchId=${matchId}&tc=${tc}&stake=${stake || '0'}&paid=${isPaidMode}&sidePref=${sidePref}#${ephemeralPrivateKey}`;

    if (isPaidMode) {
        try {
            await getOrCreateDelegatedSession(userWalletAddress, signer);
            const tx = await chessContractInstance.createChallenge(matchId, tc, ephemeralPublicKey, {
                value: ethers.utils.parseEther(stake.toString())
            });
            showToast("Creating challenge on-chain...", "info");
            await tx.wait();
            $('#challenge-link-text').text(link);
            $('#challenge-link-display').removeClass('hidden-element');
            establishP2PConnection(matchId, false);
            showToast("Challenge link ready! Share it with your opponent.", "success");
        } catch (err) {
            createdChallengeMatchId = null;
            activeMatchId = null;
            showToast("Challenge creation failed: " + (err.reason || err.message), "error");
        }
    } else {
        $('#challenge-link-text').text(link);
        $('#challenge-link-display').removeClass('hidden-element');
        establishP2PConnection(matchId, false);
        showToast("Free challenge link created! Waiting for opponent...", "success");
    }
}

async function cancelCreatedChallengeLink() {
    const targetMatchId = createdChallengeMatchId || activeMatchId;
    if (!targetMatchId) {
        $('#challenge-link-display').addClass('hidden-element');
        return;
    }

    if (isPaidMode && chessContractInstance && userWalletAddress) {
        try {
            $('#btn-cancel-challenge').prop('disabled', true).text("Refunding...");
            const tx = await chessContractInstance.cancelCreatedMatch(targetMatchId);
            showToast("Cancelling challenge & refunding stake on-chain...", "info");
            await tx.wait();
            showToast("Challenge cancelled and stake refunded in full!", "success");
        } catch (err) {
            showToast("Cancel challenge failed: " + (err.reason || err.message), "error");
            $('#btn-cancel-challenge').prop('disabled', false).text("Cancel & Refund");
            return;
        } finally {
            $('#btn-cancel-challenge').prop('disabled', false).text("Cancel & Refund");
        }
    } else {
        showToast("Challenge link cancelled.", "info");
    }

    createdChallengeMatchId = null;
    $('#challenge-link-display').addClass('hidden-element');
    resetMatchEnvironment();
}

function checkForChallengeLink() {
    const params = new URLSearchParams(window.location.search);
    const challengeMatchId = params.get('challengeMatchId');
    if (!challengeMatchId || !/^0x[0-9a-fA-F]{64}$/.test(challengeMatchId)) return;

    activeMatchId = challengeMatchId;
    isPaidMode = params.get('paid') === 'true';
    const stake = normalizeStake(params.get('stake')) || '0.01';
    const parsedTc = parseInt(params.get('tc'), 10);
    const tcVal = isNaN(parsedTc) ? 1 : parsedTc;
    const sidePref = parseInt(params.get('sidePref'), 10) || 0;

    $('#toggle-paid-mode').prop('checked', isPaidMode);
    $('#staking-ui-container').toggleClass('disabled-ui', !isPaidMode);
    $('#stake-amount-input').val(stake);
    $('#time-control-select').val(tcVal === 0 ? "bullet" : (tcVal === 1 ? "blitz" : "rapid"));
    $('#side-pref-container input[value="' + sidePref + '"]').prop('checked', true);

    const hashAnchor = window.location.hash;
    const ephemeralPrivateKey = (hashAnchor && hashAnchor.startsWith('#')) ? hashAnchor.substring(1) : null;

    clearChallengeQueryFromUrl();

    $('#arena-app-wrapper').removeClass('hidden-element');
    $('#home-view-container').addClass('hidden-element');
    if (board === null) initChessboard();
    updateFloatingControls();

    if (isPaidMode) {
        pendingChallengeInvite = {
            challengeMatchId,
            stake,
            ephemeralPrivateKey
        };
        $('#btn-find-match').text(`ACCEPT CHALLENGE (${stake} zkLTC)`);
    } else {
        myAssignedColor = (sidePref === 0) ? 'b' : 'w';
        establishP2PConnection(challengeMatchId, false);
        $('#match-settings-box').addClass('hidden-element');
    }
}

async function acceptPendingPaidChallenge() {
    if (!pendingChallengeInvite) return;
    const { challengeMatchId, stake, ephemeralPrivateKey } = pendingChallengeInvite;

    if (!userWalletAddress) {
        await connectWeb3Wallet();
        if (!userWalletAddress) return;
    }
    if (!ephemeralPrivateKey) {
        showToast("Invalid challenge link (missing ephemeral key).", "error");
        return;
    }
    try {
        $('#btn-find-match').prop('disabled', true).text("Accepting Challenge...");
        await getOrCreateDelegatedSession(userWalletAddress, signer);
        const localEphemeralWallet = new ethers.Wallet(ephemeralPrivateKey);
        const messageHash = ethers.utils.solidityKeccak256(["address", "bytes32"], [userWalletAddress, challengeMatchId]);
        const signature = await localEphemeralWallet.signMessage(ethers.utils.arrayify(messageHash));
        const tx = await chessContractInstance.joinChallenge(challengeMatchId, signature, {
            value: ethers.utils.parseEther(stake.toString())
        });
        appendSystemMessage("⛓️ Submitting joinChallenge transaction...", false);
        await tx.wait();
        pendingChallengeInvite = null;
        myAssignedColor = 'b';
        activeMatchId = challengeMatchId;
        clearChallengeQueryFromUrl();
        establishP2PConnection(challengeMatchId, false);
    } catch (err) {
        $('#btn-find-match').prop('disabled', false).text(`ACCEPT CHALLENGE (${stake} zkLTC)`);
        showToast("Failed to join challenge: " + (err.reason || err.message), "error");
    }
}

function spectateMatchById(matchId) {
    if (!matchId) return;
    if (isMatchActive && !gameResultSettled && !isSpectator) {
        showToast("Finish or abort your current match before spectating.", "warn");
        return;
    }
    resetMatchEnvironment();
    activeMatchId = matchId;
    isSpectator = true;
    myAssignedColor = 'w';
    $('#home-view-container').addClass('hidden-element');
    $('#arena-app-wrapper').removeClass('hidden-element');
    if (board === null) initChessboard();
    board.orientation('white');
    reapplyBoardHighlights();
    updateFloatingControls();

    if (p2pSocket && p2pSocket.readyState !== WebSocket.CLOSED) p2pSocket.close();
    p2pSocket = new WebSocket(WS_URL);
    p2pSocket._matchId = matchId;
    p2pSocket.onopen = function () {
        p2pSocket.send(JSON.stringify({
            type: 'JOIN_ROOM',
            matchId: matchId,
            spectate: true,
            username: myUsername,
            wallet: userWalletAddress || null
        }));
    };
    p2pSocket.onmessage = function (event) {
        handleStandardP2PMessage(JSON.parse(event.data), false);
    };
}

function enterSpectatorMode() {
    isSpectator = true;
    myAssignedColor = 'w';
    if (board) {
        board.orientation('white');
        reapplyBoardHighlights();
    }
    $('#spectator-banner').removeClass('hidden-element');
    $('#match-settings-box').addClass('hidden-element');
    $('#analysis-moves-panel').removeClass('hidden-element');
    $('#live-action-controls, #post-game-controls').addClass('hidden-element');

    // Enable isolated Spectator Lounge (Railbird Chat)
    $('#combat-chat-heading').text('👁️ Spectator Lounge (Railbird Chat)');
    $('#chat-text-input').attr('placeholder', "Railbird chat (players can't see)...");
    setChatEnabled(true);
    appendSystemMessage("👁️ Connected to live spectator feed. Railbird chat is private to spectators.", false);
}

// ============================================================================
// 12. USERNAME REGISTRY, WALLET MANAGEMENT & PULL-PAYMENT PAYOUT CLAIM
// ============================================================================
async function checkClaimablePayoutBalance() {
    if (!userWalletAddress || !chessContractInstance) {
        $('#btn-claim-payout').addClass('hidden-element');
        return;
    }
    try {
        const claimableWei = await chessContractInstance.claimableBalances(userWalletAddress);
        if (claimableWei && claimableWei.gt(0)) {
            const formatted = parseFloat(ethers.utils.formatEther(claimableWei)).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
            $('#btn-claim-payout').text(`💰 Claim ${formatted} zkLTC`).removeClass('hidden-element');
            showToast(`You have ${formatted} zkLTC available to claim from escrow!`, "info");
        } else {
            $('#btn-claim-payout').addClass('hidden-element');
        }
    } catch (_) {
        $('#btn-claim-payout').addClass('hidden-element');
    }
}

async function claimFailedPayoutOnChain() {
    if (!userWalletAddress || !chessContractInstance) return;
    try {
        $('#btn-claim-payout').prop('disabled', true).text("Claiming...");
        const tx = await chessContractInstance.claimFailedPayout();
        showToast("Withdrawing claimable balance from LitVM Escrow...", "info");
        await tx.wait();
        showToast("Escrow balance claimed to your wallet!", "success");
        await checkClaimablePayoutBalance();
    } catch (err) {
        showToast("Claim failed: " + (err.reason || err.message), "error");
    } finally {
        $('#btn-claim-payout').prop('disabled', false);
    }
}

async function fetchAndSetUsername() {
    if (!userWalletAddress || !web3Provider) return;
    const registry = new ethers.Contract(USERNAME_REGISTRY_ADDRESS, USERNAME_REGISTRY_ABI, web3Provider);
    try {
        const onChainName = await registry.getUsername(userWalletAddress);
        if (onChainName && onChainName.trim().length > 0) {
            myUsername = onChainName.trim();
            updateProfileRatingsDisplay();
            return;
        }
    } catch (e) {
        console.warn("Username lookup warning:", e);
    }
    $('#username-modal').removeClass('hidden-element');
}

function setupUsernameModalHandlers() {
    $('#btn-username-skip').click(function () {
        $('#username-modal').addClass('hidden-element');
        myUsername = userWalletAddress ? ("Anon_" + userWalletAddress.slice(-4)) : "Player";
        updateProfileRatingsDisplay();
    });

    $('#btn-username-submit').click(async function () {
        let newName = $('#username-modal-input').val().trim().toLowerCase();
        if (!newName || newName.length > 20) {
            showToast("Enter a valid username (1–20 characters).", "warn");
            return;
        }
        try {
            $(this).prop('disabled', true).text("Signing...");
            const registryWrite = new ethers.Contract(USERNAME_REGISTRY_ADDRESS, USERNAME_REGISTRY_ABI, signer);
            const tx = await registryWrite.registerUsername(newName);
            showToast("Registering username on LitVM...", "info");
            await tx.wait();
            myUsername = newName;
            updateProfileRatingsDisplay();
            $('#username-modal').addClass('hidden-element');
            showToast(`Identity "${myUsername}" registered on-chain!`, "success");
            if (window.LitSocial && typeof window.LitSocial.onUsernameRegistered === 'function') {
                window.LitSocial.onUsernameRegistered();
            }
        } catch (err) {
            showToast("Registration failed or cancelled. Using Anon handle.", "warn");
            myUsername = "Anon_" + userWalletAddress.slice(-4);
            updateProfileRatingsDisplay();
            $('#username-modal').addClass('hidden-element');
        } finally {
            $(this).prop('disabled', false).text("Register On-Chain");
        }
    });
}

async function autoReconnectWallet() {
    if (typeof window.ethereum === 'undefined') return;
    try {
        const accounts = await window.ethereum.request({ method: 'eth_accounts' });
        if (accounts.length > 0) {
            userWalletAddress = accounts[0].toLowerCase();
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            signer = provider.getSigner();
            web3Provider = provider;
            chessContractInstance = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);

            const truncated = userWalletAddress.slice(0, 6) + "..." + userWalletAddress.slice(-4);
            $('#wallet-address').text(truncated);
            $('#btn-connect-wallet-landing').text(`❌ DISCONNECT (${truncated})`).addClass('btn-wallet-disconnect');
            $('#btn-connect-wallet-arena').text('Disconnect').addClass('btn-wallet-disconnect');

            await fetchAndSetUsername();
            await checkClaimablePayoutBalance();
            setupGlobalMatchListener();

            if (window.LitSocial && typeof window.LitSocial.onWalletChanged === 'function') {
                window.LitSocial.onWalletChanged(userWalletAddress);
            }
        }
    } catch (_) {}
}

async function connectWeb3Wallet() {
    if (typeof window.ethereum === 'undefined') {
        showToast("MetaMask or Web3 wallet extension not detected.", "error");
        return;
    }
    try {
        const expectedChainId = '0x' + (4441).toString(16);
        const currentChainId = await window.ethereum.request({ method: 'eth_chainId' });
        if (currentChainId !== expectedChainId) {
            try {
                await window.ethereum.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: expectedChainId }]
                });
            } catch (switchError) {
                if (switchError.code === 4902) {
                    await window.ethereum.request({
                        method: 'wallet_addEthereumChain',
                        params: [{
                            chainId: expectedChainId,
                            chainName: 'Liteforge',
                            nativeCurrency: { name: 'zkLTC', symbol: 'zkLTC', decimals: 18 },
                            rpcUrls: ['https://rpc.testnet.liteforge.zeeve.net']
                        }]
                    });
                } else {
                    showToast("Please switch your wallet network to Liteforge.", "warn");
                    return;
                }
            }
        }

        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        if (accounts.length === 0) throw new Error("No accounts authorized");
        userWalletAddress = accounts[0].toLowerCase();

        const provider = new ethers.providers.Web3Provider(window.ethereum);
        signer = provider.getSigner();
        web3Provider = provider;
        chessContractInstance = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);

        await getOrCreateDelegatedSession(userWalletAddress, signer);

        const truncated = userWalletAddress.slice(0, 6) + "..." + userWalletAddress.slice(-4);
        $('#wallet-address').text(truncated);
        $('#btn-connect-wallet-landing').text(`❌ DISCONNECT (${truncated})`).addClass('btn-wallet-disconnect');
        $('#btn-connect-wallet-arena').text('Disconnect').addClass('btn-wallet-disconnect');
        $('#btn-find-match').prop('disabled', false);

        showToast(`Connected & session key verified: ${truncated}`, "success");
        await fetchAndSetUsername();
        await checkClaimablePayoutBalance();
        setupGlobalMatchListener();

        if (window.LitSocial && typeof window.LitSocial.onWalletChanged === 'function') {
            window.LitSocial.onWalletChanged(userWalletAddress);
        }
    } catch (err) {
        showToast("Wallet connection cancelled or failed.", "error");
    }
}

function disconnectWeb3Wallet() {
    userWalletAddress = null;
    signer = null;
    web3Provider = null;
    chessContractInstance = null;
    authSignature = null;
    myUsername = "Player";
    updateProfileRatingsDisplay();
    $('#wallet-address').text('Not Connected');
    $('#btn-claim-payout').addClass('hidden-element');
    $('#btn-connect-wallet-landing').text('🔗 CONNECT WALLET').removeClass('btn-wallet-disconnect');
    $('#btn-connect-wallet-arena').text('Connect').removeClass('btn-wallet-disconnect');
    if (window.LitSocial && typeof window.LitSocial.onWalletChanged === 'function') {
        window.LitSocial.onWalletChanged(null);
    }
    showToast("Wallet disconnected.", "info");
}

// ============================================================================
// 13. MATCHMAKING & DEDUPLICATED PAIRING COORDINATION
// ============================================================================
function connectToMatchedRoom(matchId, white, black) {
    if (!matchId || !userWalletAddress) return false;
    if (completedMatches.has(matchId)) return false;

    const safeWhite = (white || "").toLowerCase();
    const safeBlack = (black || "").toLowerCase();
    const safeUser = userWalletAddress.toLowerCase();

    if (safeWhite !== safeUser && safeBlack !== safeUser) return false;

    if (
        activeMatchId === matchId &&
        p2pSocket &&
        (p2pSocket.readyState === WebSocket.OPEN || p2pSocket.readyState === WebSocket.CONNECTING)
    ) {
        return true;
    }

    myAssignedColor = (safeWhite === safeUser) ? 'w' : 'b';
    opponentWallet = (safeWhite === safeUser) ? safeBlack : safeWhite;
    isInQueue = false;
    activeMatchId = matchId;
    isPaidMode = true;
    isSpectator = false;
    isReplayMode = false;

    clearAllTimers();
    $('#btn-cancel-queue').addClass('hidden-element');
    $('#btn-find-match').removeClass('hidden-element').prop('disabled', true).text("Match in Progress");

    establishP2PConnection(activeMatchId, false);
    saveGameState();
    showToast(`Match started! You are playing as ${myAssignedColor === 'w' ? 'WHITE' : 'BLACK'}.`, "success");
    return true;
}

function setupGlobalMatchListener() {
    if (globalMatchStartedListener || !web3Provider) return;
    const escrow = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, web3Provider);

    globalMatchStartedListener = (matchId, white, black) => {
        connectToMatchedRoom(matchId, white, black);
    };

    escrow.on("MatchStarted", globalMatchStartedListener);
}

function startQueuePolling() {
    if (queuePollingInterval) clearInterval(queuePollingInterval);
    if (!web3Provider) return;
    const escrow = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, web3Provider);

    queuePollingInterval = setInterval(async () => {
        if (!isInQueue || activeMatchId || !userWalletAddress) {
            clearInterval(queuePollingInterval);
            return;
        }
        try {
            const currentStake = queuedStake || parseFloat($('#stake-amount-input').val()) || 0.01;
            const currentTc = (queuedTc !== undefined && queuedTc !== null) ? queuedTc : getTimeControlValue();

            const pendingMatches = await escrow.getPendingMatches(ethers.utils.parseEther(currentStake.toString()), currentTc);
            if (!isInQueue || activeMatchId) return;

            const safeUser = userWalletAddress.toLowerCase();
            const stillInQueue = pendingMatches.some(p => (p.player || "").toLowerCase() === safeUser);

            if (!stillInQueue) {
                const currentBlock = await web3Provider.getBlockNumber();
                const fromBlock = Math.max(0, currentBlock - 40);
                const filter = escrow.filters.MatchStarted();
                const events = await escrow.queryFilter(filter, fromBlock, currentBlock);

                if (!isInQueue || activeMatchId) return;

                for (let e of events) {
                    const args = e.args || {};
                    const matchId = args.matchId || args[0];
                    const white = args.white || args[1];
                    const black = args.black || args[2];

                    if (connectToMatchedRoom(matchId, white, black)) {
                        return;
                    }
                }
            }
        } catch (_) {}
    }, 3500);
}

async function initiateChainMatchmaking(stake, tcValue, sidePref) {
    if (!signer || !userWalletAddress) {
        showToast("Connect your Web3 wallet first.", "warn");
        return;
    }

    stake = normalizeStake(stake);
    if (!stake) {
        showToast("Invalid wager amount.", "error");
        return;
    }

    $('#btn-find-match').prop('disabled', true).text("Confirming in Wallet...");
    setupGlobalMatchListener();

    try {
        await getOrCreateDelegatedSession(userWalletAddress, signer);

        const escrow = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
        const stakeWei = ethers.utils.parseEther(stake.toString());

        const tx = await escrow.queueForMatch(stakeWei, tcValue, sidePref, { value: stakeWei });
        appendSystemMessage("⛓️ Escrow transaction submitted. Waiting for confirmation...", false);
        const receipt = await tx.wait();

        if (activeMatchId) return;

        let matchEvent = receipt.events?.find(e => e.event === 'MatchStarted');
        if (!matchEvent && receipt.logs) {
            for (let log of receipt.logs) {
                try {
                    const parsed = escrow.interface.parseLog(log);
                    if (parsed && parsed.name === 'MatchStarted') {
                        matchEvent = parsed;
                        break;
                    }
                } catch (_) {}
            }
        }

        if (matchEvent) {
            const args = matchEvent.args || {};
            const matchId = args.matchId || args[0];
            const white = args.white || args[1];
            const black = args.black || args[2];
            connectToMatchedRoom(matchId, white, black);
            return;
        }

        appendSystemMessage("⏳ Queued on-chain. Searching for opponent...", false);
        queuedStake = stake;
        queuedTc = tcValue;
        isInQueue = true;
        isPaidMode = true;
        $('#btn-find-match').addClass('hidden-element');
        $('#btn-cancel-queue').removeClass('hidden-element');
        saveGameState();
        startQueuePolling();

        if (queueTimeout) clearTimeout(queueTimeout);
        queueTimeout = setTimeout(async () => {
            if (isInQueue && !activeMatchId) {
                showToast("Queue timeout reached. Refunding stake...", "warn");
                await cancelQueue(true);
            }
        }, QUEUE_TIMEOUT_SECONDS * 1000);
    } catch (err) {
        let msg = err.reason || err.message || "Transaction rejected";
        showToast("Queue Error: " + msg, "error");
        forceResetQueueUI();
    }
}

function initiateFreeMatchmaking(overrideSidePref = null) {
    isPaidMode = false;
    isInQueue = true;
    const prefToUse = (overrideSidePref !== null && overrideSidePref !== undefined) ? overrideSidePref : getSidePreferenceValue();
    $('#btn-find-match').addClass('hidden-element');
    $('#btn-cancel-queue').removeClass('hidden-element').text("Cancel Queue");
    appendSystemMessage("🔍 Searching for an opponent in Free Mode pool...", false);

    if (p2pSocket && p2pSocket.readyState !== WebSocket.CLOSED) p2pSocket.close();
    p2pSocket = new WebSocket(WS_URL);

    p2pSocket.onopen = function () {
        p2pSocket.send(JSON.stringify({
            type: 'QUEUE_FREE_MATCH',
            wallet: userWalletAddress || null,
            username: myUsername,
            timeControl: $('#time-control-select').val(),
            sidePref: prefToUse
        }));
    };

    p2pSocket.onmessage = function (event) {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'QUEUED_FREE_MATCH') {
                showToast("Joined Free Match queue. Waiting for opponent...", "info", 2500);
                return;
            }
            if (data.type === 'FREE_MATCH_FOUND') {
                isInQueue = false;
                myAssignedColor = data.color;
                isMatchActive = true;
                activeMatchId = data.matchId;
                isAuthenticated = true;

                if (data.opponentName) {
                    opponentUsername = data.opponentName;
                    updateProfileRatingsDisplay();
                }

                $('#btn-cancel-queue').addClass('hidden-element');
                $('#btn-find-match').removeClass('hidden-element').prop('disabled', true).text("Match in Progress");

                board.orientation(myAssignedColor === 'w' ? 'white' : 'black');
                reapplyBoardHighlights();

                p2pSocket.send(JSON.stringify({
                    type: 'JOIN_ROOM',
                    matchId: activeMatchId,
                    color: myAssignedColor,
                    isPaidMode: false,
                    wallet: userWalletAddress || null,
                    username: myUsername
                }));
                return;
            }
            handleStandardP2PMessage(data);
        } catch (_) {}
    };

    p2pSocket.onerror = function () {
        showToast("Error connecting to matchmaking server.", "error");
        forceResetQueueUI();
    };
}

async function initiateTournamentJoin() {
    const rawId = $('#tourney-id-input').val().trim() || 'litforge-main-arena';
    const stake = normalizeStake($('#stake-amount-input').val() || 0.01) || '0.01';

    if (isPaidMode) {
        if (!userWalletAddress || !signer) {
            showToast("Connect your Web3 wallet first to enter a staked tournament.", "warn");
            return;
        }
        try {
            $('#btn-find-match').prop('disabled', true).text("Joining On-Chain Tourney...");
            const escrow = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
            const tourneyBytes32 = ethers.utils.id(rawId);
            const info = await escrow.tournaments(tourneyBytes32);
            const alreadyParticipant = await escrow.tournamentParticipants(tourneyBytes32, userWalletAddress);
            const feeWei = ethers.utils.parseEther(stake);

            if (!alreadyParticipant) {
                if (!info.isActive) {
                    showToast("Initializing new Tournament on LitVM...", "info");
                    const createTx = await escrow.createTournament(tourneyBytes32, feeWei);
                    await createTx.wait();
                }
                const joinTx = await escrow.joinTournament(tourneyBytes32, { value: info.isActive ? info.entryFee : feeWei });
                await joinTx.wait();
                showToast("On-chain tournament entry confirmed!", "success");
            } else {
                showToast("On-chain tournament deposit already verified!", "info");
            }
        } catch (err) {
            showToast("On-chain tournament entry failed or was rejected: " + (err.reason || err.message || ""), "error");
            $('#btn-find-match').prop('disabled', false).text("JOIN TOURNAMENT");
            return;
        } finally {
            $('#btn-find-match').prop('disabled', false).text("JOIN TOURNAMENT");
        }
    }

    $('#tourney-standings-box').removeClass('hidden-element');
    const tourneyPayload = JSON.stringify({
        type: 'CREATE_OR_JOIN_TOURNEY',
        tourneyId: rawId,
        wallet: userWalletAddress || ("guest_" + localClientId),
        username: myUsername,
        entryFee: stake,
        timeControl: $('#time-control-select').val(),
        isPaid: isPaidMode
    });

    if (!p2pSocket || p2pSocket.readyState !== WebSocket.OPEN) {
        p2pSocket = new WebSocket(WS_URL);
        p2pSocket.onopen = () => p2pSocket.send(tourneyPayload);
        p2pSocket.onmessage = (ev) => {
            const d = JSON.parse(ev.data);
            if (d.type === 'FREE_MATCH_FOUND') {
                myAssignedColor = d.color;
                isMatchActive = true;
                activeMatchId = d.matchId;
                isAuthenticated = true;
                if (d.opponentName) {
                    opponentUsername = d.opponentName;
                    updateProfileRatingsDisplay();
                }
                board.orientation(myAssignedColor === 'w' ? 'white' : 'black');
                reapplyBoardHighlights();
                p2pSocket.send(JSON.stringify({
                    type: 'JOIN_ROOM',
                    matchId: activeMatchId,
                    color: myAssignedColor,
                    isPaidMode: false,
                    wallet: userWalletAddress || null,
                    username: myUsername
                }));
            } else {
                handleStandardP2PMessage(d);
            }
        };
    } else {
        p2pSocket.send(tourneyPayload);
    }
    showToast(`Entered Tournament "${rawId}"!`, "success");
}

function establishP2PConnection(matchId, isRestored = false, forceReconnect = false) {
    if (
        !forceReconnect &&
        p2pSocket &&
        (p2pSocket.readyState === WebSocket.OPEN || p2pSocket.readyState === WebSocket.CONNECTING) &&
        p2pSocket._matchId === matchId
    ) {
        return;
    }

    if (p2pSocket && p2pSocket.readyState !== WebSocket.CLOSED) {
        p2pSocket.close();
    }
    p2pSocket = new WebSocket(WS_URL);
    p2pSocket._matchId = matchId;

    p2pSocket.onopen = function () {
        p2pSocket.send(JSON.stringify({
            type: 'JOIN_ROOM',
            matchId: matchId,
            color: myAssignedColor,
            isPaidMode: isPaidMode,
            wallet: userWalletAddress || null,
            timeControlVal: getTimeControlValue(),
            username: myUsername
        }));
    };
    p2pSocket.onerror = function () {
        showToast("WebSocket link interrupted. Click Reconnect if needed.", "warn");
    };
    p2pSocket.onmessage = function (event) {
        handleStandardP2PMessage(JSON.parse(event.data), isRestored);
    };
}

function requestMatchAbort() {
    if (gameResultSettled || !isMatchActive || game.history().length >= 2) return;
    if (p2pSocket && p2pSocket.readyState === WebSocket.OPEN) {
        $('#btn-abort').prop('disabled', true).text("Aborting...");
        $('#game-phase').text(isPaidMode ? "Status: Aborting & Refunding On-Chain..." : "Status: Aborting...");
        appendSystemMessage(
            isPaidMode
                ? "⛓️ Requesting Oracle to abort match and refund stakes in full..."
                : "🛑 Aborting match...",
            false
        );
        p2pSocket.send(JSON.stringify({
            type: 'ABORT_MATCH',
            sessionId: mySessionId,
            isPaidMode: isPaidMode
        }));
        if (abortFallbackTimer) clearTimeout(abortFallbackTimer);
        abortFallbackTimer = setTimeout(() => {
            if (activeMatchId && !gameResultSettled) {
                resetMatchEnvironment();
            }
        }, isPaidMode ? 25000 : 3000);
    } else {
        resetMatchEnvironment();
    }
}

// ============================================================================
// 14. P2P MESSAGE HANDLER
// ============================================================================
function handleStandardP2PMessage(data, isRestored = false) {
    if (!data || !data.type) return;

    // Ignore social handshake banner on match sockets (handled exclusively by lobbySocket)
    if (data.type === 'SOCIAL_HELLO' || data.type === 'LOBBY_TELEMETRY') return;

    if (data.type === 'ERROR') {
        appendSystemMessage("⚠️ " + data.reason, true);
        showToast(data.reason, "error");
        return;
    }

    if (data.type === 'TX_SUBMITTED') {
        $('#tx-status-badge').text(`⛓️ ${data.action === 'ABORT' ? 'Refunding' : 'Settling'} (${data.txHash.slice(0, 8)}...)`).removeClass('hidden-element');
        appendSystemMessage(`⛓️ Oracle submitted on-chain ${data.action.toLowerCase()} tx: ${data.txHash}`, false);
        return;
    }

    if (data.type === 'TX_SETTLED') {
        $('#tx-status-badge').text(`✅ Settled On-Chain`).removeClass('hidden-element');
        appendSystemMessage(`✅ Escrow payout confirmed: ${data.txHash}`, false);
        showToast("On-chain payout confirmed!", "success");
        checkClaimablePayoutBalance();
        return;
    }

    if (data.type === 'TOURNEY_STATE' && data.tournament) {
        const t = data.tournament;
        const box = $('#tourney-leaderboard-list').empty();
        (t.standings || []).forEach((s, idx) => {
            box.append(`<div class="tourney-row"><span>#${idx + 1} ${sanitizeHTML(s.username)}</span><strong>${s.points} pts (${s.wins}W)</strong></div>`);
        });
        return;
    }

    if (data.type === 'MATCH_ABORTED') {
        if (abortFallbackTimer) {
            clearTimeout(abortFallbackTimer);
            abortFallbackTimer = null;
        }
        if (activeMatchId) completedMatches.add(activeMatchId);
        const msg = isPaidMode
            ? `🛑 Match aborted. Full stake refunded on-chain${data.txHash ? ' (' + data.txHash.slice(0, 10) + '...)' : ''}!`
            : "🛑 Match aborted.";
        appendSystemMessage(msg, false);
        showToast(msg, "info", 5000);
        checkClaimablePayoutBalance();
        resetMatchEnvironment();
        return;
    }

    if (data.type === 'SPECTATOR_MODE') {
        if (data.sessionId) mySessionId = data.sessionId;
        enterSpectatorMode();
        return;
    }

    if (data.type === 'RECEIVE_SPECTATOR_CHAT') {
        if (data.fromClientId !== mySessionId) {
            appendSpectatorMessage(data.sender, data.text);
        }
        return;
    }

    if (data.type === 'MOVE_ERROR') {
        showToast("Illegal move: " + data.reason, "error");
        game.undo();
        board.position(game.fen(), false);
        clearSquareSelection();
        updateCheckHighlight();
        updateCapturedPiecesAndMaterial();
        renderLiveMoveNotation();
        updateLifecycleButtons();
        updateTurnStatusDisplay();
        return;
    }

    if (data.type === 'CLOCK_SYNC') {
        if (isMatchActive && !gameResultSettled) {
            if (data.whiteTime !== undefined && data.blackTime !== undefined) {
                const bottomIsWhite = isSpectator ? true : (myAssignedColor === 'w');
                userTimeRemaining = bottomIsWhite ? data.whiteTime : data.blackTime;
                opponentTimeRemaining = bottomIsWhite ? data.blackTime : data.whiteTime;
                $('#user-clock').text(formatSecondsToDigitalString(userTimeRemaining));
                $('#opponent-clock').text(formatSecondsToDigitalString(opponentTimeRemaining));
            }
            updateActiveClockGlow();
        }
        return;
    }

    if (data.type === 'TIME_OUT') {
        const flaggedColor = data.flaggedColor || (data.winnerColor === 'w' ? 'b' : (data.winnerColor === 'b' ? 'w' : null));
        const bottomColor = isSpectator ? 'w' : myAssignedColor;
        if (flaggedColor) {
            if (flaggedColor === bottomColor) {
                userTimeRemaining = 0;
                $('#user-clock').text('00:00').addClass('clock-flagged').removeClass('clock-running');
            } else {
                opponentTimeRemaining = 0;
                $('#opponent-clock').text('00:00').addClass('clock-flagged').removeClass('clock-running');
            }
        }

        if (data.winnerColor) {
            if (isSpectator) {
                appendSystemMessage(`⏱️ Flagged! ${data.winnerColor === 'w' ? 'White' : 'Black'} wins on time.`, false);
                handleMatchCompletion('draw', 'timeout');
            } else {
                handleMatchCompletion(data.winnerColor === myAssignedColor ? 'win' : 'loss', 'timeout');
            }
        } else {
            appendSystemMessage("🤝 Time out against insufficient mating material — Draw!", false);
            handleMatchCompletion('draw', 'timeout_vs_insufficient_material');
        }
        return;
    }

    if (data.type === 'DRAW_OFFER' && data.fromClientId !== mySessionId) {
        pendingDrawOfferFromOpponent = true;
        $('#draw-offer-prompt').removeClass('hidden-element');
        appendSystemMessage("🤝 Opponent offered a draw.", false);
        EventBus.emit('notification');
        return;
    }

    if (data.type === 'DRAW_RESPONSE' && data.fromClientId !== mySessionId) {
        $('#draw-offer-prompt').addClass('hidden-element');
        pendingDrawOfferFromOpponent = false;
        if (data.accepted) handleMatchCompletion('draw', 'mutual_agreement');
        else showToast("Opponent declined draw offer.", "info");
        return;
    }

    switch (data.type) {
        case 'ROOM_JOINED':
            mySessionId = data.sessionId;
            if (data.color && !isSpectator) myAssignedColor = data.color;
            if (opponentDisconnectTimer) {
                clearInterval(opponentDisconnectTimer);
                opponentDisconnectTimer = null;
            }
            isSpectator = false;
            isReplayMode = false;
            isAnalysisMode = false;
            $('#spectator-banner').addClass('hidden-element');
            $('#combat-chat-heading').text('💬 Combat Comms');
            $('#chat-text-input').attr('placeholder', 'Transmit message...');
            board.orientation(myAssignedColor === 'w' ? 'white' : 'black');
            reapplyBoardHighlights();
            setChatEnabled(true);
            isMatchActive = true;
            $('#match-settings-box').addClass('hidden-element');
            $('#analysis-moves-panel').removeClass('hidden-element');
            $('#live-action-controls').removeClass('hidden-element');
            renderLiveMoveNotation();
            EventBus.emit('gameStart');

            if (isPaidMode) {
                isAuthenticated = !!data.authenticated;
                if (data.nonce && !isAuthenticated) {
                    (async () => {
                        try {
                            if (!userWalletAddress || !signer) {
                                await autoReconnectWallet();
                            }
                            if (!userWalletAddress) return;
                            const cleanWallet = userWalletAddress.toLowerCase();
                            const expectedMessage = `LITCHESS_AUTH_${cleanWallet}_${data.nonce}`;
                            const delegateBundle = getCachedDelegatedSession(cleanWallet) || (signer ? await getOrCreateDelegatedSession(cleanWallet, signer) : null);

                            if (delegateBundle && delegateBundle.delegateWallet) {
                                authSignature = await delegateBundle.delegateWallet.signMessage(expectedMessage);
                                if (p2pSocket && p2pSocket.readyState === WebSocket.OPEN) {
                                    p2pSocket.send(JSON.stringify({
                                        type: 'SET_WALLET',
                                        sessionId: mySessionId,
                                        wallet: cleanWallet,
                                        signature: authSignature,
                                        delegateAddress: delegateBundle.delegateAddress,
                                        delegateSignature: delegateBundle.delegateSignature,
                                        isPaidMode: true
                                    }));
                                }
                            } else if (signer) {
                                authSignature = await signer.signMessage(expectedMessage);
                                if (p2pSocket && p2pSocket.readyState === WebSocket.OPEN) {
                                    p2pSocket.send(JSON.stringify({
                                        type: 'SET_WALLET',
                                        sessionId: mySessionId,
                                        wallet: cleanWallet,
                                        signature: authSignature,
                                        isPaidMode: true
                                    }));
                                }
                            }
                        } catch (e) {
                            showToast("Signature required to authenticate match moves.", "error");
                        }
                    })();
                }
            } else {
                isAuthenticated = true;
                startInitialAbortTimer();
            }

            updateLifecycleButtons();
            runChessClockEngine();
            saveGameState();
            break;

        case 'GAME_STATE':
            if (Array.isArray(data.moves)) {
                game.reset();
                for (const m of data.moves) {
                    game.move({ from: m.from, to: m.to, promotion: m.promotion || 'q' });
                }
                if (!isAnalysisMode) {
                    board.position(game.fen(), false);
                }
                if (data.moves.length > 0) {
                    const lm = game.history({ verbose: true }).pop();
                    if (lm) highlightLastMove(lm.from, lm.to);
                }
            }
            if (data.whiteTime !== undefined && data.blackTime !== undefined) {
                const bottomIsWhite = isSpectator ? true : (myAssignedColor === 'w');
                userTimeRemaining = bottomIsWhite ? data.whiteTime : data.blackTime;
                opponentTimeRemaining = bottomIsWhite ? data.blackTime : data.whiteTime;
                $('#user-clock').text(formatSecondsToDigitalString(userTimeRemaining));
                $('#opponent-clock').text(formatSecondsToDigitalString(opponentTimeRemaining));
            }
            if (isSpectator) {
                spectatorWhiteName = data.whiteUsername || 'White';
                spectatorBlackName = data.blackUsername || 'Black';
                opponentWallet = data.blackWallet || null;
                if (data.whiteRatings) playerRatings = data.whiteRatings;
                if (data.blackRatings) opponentRatings = data.blackRatings;
            } else {
                if (myAssignedColor === 'w') {
                    if (data.whiteUsername && data.whiteUsername !== 'White') myUsername = data.whiteUsername;
                    if (data.blackUsername && data.blackUsername !== 'Black') opponentUsername = data.blackUsername;
                    if (data.blackWallet) opponentWallet = data.blackWallet;
                    if (data.whiteRatings) playerRatings = data.whiteRatings;
                    if (data.blackRatings) opponentRatings = data.blackRatings;
                } else {
                    if (data.blackUsername && data.blackUsername !== 'Black') myUsername = data.blackUsername;
                    if (data.whiteUsername && data.whiteUsername !== 'White') opponentUsername = data.whiteUsername;
                    if (data.whiteWallet) opponentWallet = data.whiteWallet;
                    if (data.blackRatings) playerRatings = data.blackRatings;
                    if (data.whiteRatings) opponentRatings = data.whiteRatings;
                }
                if (data.whiteWallet && data.blackWallet) {
                    createdChallengeMatchId = null;
                    $('#challenge-link-display').addClass('hidden-element');
                }
            }
            $('#analysis-moves-panel').removeClass('hidden-element');
            updateProfileRatingsDisplay();
            updateCapturedPiecesAndMaterial();
            updateCheckHighlight();
            renderLiveMoveNotation();
            updateLifecycleButtons();
            updateTurnStatusDisplay();
            runChessClockEngine();
            break;

        case 'WALLET_REGISTERED':
            if (data.color && data.color !== myAssignedColor) {
                myAssignedColor = data.color;
                board.orientation(myAssignedColor === 'w' ? 'white' : 'black');
                reapplyBoardHighlights();
            }
            if (data.username && !isSpectator) myUsername = data.username;
            isAuthenticated = true;
            updateProfileRatingsDisplay();
            updateLifecycleButtons();
            if (data.waitingForOpponent) {
                $('#game-phase').text("Status: Waiting for opponent to accept challenge...");
            } else {
                createdChallengeMatchId = null;
                $('#challenge-link-display').addClass('hidden-element');
                startInitialAbortTimer();
                updateTurnStatusDisplay();
            }
            appendSystemMessage(`🛡️ Cryptographic session verified (${myAssignedColor === 'w' ? 'WHITE' : 'BLACK'}).`, false);
            break;

        case 'USER_INFO':
            if (!isSpectator && (data.fromClientId !== mySessionId || (data.color && data.color !== myAssignedColor))) {
                opponentUsername = String(data.username || 'Opponent').slice(0, 32);
                if (data.wallet) opponentWallet = data.wallet;
                if (data.ratings) opponentRatings = data.ratings;
                updateProfileRatingsDisplay();
                appendSystemMessage(`⚔️ Matched against ${opponentUsername}`, false);
            }
            break;

        case 'RATINGS_UPDATED':
            if (data.ratings) {
                const fmt = $('#time-control-select').val();
                const oldRating = playerRatings[fmt] || 2000;
                playerRatings = data.ratings;
                const newRating = playerRatings[fmt] || 2000;
                const diff = newRating - oldRating;
                if (diff !== 0) {
                    const sign = diff > 0 ? '+' : '';
                    appendSystemMessage(`📈 Rating updated: ${newRating} (${sign}${diff})`, false);
                }
                updateProfileRatingsDisplay();
            }
            break;

        case 'RESIGN':
            if (!gameResultSettled && isMatchActive) {
                appendSystemMessage("🏳️ Opponent resigned. You win!", false);
                handleMatchCompletion('win', 'resignation');
            }
            break;

        case 'OPPONENT_JOINED':
        case 'OPPONENT_RECONNECTED':
            if (opponentDisconnectTimer) {
                clearInterval(opponentDisconnectTimer);
                opponentDisconnectTimer = null;
            }
            createdChallengeMatchId = null;
            $('#challenge-link-display').addClass('hidden-element');
            appendSystemMessage("🟢 Opponent connected to arena.", false);
            if (game.history().length < 2) startInitialAbortTimer();
            updateTurnStatusDisplay();
            break;

        case 'OPPONENT_DISCONNECTED':
            if (!gameResultSettled && isMatchActive) {
                if (opponentDisconnectTimer) clearInterval(opponentDisconnectTimer);
                const waitSecs = game.history().length < 2 ? 25 : 60;
                appendSystemMessage(`⚠️ Opponent disconnected! ${waitSecs}s countdown started...`, true);
                let secondsLeft = waitSecs;
                opponentDisconnectTimer = setInterval(() => {
                    if (gameResultSettled || !isMatchActive) {
                        clearInterval(opponentDisconnectTimer);
                        return;
                    }
                    secondsLeft--;
                    $('#game-phase').text(`Opponent Disconnected (${secondsLeft}s)`);
                    if (secondsLeft <= 0) {
                        clearInterval(opponentDisconnectTimer);
                        if (game.history().length < 2) {
                            requestMatchAbort();
                        }
                    }
                }, 1000);
            }
            break;

        case 'OPPONENT_MOVE':
            if (!gameResultSettled && isMatchActive && data.fromClientId !== mySessionId) {
                if (pendingDrawOfferFromOpponent) {
                    pendingDrawOfferFromOpponent = false;
                    $('#draw-offer-prompt').addClass('hidden-element');
                }
                var targetPiece = game.get(data.to);
                var captured = !!(targetPiece && targetPiece.color !== game.turn());

                const oppMove = game.move({ from: data.from, to: data.to, promotion: data.promotion || 'q' });
                if (!oppMove) {
                    strengthenReconnection();
                    break;
                }
                if (data.whiteTime !== undefined && data.blackTime !== undefined) {
                    const bottomIsWhite = isSpectator ? true : (myAssignedColor === 'w');
                    userTimeRemaining = bottomIsWhite ? data.whiteTime : data.blackTime;
                    opponentTimeRemaining = bottomIsWhite ? data.blackTime : data.whiteTime;
                }
                clearSquareSelection();
                highlightLastMove(data.from, data.to);
                board.position(game.fen());
                updateCheckHighlight();
                updateCapturedPiecesAndMaterial();
                renderLiveMoveNotation();
                EventBus.emit('moveMade', { captured: captured || !!(oppMove.flags && oppMove.flags.includes('e')) });
                if (oppMove.flags && (oppMove.flags.includes('k') || oppMove.flags.includes('q'))) EventBus.emit('castle');
                if (oppMove.promotion) EventBus.emit('promotion');

                if (game.history().length < 2) startInitialAbortTimer();
                else clearTimeout(openingMoveTimer);

                checkGameStatus();
                if (!game.game_over() && !gameResultSettled) {
                    executePremoves();
                }
                runChessClockEngine();
                updateLifecycleButtons();
                updateTurnStatusDisplay();
                saveGameState();
            }
            break;

        case 'RECEIVE_CHAT':
            if (data.fromClientId !== mySessionId) appendMessage(data.sender, data.text);
            break;

        case 'GAME_ENDED':
            if (!gameResultSettled && isMatchActive) {
                const reasonText = data.reason || 'completed';
                if (!data.winnerColor) handleMatchCompletion('draw', reasonText);
                else if (isSpectator) handleMatchCompletion('draw', reasonText);
                else handleMatchCompletion(data.winnerColor === myAssignedColor ? 'win' : 'loss', reasonText);
            }
            break;

        case 'REMATCH_OFFER':
            if (gameResultSettled && data.fromClientId !== mySessionId) {
                showRematchButtons();
                EventBus.emit('notification');
            }
            break;

        case 'REMATCH_RESPONSE':
            if (gameResultSettled && data.fromClientId !== mySessionId && data.accepted) {
                startNewRematch();
            }
            break;
    }
}

// ============================================================================
// 15. PURE CLICK / TAP-AND-DROP BOARD ENGINE, VARIATION BOARD & PREMOVES
// ============================================================================
function canPremove() {
    return currentMode !== 'solo' && isMatchActive && !gameResultSettled && isAuthenticated &&
        game.turn() !== myAssignedColor && !isSpectator && !isAnalysisMode;
}

function executePremoves() {
    if (pendingPremoves.length === 0 || game.game_over() || gameResultSettled) return;
    const pm = pendingPremoves.shift();
    renderPremoveHighlights();

    const move = game.move({ from: pm.from, to: pm.to, promotion: pm.promotion || 'q' });
    if (move) {
        if (game.history().length >= 2) {
            userTimeRemaining = Math.max(0, userTimeRemaining - 0.1);
            $('#user-clock').text(formatSecondsToDigitalString(userTimeRemaining));
        }
        clearSquareSelection();
        highlightLastMove(pm.from, pm.to);
        board.position(game.fen(), false);
        updateCheckHighlight();
        updateCapturedPiecesAndMaterial();
        renderLiveMoveNotation();
        if (p2pSocket && p2pSocket.readyState === WebSocket.OPEN) {
            p2pSocket.send(JSON.stringify({
                type: 'CHESS_MOVE',
                sessionId: mySessionId,
                from: pm.from,
                to: pm.to,
                promotion: pm.promotion || 'q'
            }));
        }
        EventBus.emit('moveMade', { captured: !!move.captured, isPremove: true });
        if (move.flags && (move.flags.includes('k') || move.flags.includes('q'))) EventBus.emit('castle');
        if (move.promotion) EventBus.emit('promotion');
        if (game.history().length >= 2) clearTimeout(openingMoveTimer);
        updateLifecycleButtons();
        checkGameStatus();
        updateTurnStatusDisplay();
        saveGameState();
    } else {
        clearPendingPremoves();
        board.position(game.fen(), false);
    }
}

function selectSquareAndHighlightTargets(square) {
    clearSquareSelection();
    selectedSquare = square;

    if (canPremove()) {
        $(`.square-${square}`).addClass('square-selected square-selected-premove');
        return;
    }

    $(`.square-${square}`).addClass('square-selected');

    const activeChess = isAnalysisMode ? analysisGame : game;
    const legalMoves = activeChess.moves({ square: square, verbose: true });
    legalMoves.forEach(m => {
        if (m.captured || (m.flags && m.flags.includes('e'))) {
            $(`.square-${m.to}`).addClass('square-legal-capture');
        } else {
            $(`.square-${m.to}`).addClass('square-legal-move');
        }
    });
}

function initChessboard() {
    function executeAnalysisVariationMove(source, target, promotion) {
        const move = analysisGame.move({ from: source, to: target, promotion: promotion });
        if (!move) {
            board.position(analysisGame.fen(), false);
            return false;
        }
        clearSquareSelection();
        highlightLastMove(source, target);
        board.position(analysisGame.fen());
        updateCheckHighlight();
        updateCapturedPiecesAndMaterial();
        calculateSimulatedEvaluation(analysisGame.fen());
        EventBus.emit('moveMade', { captured: !!move.captured });
        if (move.flags && (move.flags.includes('k') || move.flags.includes('q'))) EventBus.emit('castle');
        if (move.promotion) EventBus.emit('promotion');
        if (analysisGame.in_check()) EventBus.emit('check');
        return true;
    }

    function executeMove(source, target, promotion) {
        var activeTurnBeforeMove = game.turn();
        var move = game.move({ from: source, to: target, promotion: promotion });
        if (move === null) {
            board.position(game.fen(), false);
            return false;
        }

        clearSquareSelection();
        highlightLastMove(source, target);
        updateCheckHighlight();
        updateCapturedPiecesAndMaterial();
        renderLiveMoveNotation();
        EventBus.emit('moveMade', { captured: !!move.captured });

        if (move.flags && (move.flags.includes('k') || move.flags.includes('q'))) EventBus.emit('castle');
        if (move.promotion) EventBus.emit('promotion');

        if (currentMode === 'solo') {
            var format = $('#time-control-select').val();
            var inc = timeControlIncrements[format];
            if (inc > 0 && game.history().length > 1) {
                if (activeTurnBeforeMove === myAssignedColor) userTimeRemaining += inc;
                else opponentTimeRemaining += inc;
            }
        }

        board.position(game.fen());

        if (currentMode === 'solo') {
            runChessClockEngine();
            checkGameStatus();
            updateLifecycleButtons();
            updateTurnStatusDisplay();
            if (!gameResultSettled) setTimeout(executeBotTurn, 220);
        } else {
            if (p2pSocket && p2pSocket.readyState === WebSocket.OPEN) {
                p2pSocket.send(JSON.stringify({
                    type: 'CHESS_MOVE',
                    sessionId: mySessionId,
                    from: source,
                    to: target,
                    promotion: promotion
                }));
            }
            if (game.history().length < 2) startInitialAbortTimer();
            else clearTimeout(openingMoveTimer);

            runChessClockEngine();
            updateLifecycleButtons();
            checkGameStatus();
            updateTurnStatusDisplay();
            saveGameState();
        }
        return true;
    }

    // Pure Click/Tap-and-Drop Configuration (Dragging completely disabled)
    board = ChessBoard('myBoard', {
        draggable: false,
        position: 'start',
        moveSpeed: 120,
        pieceTheme: getPieceThemeUrl
    });

    // Unified Click & Mobile Tap Handler (Select Piece -> Show Valid Targets -> Tap Target to Drop)
    $('#myBoard').off('click', '.square-55d63').on('click', '.square-55d63', function () {
        if (pendingPromotion) return;
        const clickedSq = $(this).attr('data-square');
        if (!clickedSq) return;

        // 1. Post-game interactive variation analysis mode
        if (isAnalysisMode && gameResultSettled) {
            if (analysisGame.game_over()) {
                clearSquareSelection();
                return;
            }
            if (selectedSquare && selectedSquare !== clickedSq) {
                const legalMoves = analysisGame.moves({ square: selectedSquare, verbose: true });
                if (legalMoves.some(m => m.to === clickedSq)) {
                    const movingPiece = analysisGame.get(selectedSquare);
                    const promoRank = movingPiece && movingPiece.color === 'w' ? '8' : '1';
                    const fromSq = selectedSquare;
                    clearSquareSelection();
                    if (movingPiece && movingPiece.type === 'p' && clickedSq[1] === promoRank) {
                        showPromotionSelector(movingPiece.color, function (chosenPiece) {
                            hidePromotionSelector();
                            executeAnalysisVariationMove(fromSq, clickedSq, chosenPiece);
                        });
                    } else {
                        executeAnalysisVariationMove(fromSq, clickedSq, 'q');
                    }
                    return;
                }
            }
            const sqPiece = analysisGame.get(clickedSq);
            if (sqPiece && sqPiece.color === analysisGame.turn()) {
                if (selectedSquare === clickedSq) clearSquareSelection();
                else selectSquareAndHighlightTargets(clickedSq);
            } else {
                clearSquareSelection();
            }
            return;
        }

        // 2. Guard checks for live play
        if (!isMatchActive || gameResultSettled || isSpectator || game.game_over()) {
            clearSquareSelection();
            return;
        }
        if (isPaidMode && !isAuthenticated) {
            showToast("Verifying cryptographic session...", "warn");
            clearSquareSelection();
            return;
        }
        if (currentMode === 'solo' && isBotThinking) return;

        // 3. Tap/Click-to-Premove when it is opponent's turn
        if (canPremove()) {
            if (selectedSquare && selectedSquare !== clickedSq) {
                const fromSq = selectedSquare;
                const movingPiece = game.get(fromSq);
                clearSquareSelection();
                if (movingPiece && movingPiece.type === 'p') {
                    const promoRank = movingPiece.color === 'w' ? '8' : '1';
                    if (clickedSq[1] === promoRank) {
                        showPromotionSelector(movingPiece.color, function (chosenPiece) {
                            hidePromotionSelector();
                            pendingPremoves = [{ from: fromSq, to: clickedSq, promotion: chosenPiece }];
                            renderPremoveHighlights();
                        });
                        return;
                    }
                }
                pendingPremoves = [{ from: fromSq, to: clickedSq, promotion: 'q' }];
                renderPremoveHighlights();
                return;
            }
            const sqPiece = game.get(clickedSq);
            if (sqPiece && sqPiece.color === myAssignedColor) {
                if (selectedSquare === clickedSq) clearSquareSelection();
                else selectSquareAndHighlightTargets(clickedSq);
            } else {
                clearSquareSelection();
            }
            return;
        }

        // 4. Standard Click/Tap-and-Drop on player's turn
        if (game.turn() !== myAssignedColor) {
            clearSquareSelection();
            return;
        }

        // If a piece is already selected, check if clicked square is a valid drop target
        if (selectedSquare && selectedSquare !== clickedSq) {
            const legalMoves = game.moves({ square: selectedSquare, verbose: true });
            if (legalMoves.some(m => m.to === clickedSq)) {
                const fromSq = selectedSquare;
                const movingPiece = game.get(fromSq);
                clearSquareSelection();
                if (movingPiece && movingPiece.type === 'p') {
                    const promoRank = movingPiece.color === 'w' ? '8' : '1';
                    if (clickedSq[1] === promoRank) {
                        showPromotionSelector(movingPiece.color, function (chosenPiece) {
                            hidePromotionSelector();
                            executeMove(fromSq, clickedSq, chosenPiece);
                        });
                        return;
                    }
                }
                executeMove(fromSq, clickedSq, 'q');
                return;
            }
        }

        // Otherwise, select or deselect player's own piece
        const sqPiece = game.get(clickedSq);
        if (sqPiece && sqPiece.color === myAssignedColor) {
            if (selectedSquare === clickedSq) clearSquareSelection();
            else selectSquareAndHighlightTargets(clickedSq);
        } else {
            clearSquareSelection();
        }
    });

    $('#board-frame-wrapper').off('contextmenu').on('contextmenu', function (e) {
        e.preventDefault();
        clearSquareSelection();
        if (pendingPremoves.length > 0) {
            clearPendingPremoves();
            showToast("Premove cleared.", "info", 1500);
        }
    });
}

// ============================================================================
// 16. PERSISTENT LOBBY TELEMETRY & SOCIAL PRESENCE SOCKET + BRIDGE
// ============================================================================
function connectLobbyTelemetrySocket() {
    if (lobbySocket && lobbySocket.readyState === WebSocket.OPEN) {
        lobbySocket.send(JSON.stringify({ type: 'GET_LOBBY_TELEMETRY' }));
        return;
    }
    if (lobbySocket && lobbySocket.readyState === WebSocket.CONNECTING) {
        return;
    }

    try {
        lobbySocket = new WebSocket(WS_URL);

        lobbySocket.onopen = function () {
            if (lobbyReconnectTimer) {
                clearTimeout(lobbyReconnectTimer);
                lobbyReconnectTimer = null;
            }
            if (window.LitSocial && typeof window.LitSocial.onSocketOpen === 'function') {
                window.LitSocial.onSocketOpen(lobbySocket);
            }
            lobbySocket.send(JSON.stringify({ type: 'GET_LOBBY_TELEMETRY' }));
        };

        lobbySocket.onmessage = function (ev) {
            try {
                const data = JSON.parse(ev.data);

                // Route all social, presence, search, profile, DM, club & direct challenge messages to LitSocial
                if (window.LitSocial && typeof window.LitSocial.handleMessage === 'function') {
                    if (window.LitSocial.handleMessage(data)) return;
                }

                if (data.type === 'LOBBY_TELEMETRY') {
                    if (data.totalGames) $('#total-games').text(Number(data.totalGames).toLocaleString());
                    if (data.activeGames !== undefined) $('#active-games').text(data.activeGames);
                    if (data.playersOnline !== undefined) $('#players-online').text(data.playersOnline);

                    const listEl = $('#live-matches-list').empty();
                    if (Array.isArray(data.liveMatches) && data.liveMatches.length > 0) {
                        $('#live-matches-ticker').removeClass('hidden-element');
                        data.liveMatches.forEach(m => {
                            const pill = $(`<div class="ticker-match-pill">⚔️ <strong>${sanitizeHTML(m.white)}</strong> vs <strong>${sanitizeHTML(m.black)}</strong> (${m.timeControl})</div>`);
                            pill.click(() => spectateMatchById(m.matchId));
                            listEl.append(pill);
                        });
                    } else {
                        $('#live-matches-ticker').addClass('hidden-element');
                    }
                }
            } catch (_) {}
        };

        lobbySocket.onclose = function () {
            if (!lobbyReconnectTimer) {
                lobbyReconnectTimer = setTimeout(() => {
                    lobbyReconnectTimer = null;
                    connectLobbyTelemetrySocket();
                }, 3500);
            }
        };
    } catch (_) {}
}

// Bridge API consumed by public/social.js
window.LitChessBridge = {
    getContext() {
        return {
            wallet: userWalletAddress,
            username: myUsername,
            signer,
            contract: chessContractInstance,
            lobbySocket,
            opponentWallet,
            opponentUsername,
            isMatchActive
        };
    },

    launchDirectMatch(data) {
        if (!data || !data.matchId) return;
        if (isMatchActive && !gameResultSettled && !isSpectator) {
            showToast("Finish your current match before starting a new duel.", "warn");
            return;
        }

        resetMatchEnvironment();
        currentMode = '2p';
        isPaidMode = !!data.isPaid;

        $('#toggle-paid-mode').prop('checked', isPaidMode);
        $('#staking-ui-container').toggleClass('disabled-ui', !isPaidMode);
        $('#paid-label-text').toggleClass('active-text', isPaidMode);
        $('#free-label-text').toggleClass('active-text', !isPaidMode);

        if (data.timeControl && timeControlLimits[data.timeControl]) {
            $('#time-control-select').val(data.timeControl);
        }
        if (data.isPaid && data.stake) {
            $('#stake-amount-input').val(data.stake);
        }

        setupUIPerMode();
        resetClocksToSelectedFormat();

        $('#home-view-container').addClass('hidden-element');
        $('#arena-app-wrapper').removeClass('hidden-element');
        if (board === null) initChessboard();
        else board.resize();

        activeMatchId = data.matchId;
        myAssignedColor = data.color || 'w';
        opponentUsername = data.opponentName || 'Opponent';
        opponentWallet = data.opponentWallet || null;
        isSpectator = false;
        isReplayMode = false;

        board.orientation(myAssignedColor === 'w' ? 'white' : 'black');
        reapplyBoardHighlights();
        updateProfileRatingsDisplay();
        updateFloatingControls();

        $('#match-settings-box').addClass('hidden-element');
        $('#btn-find-match').prop('disabled', true).text("Match in Progress");

        establishP2PConnection(activeMatchId, false);
        saveGameState();
        showToast(`⚔️ Direct duel launched vs ${opponentUsername} (${myAssignedColor === 'w' ? 'WHITE' : 'BLACK'})!`, "success");
    },

    loadReplayForAnalysis(gameRecord) {
        if (!gameRecord || !gameRecord.pgn) {
            showToast("No PGN moves stored for this match.", "warn");
            return;
        }
        if (isMatchActive && !gameResultSettled && !isSpectator) {
            showToast("Finish your live match before opening a replay.", "warn");
            return;
        }

        resetMatchEnvironment();
        $('#home-view-container').addClass('hidden-element');
        $('#arena-app-wrapper').removeClass('hidden-element');
        if (board === null) initChessboard();
        else board.resize();

        isReplayMode = true;
        replayWhiteName = gameRecord.whiteName || 'White';
        replayBlackName = gameRecord.blackName || 'Black';
        gameResultSettled = true;
        isAnalysisMode = true;
        isMatchActive = false;
        myAssignedColor = 'w';

        game.reset();
        game.load_pgn(gameRecord.pgn);
        analysisMovesList = game.history();
        analysisCurrentIndex = analysisMovesList.length - 1;
        analysisGame.load(game.fen());

        board.orientation('white');
        $('#match-settings-box, #live-action-controls, #btn-rematch, #btn-view-analysis').addClass('hidden-element');
        $('#post-game-controls, #analysis-moves-panel, #analysis-controls').removeClass('hidden-element');
        $('#analysis-eval-gauge').removeClass('hidden-eval');
        $('#game-phase').text(`Status: Replay Review (${(gameRecord.timeControl || 'blitz').toUpperCase()})`);

        updateProfileRatingsDisplay();
        renderLiveMoveNotation();
        displayHistoricalMoveIndex();
        updateFloatingControls();
        showToast(`Loaded replay: ${replayWhiteName} vs ${replayBlackName}. Use ← / → or play variations!`, "info", 4000);
    },

    openClubTournament(tourneyId) {
        if (isMatchActive && !gameResultSettled && !isSpectator) {
            showToast("Finish your live match before entering a club tournament.", "warn");
            return;
        }
        resetMatchEnvironment();
        currentMode = 'tourney';
        setupUIPerMode();
        $('#home-view-container').addClass('hidden-element');
        $('#arena-app-wrapper').removeClass('hidden-element');
        if (board === null) initChessboard();
        else board.resize();

        $('#tourney-id-input').val(tourneyId);
        updateFloatingControls();
        showToast(`🏆 Club Arena "${tourneyId}" loaded! Choose Free or Stake zkLTC and click Join Tournament.`, "info", 4500);
    }
};

// ============================================================================
// 17. UI HELPERS & MATCH LIFECYCLE
// ============================================================================
function sanitizeHTML(str) {
    return String(str)
        .replace(/&/g, '\x26amp;')
        .replace(/</g, '\x26lt;')
        .replace(/>/g, '\x26gt;')
        .replace(/"/g, '\x26quot;')
        .replace(/'/g, '\x26#39;');
}

function getTimeControlValue() {
    var val = $('#time-control-select').val();
    if (val === "bullet") return 0;
    if (val === "blitz") return 1;
    return 2;
}

function getSidePreferenceValue() {
    return parseInt($('input[name="sidePref"]:checked').val() || 2, 10);
}

function updateQuickAddOpponentButton() {
    const canQuickAdd = !isSpectator &&
        !isReplayMode &&
        currentMode !== 'solo' &&
        !!opponentWallet &&
        !!userWalletAddress &&
        opponentWallet.toLowerCase() !== userWalletAddress.toLowerCase() &&
        !(window.LitSocial && typeof window.LitSocial.isFriend === 'function' && window.LitSocial.isFriend(opponentWallet));

    $('#btn-quick-add-opponent').toggleClass('hidden-element', !canQuickAdd);
}

function updateProfileRatingsDisplay() {
    var activeFormat = $('#time-control-select').val();
    if (isReplayMode) {
        $('#user-name').text(replayWhiteName);
        $('#user-rating').text('(White)');
        $('#opponent-name').text(replayBlackName);
        $('#opponent-rating').text('(Black)');
        updateQuickAddOpponentButton();
        return;
    }
    if (isSpectator) {
        $('#user-name').text(spectatorWhiteName);
        $('#user-rating').text(`(${playerRatings[activeFormat] || 2000})`);
        $('#opponent-name').text(spectatorBlackName);
        $('#opponent-rating').text(`(${opponentRatings[activeFormat] || 2000})`);
        updateQuickAddOpponentButton();
        return;
    }
    $('#user-name').text(myUsername);
    $('#user-rating').text(currentMode !== 'solo' ? `(${playerRatings[activeFormat] || 2000})` : '');
    $('#opponent-name').text(opponentUsername);
    $('#opponent-rating').text(currentMode !== 'solo' ? `(${opponentRatings[activeFormat] || 2000})` : '');
    updateQuickAddOpponentButton();
}

function resetClocksToSelectedFormat() {
    var format = $('#time-control-select').val();
    var duration = timeControlLimits[format];
    userTimeRemaining = duration;
    opponentTimeRemaining = duration;
    $('#user-clock').text(formatSecondsToDigitalString(userTimeRemaining)).removeClass('clock-running clock-flagged');
    $('#opponent-clock').text(formatSecondsToDigitalString(opponentTimeRemaining)).removeClass('clock-running clock-flagged');
}

function updateTurnStatusDisplay() {
    if (gameResultSettled || !isMatchActive) return;
    if (isSpectator) {
        $('#game-phase').text(`Status: Spectating (${game.turn() === 'w' ? "White's turn" : "Black's turn"})`);
        return;
    }
    var who = (myAssignedColor === game.turn()) ? "Your turn" : "Opponent's turn";
    $('#game-phase').text(`Status: ${who}`);
}

function clearAllTimers() {
    if (queuePollingInterval) clearInterval(queuePollingInterval);
    clearInterval(chessClockTicker);
    clearTimeout(openingMoveTimer);
    if (abortFallbackTimer) { clearTimeout(abortFallbackTimer); abortFallbackTimer = null; }
    if (queueTimeout) { clearTimeout(queueTimeout); queueTimeout = null; }
    if (opponentDisconnectTimer) { clearInterval(opponentDisconnectTimer); opponentDisconnectTimer = null; }
    if (pairingTimeoutId) clearTimeout(pairingTimeoutId);
}

function startInitialAbortTimer() {
    if (currentMode === 'solo' || isSpectator) return;
    if (isPaidMode && !isAuthenticated) return;
    clearTimeout(openingMoveTimer);
    if (game.history().length < 2) {
        const waitingOn = game.history().length === 0 ? "White's opening move" : "Black's opening reply";
        $('#game-phase').text(`Status: Awaiting ${waitingOn} (38s)`);
        openingMoveTimer = setTimeout(() => {
            if (!gameResultSettled && game.history().length < 2 && isMatchActive) {
                requestMatchAbort();
            }
        }, 38000);
    }
}

function checkGameStatus() {
    if (!isMatchActive) return;
    updateCheckHighlight();

    if (game.in_checkmate()) {
        var winnerIsWhite = (game.turn() === 'b');
        var iAmWinner = (winnerIsWhite && myAssignedColor === 'w') || (!winnerIsWhite && myAssignedColor === 'b');
        appendSystemMessage(`👑 Checkmate! ${winnerIsWhite ? "White" : "Black"} victorious!`, false);
        flashCheckmatedKing();
        handleMatchCompletion(iAmWinner ? 'win' : 'loss', 'checkmate');
        return;
    }
    if (game.in_check()) EventBus.emit('check');
    if (game.in_stalemate()) {
        appendSystemMessage("🤝 Draw by Stalemate!", false);
        handleMatchCompletion('draw', 'stalemate');
    } else if (game.in_threefold_repetition()) {
        appendSystemMessage("🤝 Draw by Threefold Repetition!", false);
        handleMatchCompletion('draw', 'threefold_repetition');
    } else if (game.insufficient_material()) {
        appendSystemMessage("🤝 Draw by Insufficient Mating Material!", false);
        handleMatchCompletion('draw', 'insufficient_material');
    } else if (game.in_draw()) {
        appendSystemMessage("🤝 Draw by 50-Move Rule!", false);
        handleMatchCompletion('draw', 'fifty_move_rule');
    }
}

function handleMatchCompletion(result, reason = '') {
    if (gameResultSettled) return;
    gameResultSettled = true;
    if (activeMatchId) completedMatches.add(activeMatchId);

    clearAllTimers();
    clearPendingPremoves();
    clearSquareSelection();
    if (!isSpectator) setChatEnabled(false);
    isMatchActive = false;
    $('.chess-clock').removeClass('clock-running');
    $('#live-action-controls').addClass('hidden-element');
    $('#post-game-controls').removeClass('hidden-element');
    $('#analysis-moves-panel, #analysis-controls').removeClass('hidden-element');
    renderLiveMoveNotation();

    const reasonSuffix = reason ? ` (${reason.replace(/_/g, ' ')})` : '';
    const label = result === 'win' ? '🏆 Victory' : (result === 'loss' ? '💀 Defeat' : '🤝 Draw');
    $('#game-phase').text(`Status: ${label}${reasonSuffix}`);
    showToast(`Match Completed: ${label}${reasonSuffix}`, result === 'win' ? 'success' : 'info');

    EventBus.emit('gameEnd', { result, reason });
    localStorage.removeItem(STORAGE_KEY);
}

function resetMatchEnvironment() {
    clearAllTimers();
    clearPendingPremoves();
    clearSquareSelection();
    clearChallengeQueryFromUrl();
    pendingChallengeInvite = null;
    createdChallengeMatchId = null;

    if (p2pSocket) { p2pSocket.close(); p2pSocket = null; }
    game.reset();
    analysisGame.reset();
    if (board) { board.start(false); board.orientation('white'); }
    analysisMovesList = [];
    analysisCurrentIndex = -1;
    gameResultSettled = false;
    isAnalysisMode = false;
    isReplayMode = false;
    pendingDrawOffer = false;
    pendingRematchOffer = false;
    isInQueue = false;
    activeMatchId = null;
    isMatchActive = false;
    isSpectator = false;
    opponentWallet = null;
    opponentUsername = "Opponent";
    setChatEnabled(false);

    $('#combat-chat-heading').text('💬 Combat Comms');
    $('#chat-text-input').attr('placeholder', 'Transmit message...');
    $('#challenge-link-display, #spectator-banner, #tx-status-badge, #engine-best-move-badge').addClass('hidden-element');
    $('#analysis-eval-gauge').addClass('hidden-eval');
    $('#analysis-controls, #analysis-moves-panel, #post-game-controls').addClass('hidden-element');
    $('#match-settings-box, #live-action-controls').removeClass('hidden-element');
    $('#btn-abort').prop('disabled', true).text("Abort Match");
    $('#btn-resign, #btn-draw').prop('disabled', true);
    $('#game-phase').text("Status: Idle");
    $('#btn-view-analysis, #btn-rematch').removeClass('hidden-element');
    $('#opening-name-badge').text("Starting Position");
    $('#notation-list-box').empty();

    updateProfileRatingsDisplay();
    resetClocksToSelectedFormat();
    updateCapturedPiecesAndMaterial();
    clearMoveHighlights();
    hidePromotionSelector();
    localStorage.removeItem(STORAGE_KEY);
    forceResetQueueUI();
}

function handleFindMatchButtonClick() {
    if (pendingChallengeInvite) {
        acceptPendingPaidChallenge();
        return;
    }
    if (currentMode === 'solo') {
        startSoloMatch();
        return;
    }
    if (currentMode === '2p') {
        if (isPaidMode) {
            if (userWalletAddress === null) {
                showToast("Please connect your Web3 wallet first.", "warn");
                connectWeb3Wallet();
                return;
            }
            var stake = normalizeStake($('#stake-amount-input').val());
            if (!stake) {
                showToast('Enter a valid wager (max ' + MAX_STAKE_ZKLTC + ' zkLTC).', "error");
                return;
            }
            initiateChainMatchmaking(stake, getTimeControlValue(), getSidePreferenceValue());
        } else {
            initiateFreeMatchmaking();
        }
    } else if (currentMode === 'tourney') {
        initiateTournamentJoin();
    }
}

function forceResetQueueUI() {
    isInQueue = false;
    if (queuePollingInterval) clearInterval(queuePollingInterval);
    if (queueTimeout) clearTimeout(queueTimeout);
    const defaultLabel = currentMode === 'solo'
        ? "START ENGINE MATCH"
        : (currentMode === 'tourney'
            ? (isPaidMode ? "JOIN TOURNAMENT" : "JOIN FREE TOURNAMENT")
            : (isPaidMode ? "JOIN MATCHMAKING QUEUE" : "FIND FREE MATCH"));

    $('#btn-find-match')
        .removeClass('hidden-element')
        .prop('disabled', false)
        .text(pendingChallengeInvite ? `ACCEPT CHALLENGE (${pendingChallengeInvite.stake} zkLTC)` : defaultLabel)
        .off('click')
        .on('click', handleFindMatchButtonClick);

    $('#btn-cancel-queue').addClass('hidden-element');
}

async function cancelQueue() {
    if (!isPaidMode) {
        if (p2pSocket && p2pSocket.readyState === WebSocket.OPEN) {
            p2pSocket.send(JSON.stringify({ type: 'CANCEL_FREE_QUEUE' }));
        }
        forceResetQueueUI();
        showToast("Left matchmaking queue.", "info");
        return;
    }
    if (!userWalletAddress || !signer) {
        forceResetQueueUI();
        return;
    }
    const stake = queuedStake || parseFloat($('#stake-amount-input').val()) || 0.01;
    const tcValue = (queuedTc !== undefined && queuedTc !== null) ? queuedTc : getTimeControlValue();
    const escrow = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
    try {
        const tx = await escrow.cancelQueue(ethers.utils.parseEther(stake.toString()), tcValue);
        showToast("Cancelling queue & refunding stake...", "info");
        await tx.wait();
        showToast("Queue cancelled. Stake refunded in full!", "success");
        forceResetQueueUI();
    } catch (err) {
        forceResetQueueUI();
    }
}

function setupAnalysisNavigation() {
    $('#btn-view-analysis').click(function () {
        isAnalysisMode = true;
        analysisMovesList = game.history();
        analysisCurrentIndex = analysisMovesList.length - 1;
        analysisGame.load(game.fen());

        $('#analysis-eval-gauge').removeClass('hidden-eval');
        $('#analysis-controls, #analysis-moves-panel').removeClass('hidden-element');
        $('#match-settings-box').addClass('hidden-element');

        renderLiveMoveNotation();
        calculateSimulatedEvaluation(analysisGame.fen());
        showToast("Interactive Analysis active: tap or click pieces to test variations!", "info", 3500);
        $(this).addClass('hidden-element');
    });

    $('#btn-nav-first').click(() => {
        if (!gameResultSettled && !isSpectator) return;
        isAnalysisMode = true;
        analysisCurrentIndex = -1;
        analysisGame.reset();
        board.start(false);
        clearMoveHighlights();
        updateCheckHighlight();
        updateCapturedPiecesAndMaterial();
        updateOpeningExplorerBadge([]);
        calculateSimulatedEvaluation('start');
        $('.notation-move-cell').removeClass('active-move');
    });

    $('#btn-nav-prev').click(() => {
        if (!gameResultSettled && !isSpectator) return;
        isAnalysisMode = true;
        if (analysisCurrentIndex >= 0) {
            analysisCurrentIndex--;
            if (analysisCurrentIndex === -1) {
                analysisGame.reset();
                board.start(false);
                clearMoveHighlights();
                updateCheckHighlight();
                updateCapturedPiecesAndMaterial();
                updateOpeningExplorerBadge([]);
                calculateSimulatedEvaluation('start');
                $('.notation-move-cell').removeClass('active-move');
            } else {
                displayHistoricalMoveIndex();
            }
        }
    });

    $('#btn-nav-next').click(() => {
        if (!gameResultSettled && !isSpectator) return;
        isAnalysisMode = true;
        if (analysisCurrentIndex < analysisMovesList.length - 1) {
            analysisCurrentIndex++;
            displayHistoricalMoveIndex();
        }
    });

    $('#btn-nav-last').click(() => {
        if (!gameResultSettled && !isSpectator) return;
        isAnalysisMode = true;
        if (analysisMovesList.length > 0) {
            analysisCurrentIndex = analysisMovesList.length - 1;
            displayHistoricalMoveIndex();
        }
    });

    $(document).keydown(function (e) {
        if ($('#analysis-moves-panel').hasClass('hidden-element')) return;
        if (!gameResultSettled && !isSpectator) return;
        if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
        if (e.key === 'ArrowLeft') $('#btn-nav-prev').click();
        else if (e.key === 'ArrowRight') $('#btn-nav-next').click();
    });
}

function setChatEnabled(enabled) {
    $('#chat-text-input, #btn-send-chat, .preset-phrase, .preset-emoji').prop('disabled', !enabled);
}

function appendMessage(sender, text) {
    var chatBox = $('#chat-messages-box');
    chatBox.append(`<div class="user-msg"><span class="sender">${sanitizeHTML(sender)}:</span> ${sanitizeHTML(text)}</div>`);
    chatBox.scrollTop(chatBox[0].scrollHeight);
}

function appendSpectatorMessage(sender, text) {
    var chatBox = $('#chat-messages-box');
    chatBox.append(`<div class="spectator-msg"><span class="sender">👁️ ${sanitizeHTML(sender)}:</span> ${sanitizeHTML(text)}</div>`);
    chatBox.scrollTop(chatBox[0].scrollHeight);
}

function appendSystemMessage(text, isWarning) {
    var chatBox = $('#chat-messages-box');
    chatBox.append(`<div class="${isWarning ? "warning-msg" : "system-msg"}">${sanitizeHTML(text)}</div>`);
    chatBox.scrollTop(chatBox[0].scrollHeight);
}

function showRematchButtons() {
    const chatBox = $('#chat-messages-box');
    const btnContainer = $('<div style="display:flex; gap:8px; margin:6px 0;"></div>');
    const acceptBtn = $('<button style="background:#10b981; flex:1;">Accept Rematch</button>');
    const declineBtn = $('<button class="btn-danger" style="flex:1;">Decline</button>');
    acceptBtn.click(() => {
        if (p2pSocket && p2pSocket.readyState === WebSocket.OPEN) {
            p2pSocket.send(JSON.stringify({ type: 'REMATCH_RESPONSE', accepted: true, sessionId: mySessionId }));
        }
        btnContainer.remove();
        startNewRematch();
    });
    declineBtn.click(() => {
        if (p2pSocket && p2pSocket.readyState === WebSocket.OPEN) {
            p2pSocket.send(JSON.stringify({ type: 'REMATCH_RESPONSE', accepted: false, sessionId: mySessionId }));
        }
        btnContainer.remove();
    });
    btnContainer.append(acceptBtn, declineBtn);
    chatBox.append(btnContainer);
    chatBox.scrollTop(chatBox[0].scrollHeight);
}

function startNewRematch() {
    const nextSidePref = (myAssignedColor === 'w') ? 1 : 0;
    $('#side-pref-container input[value="' + nextSidePref + '"]').prop('checked', true);

    resetMatchEnvironment();
    var stake = $('#stake-amount-input').val() || 0.01;
    if (isPaidMode) initiateChainMatchmaking(stake, getTimeControlValue(), nextSidePref);
    else initiateFreeMatchmaking(nextSidePref);
}

function startSoloMatch() {
    let pref = getSidePreferenceValue();
    if (pref === 2) pref = Math.random() < 0.5 ? 0 : 1;
    myAssignedColor = pref === 0 ? 'w' : 'b';

    opponentWallet = null;
    opponentUsername = "LitEngine (" + $('#bot-difficulty-select').val().toUpperCase() + ")";
    updateProfileRatingsDisplay();
    board.orientation(myAssignedColor === 'w' ? 'white' : 'black');
    isMatchActive = true;
    isAuthenticated = true;
    isAnalysisMode = false;
    isReplayMode = false;
    gameResultSettled = false;
    game.reset();
    analysisGame.reset();
    board.start(false);
    clearMoveHighlights();
    updateCapturedPiecesAndMaterial();
    renderLiveMoveNotation();
    $('#match-settings-box').addClass('hidden-element');
    $('#analysis-moves-panel').removeClass('hidden-element');
    $('#live-action-controls').removeClass('hidden-element');
    appendSystemMessage("🤖 Engine match initialized vs " + opponentUsername, false);
    EventBus.emit('gameStart');

    runChessClockEngine();
    updateTurnStatusDisplay();

    if (myAssignedColor === 'b') {
        setTimeout(executeBotTurn, 400);
    }
}

function setupUIPerMode() {
    $('#solo-difficulty-container, #tournament-input-container, #side-pref-container, #tourney-standings-box').addClass('hidden-element');
    $('#payment-toggle-container').removeClass('hidden-element');
    $('#chat-messages-box').empty();

    if (currentMode === 'solo') {
        $('#mode-title-display').text('🤖 Alpha-Beta Engine Arena');
        $('#solo-difficulty-container, #side-pref-container').removeClass('hidden-element');
        $('#payment-toggle-container').addClass('hidden-element');
        isPaidMode = false;
        $('#staking-ui-container').addClass('disabled-ui');
    } else if (currentMode === 'tourney') {
        $('#mode-title-display').text('🏆 Tournament Arena Hub');
        $('#tournament-input-container, #tourney-standings-box').removeClass('hidden-element');
        isPaidMode = $('#toggle-paid-mode').is(':checked');
        $('#staking-ui-container').toggleClass('disabled-ui', !isPaidMode);
    } else {
        $('#mode-title-display').text('⚔️ Two Players Escrow Arena');
        $('#side-pref-container').removeClass('hidden-element');
        isPaidMode = $('#toggle-paid-mode').is(':checked');
        $('#staking-ui-container').toggleClass('disabled-ui', !isPaidMode);
    }
    forceResetQueueUI();
    updateProfileRatingsDisplay();
    updateFloatingControls();
}

function updateFloatingControls() {
    var $fc = $('#floating-controls');
    if ($('#arena-app-wrapper').is(':visible')) {
        $fc.removeClass('hidden-element');
        $('#btn-create-challenge').toggleClass('hidden-element', currentMode === 'solo');
    } else {
        $fc.addClass('hidden-element');
    }
}

// ============================================================================
// 18. BOOTSTRAP
// ============================================================================
EventBus.on('moveMade', (d) => soundManager.play(d && d.captured ? 'capture' : 'move'));
EventBus.on('check', () => soundManager.play('check'));
EventBus.on('castle', () => soundManager.play('castle'));
EventBus.on('promotion', () => soundManager.play('promotion'));
EventBus.on('notification', () => soundManager.play('notification'));
EventBus.on('gameEnd', () => soundManager.play('gameEnd'));
EventBus.on('gameStart', () => soundManager.play('gameStart'));

$(document).ready(function () {
    $('body').append(`
        <div id="promotion-selector" class="promotion-backdrop hidden-element">
            <div class="promotion-card">
                <div class="promotion-title">Promote Pawn</div>
                <div class="promotion-options">
                    <button type="button" class="promo-choice-btn" id="promo-btn-q" title="Queen"><img id="promo-queen" alt="Queen" /></button>
                    <button type="button" class="promo-choice-btn" id="promo-btn-r" title="Rook"><img id="promo-rook" alt="Rook" /></button>
                    <button type="button" class="promo-choice-btn" id="promo-btn-b" title="Bishop"><img id="promo-bishop" alt="Bishop" /></button>
                    <button type="button" class="promo-choice-btn" id="promo-btn-n" title="Knight"><img id="promo-knight" alt="Knight" /></button>
                </div>
                <button type="button" id="promo-cancel-btn" class="btn-secondary promo-cancel-btn">Cancel</button>
            </div>
        </div>
    `);

    $('#promo-btn-q').click(() => { if (pendingPromotion) pendingPromotion.callback('q'); });
    $('#promo-btn-r').click(() => { if (pendingPromotion) pendingPromotion.callback('r'); });
    $('#promo-btn-b').click(() => { if (pendingPromotion) pendingPromotion.callback('b'); });
    $('#promo-btn-n').click(() => { if (pendingPromotion) pendingPromotion.callback('n'); });
    $('#promo-cancel-btn').click(() => {
        hidePromotionSelector();
        clearSquareSelection();
    });
    $('#promotion-selector').click(function (e) {
        if (e.target === this) {
            hidePromotionSelector();
            clearSquareSelection();
        }
    });

    loadSettings();
    setupUsernameModalHandlers();
    connectLobbyTelemetrySocket();
    setInterval(connectLobbyTelemetrySocket, 12000);

    ['move', 'capture', 'check', 'castle', 'promotion', 'notification', 'gameStart', 'gameEnd'].forEach(s => {
        soundManager.loadSound(s, `sounds/${s}.mp3`);
    });

    if (window.ethereum && window.ethereum.on) {
        window.ethereum.on('accountsChanged', () => location.reload());
        window.ethereum.on('chainChanged', () => location.reload());
    }

    let boardResizeTimer = null;
    $(window).on('resize orientationchange', () => {
        if (!board) return;
        clearTimeout(boardResizeTimer);
        boardResizeTimer = setTimeout(() => {
            board.resize();
            reapplyBoardHighlights();
        }, 120);
    });

    $('#btn-flip-board').click(() => {
        if (board) {
            board.flip();
            reapplyBoardHighlights();
        }
    });
    $('#btn-copy-pgn').click(() => {
        navigator.clipboard.writeText(game.pgn() || "No moves played yet.");
        showToast("PGN copied to clipboard!", "success");
    });
    $('#btn-copy-fen').click(() => {
        const activeChess = isAnalysisMode ? analysisGame : game;
        navigator.clipboard.writeText(activeChess.fen());
        showToast("FEN copied to clipboard!", "success");
    });
    $('#btn-clear-premove').click(() => clearPendingPremoves());
    $('#btn-claim-payout').click(() => claimFailedPayoutOnChain());

    $('#btn-toggle-settings').click(() => $('#settings-panel').toggleClass('hidden-element'));
    $('#sound-toggle').change(function () {
        soundManager.enabled = $(this).is(':checked');
        localStorage.setItem('litchess_soundEnabled', soundManager.enabled);
    });
    $('#piece-theme-select').change(function () { applyPieceTheme($(this).val()); });
    $('#board-theme-select').change(function () { applyBoardTheme($(this).val()); });

    $('.mode-btn').click(function () {
        currentMode = $(this).data('mode');
        setupUIPerMode();
        $('#home-view-container').addClass('hidden-element');
        $('#arena-app-wrapper').removeClass('hidden-element');
        if (board === null) initChessboard();
        else {
            board.resize();
            reapplyBoardHighlights();
        }
        updateFloatingControls();
    });

    $('#toggle-paid-mode').change(function () {
        isPaidMode = $(this).is(':checked');
        $('#staking-ui-container').toggleClass('disabled-ui', !isPaidMode);
        $('#paid-label-text').toggleClass('active-text', isPaidMode);
        $('#free-label-text').toggleClass('active-text', !isPaidMode);
        forceResetQueueUI();
    });

    $('#btn-send-chat').click(() => {
        var rawInput = $('#chat-text-input').val().trim();
        if (!rawInput) return;
        if (isSpectator) {
            appendSpectatorMessage(myUsername, rawInput);
            if (p2pSocket && p2pSocket.readyState === WebSocket.OPEN) {
                p2pSocket.send(JSON.stringify({ type: 'SPECTATOR_CHAT', text: rawInput, sender: myUsername }));
            }
        } else {
            appendMessage(myUsername, rawInput);
            if (p2pSocket && p2pSocket.readyState === WebSocket.OPEN) {
                p2pSocket.send(JSON.stringify({ type: 'CHAT_MESSAGE', sessionId: mySessionId, text: rawInput }));
            }
        }
        $('#chat-text-input').val('');
    });
    $('#chat-text-input').keypress(e => { if (e.which === 13) $('#btn-send-chat').click(); });
    $('.preset-phrase, .preset-emoji').click(function () {
        $('#chat-text-input').val($(this).text());
        $('#btn-send-chat').click();
    });

    $('#btn-abort').click(() => {
        requestMatchAbort();
    });
    $('#btn-resign').click(() => {
        if (!gameResultSettled && game.history().length >= 2 && isMatchActive) {
            appendSystemMessage(`🏳️ ${myUsername} resigned.`, true);
            if (p2pSocket && p2pSocket.readyState === WebSocket.OPEN) {
                p2pSocket.send(JSON.stringify({ type: 'RESIGN', sessionId: mySessionId }));
            }
            handleMatchCompletion('loss', 'resignation');
        }
    });
    $('#btn-draw').click(() => {
        if (!gameResultSettled && game.history().length >= 2 && isMatchActive && currentMode !== 'solo' && !isSpectator) {
            pendingDrawOffer = true;
            p2pSocket.send(JSON.stringify({ type: 'DRAW_OFFER', sessionId: mySessionId }));
            showToast("Draw offer transmitted to opponent.", "info");
        }
    });
    $('#btn-accept-draw').click(() => {
        if (p2pSocket && p2pSocket.readyState === WebSocket.OPEN) {
            p2pSocket.send(JSON.stringify({ type: 'DRAW_RESPONSE', accepted: true, sessionId: mySessionId }));
        }
        $('#draw-offer-prompt').addClass('hidden-element');
        pendingDrawOfferFromOpponent = false;
        handleMatchCompletion('draw', 'mutual_agreement');
    });
    $('#btn-decline-draw').click(() => {
        if (p2pSocket && p2pSocket.readyState === WebSocket.OPEN) {
            p2pSocket.send(JSON.stringify({ type: 'DRAW_RESPONSE', accepted: false, sessionId: mySessionId }));
        }
        $('#draw-offer-prompt').addClass('hidden-element');
        pendingDrawOfferFromOpponent = false;
    });

    $('#btn-new-game').click(() => resetMatchEnvironment());
    $('#btn-return-menu, #btn-return-menu-top').click(() => {
        resetMatchEnvironment();
        $('#arena-app-wrapper').addClass('hidden-element');
        $('#home-view-container').removeClass('hidden-element');
        updateFloatingControls();
        connectLobbyTelemetrySocket();
    });
    $('#btn-rematch').click(() => {
        if (currentMode === 'solo') startSoloMatch();
        else if (gameResultSettled && p2pSocket && p2pSocket.readyState === WebSocket.OPEN) {
            p2pSocket.send(JSON.stringify({ type: 'REMATCH_OFFER', sessionId: mySessionId }));
            showToast("Rematch offer sent!", "info");
        }
    });
    $('#btn-cancel-queue').click(() => cancelQueue());
    $('#btn-reconnect').click(() => strengthenReconnection());

    $('.tier-btn').click(function () {
        $('.tier-btn').removeClass('selected-tier');
        $(this).addClass('selected-tier');
        $('#stake-amount-input').val($(this).data('amount'));
    });

    setupAnalysisNavigation();
    resetClocksToSelectedFormat();
    setChatEnabled(false);

    $('#btn-create-challenge').click(createChallengeLink);
    $('#btn-copy-challenge-link').click(() => {
        navigator.clipboard.writeText($('#challenge-link-text').text());
        showToast("Challenge URL copied to clipboard!", "success");
    });
    $('#btn-cancel-challenge').click(cancelCreatedChallengeLink);

    $('#time-control-select').change(function () {
        updateProfileRatingsDisplay();
        resetClocksToSelectedFormat();
        saveGameState();
    });

    $('#btn-connect-wallet-landing, #btn-connect-wallet-arena').click(function () {
        if (userWalletAddress === null) connectWeb3Wallet();
        else disconnectWeb3Wallet();
    });

    $('#btn-find-match').off('click').on('click', handleFindMatchButtonClick);

    autoReconnectWallet().finally(() => {
        checkForChallengeLink();
        restoreGameState();
    });
});