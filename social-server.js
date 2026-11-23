/**
 * ============================================================================
 * LITCHESS SOCIAL, PRESENCE, DMs, CLUBS & DIRECT CHALLENGE ENGINE
 * File: social-server.js (Imported by server.js)
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ethers = require('ethers');

const SOCIAL_DB_FILE = path.join(__dirname, 'social_db.json');
const DEFAULT_PRIVACY = {
    challenges: 'everyone', // 'everyone' | 'friends' | 'nobody'
    dms: 'everyone'         // 'everyone' | 'friends' | 'nobody'
};

function createSocialServer(deps) {
    const {
        rooms,
        playerRatings,
        usernameToAddress,
        ensurePlayerRecord,
        getRatingsObject,
        fetchUsername,
        sendSafe,
        RESTRICTED_WORDS = [],
        createDirectFreeRoom
    } = deps;

    // =========================================================================
    // 1. ATOMIC PERSISTENT DATABASE (social_db.json)
    // =========================================================================
    let db = {
        users: {},          // wallet -> { wallet, username, privacy, notes, clubId, totalZkLtcWon, currentStreak, bestStreak, lastSeen, createdAt }
        friendships: [],    // { id, requester, recipient, status: 'pending'|'accepted'|'blocked', createdAt, updatedAt }
        follows: [],        // { follower, target, createdAt }
        directMessages: [], // { id, threadId, sender, senderName, recipient, recipientName, body, readAt, createdAt }
        matches: [],        // { matchId, white, black, whiteName, blackName, winner, winnerColor, reason, timeControl, isPaid, wagerEth, pgn, moveCount, timestamp }
        clubs: {},          // clubId -> { id, name, tag, description, owner, members: [], messages: [], createdAt }
        activityFeed: [],   // { id, actor, actorName, actorClubTag, kind, text, matchId, clubId, createdAt }
        reports: []         // { id, reporter, target, reason, createdAt }
    };

    let dbSaveChain = Promise.resolve();
    const onlineSockets = new Map();    // wallet -> Set<ws>
    const directChallenges = new Map(); // challengeId -> challengeObj

    function loadDbSync() {
        try {
            if (fs.existsSync(SOCIAL_DB_FILE)) {
                const raw = fs.readFileSync(SOCIAL_DB_FILE, 'utf8');
                if (raw && raw.trim()) {
                    const parsed = JSON.parse(raw);
                    db = {
                        users: parsed.users || {},
                        friendships: Array.isArray(parsed.friendships) ? parsed.friendships : [],
                        follows: Array.isArray(parsed.follows) ? parsed.follows : [],
                        directMessages: Array.isArray(parsed.directMessages) ? parsed.directMessages : [],
                        matches: Array.isArray(parsed.matches) ? parsed.matches : [],
                        clubs: parsed.clubs || {},
                        activityFeed: Array.isArray(parsed.activityFeed) ? parsed.activityFeed : [],
                        reports: Array.isArray(parsed.reports) ? parsed.reports : []
                    };
                    for (const [w, u] of Object.entries(db.users)) {
                        if (u && u.username && !String(u.username).includes('...')) {
                            usernameToAddress.set(String(u.username).toLowerCase(), w.toLowerCase());
                        }
                    }
                    console.log(`[SOCIAL] Loaded social_db.json (${Object.keys(db.users).length} users, ${db.friendships.length} links, ${Object.keys(db.clubs).length} clubs)`);
                }
            } else {
                console.log('[SOCIAL] No existing social_db.json found — initializing fresh social graph.');
            }
        } catch (err) {
            console.error('[SOCIAL] Failed to load social_db.json — starting clean:', err.message);
        }
    }

    function saveDb() {
        dbSaveChain = dbSaveChain.then(async () => {
            try {
                const tmp = SOCIAL_DB_FILE + '.tmp';
                await fs.promises.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
                await fs.promises.rename(tmp, SOCIAL_DB_FILE);
            } catch (err) {
                console.error('[SOCIAL] Save failed:', err.message);
            }
        });
        return dbSaveChain;
    }

    loadDbSync();

    // =========================================================================
    // 2. IDENTITY, PRESENCE & RELATIONSHIP HELPERS
    // =========================================================================
    function normalizeWallet(addr) {
        if (!addr || typeof addr !== 'string') return null;
        const clean = addr.trim().toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(clean)) return null;
        if (clean === ethers.ZeroAddress.toLowerCase()) return null;
        return clean;
    }

    function ensureSocialUser(wallet, knownUsername = null) {
        const w = normalizeWallet(wallet);
        if (!w) return null;
        if (!db.users[w]) {
            db.users[w] = {
                wallet: w,
                username: null,
                privacy: { ...DEFAULT_PRIVACY },
                notes: {},
                clubId: null,
                totalZkLtcWon: 0,
                currentStreak: 0,
                bestStreak: 0,
                lastSeen: Date.now(),
                createdAt: Date.now()
            };
        }
        const u = db.users[w];
        if (!u.privacy) u.privacy = { ...DEFAULT_PRIVACY };
        if (!u.notes) u.notes = {};
        if (knownUsername && typeof knownUsername === 'string') {
            const trimmed = knownUsername.trim();
            if (trimmed && !trimmed.includes('...') && !trimmed.startsWith('Guest')) {
                u.username = trimmed;
                usernameToAddress.set(trimmed.toLowerCase(), w);
            }
        }
        return u;
    }

    function getDisplayName(wallet) {
        const w = normalizeWallet(wallet);
        if (!w) return 'Guest';
        if (db.users[w] && db.users[w].username) return db.users[w].username;
        if (playerRatings[w] && playerRatings[w].username) return playerRatings[w].username;
        return w.slice(0, 6) + '...' + w.slice(-4);
    }

    function getClubTagForWallet(wallet) {
        const w = normalizeWallet(wallet);
        if (!w || !db.users[w] || !db.users[w].clubId) return null;
        const club = db.clubs[db.users[w].clubId];
        return club ? club.tag : null;
    }

    function sendToWallet(wallet, payload) {
        const w = normalizeWallet(wallet);
        if (!w) return;
        const socks = onlineSockets.get(w);
        if (!socks || socks.size === 0) return;
        const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
        for (const sock of socks) {
            sendSafe(sock, serialized);
        }
    }

    function findActiveMatchForWallet(wallet) {
        const w = normalizeWallet(wallet);
        if (!w) return null;
        for (const [matchId, room] of rooms.entries()) {
            if (room.gameEnded) continue;
            if (room.whiteWallet === w || room.blackWallet === w) {
                return { matchId, timeControl: room.timeControlName || 'blitz', isPaid: !!room.isPaidMode };
            }
            for (const [, p] of room.players) {
                if (p.wallet && p.wallet.toLowerCase() === w) {
                    return { matchId, timeControl: room.timeControlName || 'blitz', isPaid: !!room.isPaidMode };
                }
            }
        }
        return null;
    }

    function computePresence(wallet) {
        const w = normalizeWallet(wallet);
        if (!w) return { status: 'offline', activeMatchId: null, lastSeen: null };

        const activeMatch = findActiveMatchForWallet(w);
        if (activeMatch) {
            return {
                status: 'in_match',
                activeMatchId: activeMatch.matchId,
                timeControl: activeMatch.timeControl,
                isPaid: activeMatch.isPaid,
                lastSeen: Date.now()
            };
        }

        const socks = onlineSockets.get(w);
        if (socks && socks.size > 0) {
            let anyActive = false;
            for (const s of socks) {
                if (s.presenceState !== 'away') {
                    anyActive = true;
                    break;
                }
            }
            return {
                status: anyActive ? 'online' : 'away',
                activeMatchId: null,
                lastSeen: Date.now()
            };
        }

        const u = db.users[w];
        return {
            status: 'offline',
            activeMatchId: null,
            lastSeen: u ? (u.lastSeen || null) : null
        };
    }

    function getAcceptedFriendWallets(wallet) {
        const w = normalizeWallet(wallet);
        if (!w) return [];
        const res = [];
        for (const f of db.friendships) {
            if (f.status !== 'accepted') continue;
            if (f.requester === w) res.push(f.recipient);
            else if (f.recipient === w) res.push(f.requester);
        }
        return res;
    }

    function getFollowerWallets(wallet) {
        const w = normalizeWallet(wallet);
        if (!w) return [];
        return db.follows.filter(f => f.target === w).map(f => f.follower);
    }

    function getFollowingWallets(wallet) {
        const w = normalizeWallet(wallet);
        if (!w) return [];
        return db.follows.filter(f => f.follower === w).map(f => f.target);
    }

    function isBlockedBetween(w1, w2) {
        const a = normalizeWallet(w1);
        const b = normalizeWallet(w2);
        if (!a || !b) return false;
        return db.friendships.some(f =>
            f.status === 'blocked' &&
            ((f.requester === a && f.recipient === b) || (f.requester === b && f.recipient === a))
        );
    }

    function hasBlocked(blocker, target) {
        const a = normalizeWallet(blocker);
        const b = normalizeWallet(target);
        if (!a || !b) return false;
        return db.friendships.some(f => f.status === 'blocked' && f.requester === a && f.recipient === b);
    }

    function getRelationship(viewerWallet, targetWallet) {
        const me = normalizeWallet(viewerWallet);
        const target = normalizeWallet(targetWallet);
        if (!me || !target) return 'none';
        if (me === target) return 'self';

        const blockEdge = db.friendships.find(f =>
            f.status === 'blocked' &&
            ((f.requester === me && f.recipient === target) || (f.requester === target && f.recipient === me))
        );
        if (blockEdge) {
            return blockEdge.requester === me ? 'blocked_by_me' : 'blocked_by_them';
        }

        const edge = db.friendships.find(f =>
            (f.requester === me && f.recipient === target) ||
            (f.requester === target && f.recipient === me)
        );
        if (!edge) return 'none';
        if (edge.status === 'accepted') return 'friends';
        if (edge.status === 'pending') {
            return edge.requester === me ? 'outgoing_request' : 'incoming_request';
        }
        return 'none';
    }

    function notifyPresenceChange(wallet) {
        const w = normalizeWallet(wallet);
        if (!w) return;
        const presence = computePresence(w);
        const username = getDisplayName(w);
        const clubTag = getClubTagForWallet(w);
        const watchers = new Set([...getAcceptedFriendWallets(w), ...getFollowerWallets(w)]);
        const payload = {
            type: 'FRIEND_PRESENCE_UPDATE',
            wallet: w,
            username,
            clubTag,
            presence
        };
        for (const watcher of watchers) {
            sendToWallet(watcher, payload);
        }
    }

    function getThreadId(w1, w2) {
        return [w1.toLowerCase(), w2.toLowerCase()].sort().join('_');
    }

    function getUnreadCountsForWallet(wallet) {
        const w = normalizeWallet(wallet);
        const bySender = {};
        let total = 0;
        if (!w) return { total: 0, bySender };
        for (const msg of db.directMessages) {
            if (msg.recipient === w && !msg.readAt) {
                bySender[msg.sender] = (bySender[msg.sender] || 0) + 1;
                total++;
            }
        }
        return { total, bySender };
    }

    function buildFriendsSyncPayload(wallet) {
        const w = normalizeWallet(wallet);
        const u = ensureSocialUser(w);
        const unread = getUnreadCountsForWallet(w);

        const friends = getAcceptedFriendWallets(w).map(fw => ({
            wallet: fw,
            username: getDisplayName(fw),
            clubTag: getClubTagForWallet(fw),
            ratings: getRatingsObject(fw),
            presence: computePresence(fw),
            unreadDms: unread.bySender[fw] || 0
        }));

        const statusRank = { in_match: 0, online: 1, away: 2, offline: 3 };
        friends.sort((a, b) =>
            (statusRank[a.presence.status] ?? 4) - (statusRank[b.presence.status] ?? 4) ||
            (b.ratings.blitz || 2000) - (a.ratings.blitz || 2000)
        );

        const following = getFollowingWallets(w).map(tw => ({
            wallet: tw,
            username: getDisplayName(tw),
            clubTag: getClubTagForWallet(tw),
            ratings: getRatingsObject(tw),
            presence: computePresence(tw)
        }));
        following.sort((a, b) =>
            (statusRank[a.presence.status] ?? 4) - (statusRank[b.presence.status] ?? 4) ||
            (b.ratings.blitz || 2000) - (a.ratings.blitz || 2000)
        );

        const incomingRequests = db.friendships
            .filter(f => f.status === 'pending' && f.recipient === w)
            .map(f => ({
                id: f.id,
                wallet: f.requester,
                username: getDisplayName(f.requester),
                clubTag: getClubTagForWallet(f.requester),
                ratings: getRatingsObject(f.requester),
                presence: computePresence(f.requester),
                createdAt: f.createdAt
            }));

        const outgoingRequests = db.friendships
            .filter(f => f.status === 'pending' && f.requester === w)
            .map(f => ({
                id: f.id,
                wallet: f.recipient,
                username: getDisplayName(f.recipient),
                clubTag: getClubTagForWallet(f.recipient),
                ratings: getRatingsObject(f.recipient),
                presence: computePresence(f.recipient),
                createdAt: f.createdAt
            }));

        const blocked = db.friendships
            .filter(f => f.status === 'blocked' && f.requester === w)
            .map(f => ({
                wallet: f.recipient,
                username: getDisplayName(f.recipient)
            }));

        const threadPartners = new Map();
        for (const msg of db.directMessages) {
            if (msg.sender === w || msg.recipient === w) {
                const partner = msg.sender === w ? msg.recipient : msg.sender;
                if (!hasBlocked(w, partner)) {
                    const prev = threadPartners.get(partner);
                    if (!prev || msg.createdAt > prev.lastTimestamp) {
                        threadPartners.set(partner, {
                            wallet: partner,
                            username: getDisplayName(partner),
                            clubTag: getClubTagForWallet(partner),
                            lastMessage: msg.body,
                            lastTimestamp: msg.createdAt,
                            unread: unread.bySender[partner] || 0,
                            presence: computePresence(partner)
                        });
                    }
                }
            }
        }
        const dmThreads = [...threadPartners.values()].sort((a, b) => b.lastTimestamp - a.lastTimestamp);

        const incomingChallenges = [];
        const now = Date.now();
        for (const ch of directChallenges.values()) {
            if (ch.toWallet === w && ch.expiresAt > now) {
                incomingChallenges.push({
                    challengeId: ch.challengeId,
                    fromWallet: ch.fromWallet,
                    fromName: ch.fromName,
                    fromRatings: getRatingsObject(ch.fromWallet),
                    timeControl: ch.timeControl,
                    sidePref: ch.sidePref,
                    isPaid: ch.isPaid,
                    stake: ch.stake,
                    matchId: ch.matchId,
                    ephemeralPrivateKey: ch.ephemeralPrivateKey || null,
                    expiresAt: ch.expiresAt
                });
            }
        }

        const myClub = u.clubId && db.clubs[u.clubId] ? buildClubSummary(db.clubs[u.clubId], true) : null;

        return {
            type: 'FRIENDS_SYNC',
            me: {
                wallet: w,
                username: getDisplayName(w),
                privacy: u.privacy || { ...DEFAULT_PRIVACY },
                clubId: u.clubId || null,
                clubTag: myClub ? myClub.tag : null,
                totalZkLtcWon: Number((u.totalZkLtcWon || 0).toFixed(4)),
                currentStreak: u.currentStreak || 0,
                bestStreak: u.bestStreak || 0
            },
            friends,
            following,
            incomingRequests,
            outgoingRequests,
            blocked,
            dmThreads,
            unreadDmTotal: unread.total,
            incomingChallenges,
            myClub,
            activityFeed: getFilteredActivityFeed(w)
        };
    }

    function pushSyncToWallet(wallet) {
        const w = normalizeWallet(wallet);
        if (!w || !onlineSockets.has(w)) return;
        sendToWallet(w, buildFriendsSyncPayload(w));
    }

    // =========================================================================
    // 3. ACTIVITY FEED ENGINE
    // =========================================================================
    function emitActivityEvent(actorWallet, kind, text, extra = {}) {
        const actor = normalizeWallet(actorWallet);
        if (!actor) return;
        const event = {
            id: crypto.randomBytes(8).toString('hex'),
            actor,
            actorName: getDisplayName(actor),
            actorClubTag: getClubTagForWallet(actor),
            kind,
            text,
            matchId: extra.matchId || null,
            clubId: extra.clubId || null,
            createdAt: Date.now()
        };
        db.activityFeed.unshift(event);
        if (db.activityFeed.length > 150) {
            db.activityFeed.length = 150;
        }
        saveDb();

        const audience = new Set([actor, ...getAcceptedFriendWallets(actor), ...getFollowerWallets(actor)]);
        for (const target of audience) {
            sendToWallet(target, { type: 'ACTIVITY_EVENT', event });
        }
    }

    function getFilteredActivityFeed(wallet) {
        const w = normalizeWallet(wallet);
        if (!w) return db.activityFeed.slice(0, 25);
        const socialCircle = new Set([w, ...getAcceptedFriendWallets(w), ...getFollowingWallets(w)]);
        const personal = db.activityFeed.filter(e => socialCircle.has(e.actor));
        if (personal.length < 10) {
            const seen = new Set(personal.map(e => e.id));
            const globalPad = db.activityFeed.filter(e => !seen.has(e.id)).slice(0, 15 - personal.length);
            return [...personal, ...globalPad].sort((a, b) => b.createdAt - a.createdAt).slice(0, 25);
        }
        return personal.slice(0, 25);
    }

    // =========================================================================
    // 4. HEAD-TO-HEAD (H2H), RIVALRIES & MATCH HISTORY RECORDER
    // =========================================================================
    function computeHeadToHead(viewerWallet, targetWallet) {
        const me = normalizeWallet(viewerWallet);
        const them = normalizeWallet(targetWallet);
        if (!me || !them || me === them) return null;

        let myWins = 0;
        let theirWins = 0;
        let draws = 0;
        let lastPlayed = null;
        const recentSeries = [];

        for (const m of db.matches) {
            const isPair = (m.white === me && m.black === them) || (m.white === them && m.black === me);
            if (!isPair) continue;

            if (!lastPlayed || m.timestamp > lastPlayed) lastPlayed = m.timestamp;
            let outcome = 'D';
            if (!m.winner || m.winner === ethers.ZeroAddress) {
                draws++;
            } else if (m.winner === me) {
                myWins++;
                outcome = 'W';
            } else {
                theirWins++;
                outcome = 'L';
            }
            if (recentSeries.length < 5) {
                recentSeries.push({ matchId: m.matchId, outcome, timeControl: m.timeControl, isPaid: m.isPaid });
            }
        }

        const total = myWins + theirWins + draws;
        return {
            total,
            myWins,
            theirWins,
            draws,
            isRival: total >= 3,
            lastPlayed,
            recentSeries
        };
    }

    function recordMatchCompleted(info) {
        const {
            matchId,
            whiteWallet,
            blackWallet,
            whiteUsername,
            blackUsername,
            winnerWallet,
            winnerColor,
            reason,
            timeControl,
            isPaid,
            wagerEth,
            pgn,
            moveCount,
            newWhiteRating,
            newBlackRating,
            oldWhiteRating,
            oldBlackRating
        } = info;

        const wWhite = normalizeWallet(whiteWallet);
        const wBlack = normalizeWallet(blackWallet);
        const wWinner = normalizeWallet(winnerWallet);

        const matchRecord = {
            matchId: String(matchId || crypto.randomBytes(16).toString('hex')),
            white: wWhite,
            black: wBlack,
            whiteName: whiteUsername || (wWhite ? getDisplayName(wWhite) : 'White'),
            blackName: blackUsername || (wBlack ? getDisplayName(wBlack) : 'Black'),
            winner: wWinner || null,
            winnerColor: winnerColor || null,
            reason: reason || 'completed',
            timeControl: timeControl || 'blitz',
            isPaid: !!isPaid,
            wagerEth: Number(wagerEth || 0),
            pgn: String(pgn || ''),
            moveCount: Number(moveCount || 0),
            timestamp: Date.now()
        };

        if (!db.matches.some(m => m.matchId === matchRecord.matchId)) {
            db.matches.unshift(matchRecord);
            if (db.matches.length > 2000) db.matches.length = 2000;
        }

        if (wWhite) {
            const uW = ensureSocialUser(wWhite, matchRecord.whiteName);
            if (wWinner === wWhite) {
                uW.currentStreak = (uW.currentStreak || 0) + 1;
                if (uW.currentStreak > (uW.bestStreak || 0)) uW.bestStreak = uW.currentStreak;
                if (isPaid && wagerEth > 0) uW.totalZkLtcWon = Number(((uW.totalZkLtcWon || 0) + Number(wagerEth)).toFixed(6));
            } else {
                uW.currentStreak = 0;
            }
        }
        if (wBlack) {
            const uB = ensureSocialUser(wBlack, matchRecord.blackName);
            if (wWinner === wBlack) {
                uB.currentStreak = (uB.currentStreak || 0) + 1;
                if (uB.currentStreak > (uB.bestStreak || 0)) uB.bestStreak = uB.currentStreak;
                if (isPaid && wagerEth > 0) uB.totalZkLtcWon = Number(((uB.totalZkLtcWon || 0) + Number(wagerEth)).toFixed(6));
            } else {
                uB.currentStreak = 0;
            }
        }

        saveDb();

        if (wWinner && isPaid && wagerEth > 0) {
            const loserName = wWinner === wWhite ? matchRecord.blackName : matchRecord.whiteName;
            emitActivityEvent(
                wWinner,
                'wager_win',
                `won a ${wagerEth} zkLTC ${matchRecord.timeControl} match vs ${loserName}`,
                { matchId: matchRecord.matchId }
            );
        } else if (wWinner && wWhite && wBlack) {
            const loserName = wWinner === wWhite ? matchRecord.blackName : matchRecord.whiteName;
            const uWin = db.users[wWinner];
            if (uWin && uWin.currentStreak >= 3) {
                emitActivityEvent(
                    wWinner,
                    'streak',
                    `is on a 🔥 ${uWin.currentStreak}-game win streak (defeated ${loserName})`,
                    { matchId: matchRecord.matchId }
                );
            }
        }

        const checkMilestone = (wallet, oldR, newR) => {
            if (!wallet || !oldR || !newR || newR <= oldR) return;
            const prevStep = Math.floor(oldR / 50);
            const nextStep = Math.floor(newR / 50);
            if (nextStep > prevStep && newR >= 2050) {
                emitActivityEvent(
                    wallet,
                    'milestone',
                    `reached ${nextStep * 50} ${matchRecord.timeControl.toUpperCase()} ELO!`,
                    { matchId: matchRecord.matchId }
                );
            }
        };
        checkMilestone(wWhite, oldWhiteRating, newWhiteRating);
        checkMilestone(wBlack, oldBlackRating, newBlackRating);

        if (wWhite && wBlack) {
            const h2h = computeHeadToHead(wWhite, wBlack);
            if (h2h && h2h.total === 3) {
                emitActivityEvent(
                    wWhite,
                    'rivalry',
                    `ignited a ⚔️ Rivalry with ${matchRecord.blackName} (${h2h.myWins}-${h2h.theirWins})`,
                    { matchId: matchRecord.matchId }
                );
            }
        }

        if (wWhite) notifyPresenceChange(wWhite);
        if (wBlack) notifyPresenceChange(wBlack);
    }

    // =========================================================================
    // 5. CLUBS / GUILDS ENGINE
    // =========================================================================
    function buildClubSummary(club, includeDetails = false) {
        if (!club) return null;
        const memberRows = (club.members || []).map(mw => {
            const r = getRatingsObject(mw);
            return {
                wallet: mw,
                username: getDisplayName(mw),
                blitz: r.blitz || 2000,
                bullet: r.bullet || 2000,
                rapid: r.rapid || 2000,
                presence: computePresence(mw),
                isOwner: mw === club.owner
            };
        });
        memberRows.sort((a, b) => b.blitz - a.blitz);
        const avgBlitz = memberRows.length > 0
            ? Math.round(memberRows.reduce((acc, m) => acc + m.blitz, 0) / memberRows.length)
            : 2000;

        const base = {
            id: club.id,
            name: club.name,
            tag: club.tag,
            description: club.description || '',
            owner: club.owner,
            ownerName: getDisplayName(club.owner),
            memberCount: memberRows.length,
            avgBlitz,
            tourneyId: `club-${club.id}-arena`,
            createdAt: club.createdAt
        };

        if (includeDetails) {
            base.members = memberRows;
            base.messages = (club.messages || []).slice(-50);
        }
        return base;
    }

    // =========================================================================
    // 6. PROFILE BUILDER
    // =========================================================================
    function buildProfilePayload(viewerWallet, targetWallet) {
        const tw = normalizeWallet(targetWallet);
        if (!tw) return null;
        const u = ensureSocialUser(tw);
        const ratings = getRatingsObject(tw);
        const presence = computePresence(tw);
        const rel = getRelationship(viewerWallet, tw);
        const isFollowing = viewerWallet
            ? db.follows.some(f => f.follower === normalizeWallet(viewerWallet) && f.target === tw)
            : false;

        const recentGames = [];
        const recentForm = [];
        for (const m of db.matches) {
            if (m.white !== tw && m.black !== tw) continue;
            let resultForTarget = 'D';
            if (m.winner && m.winner !== ethers.ZeroAddress) {
                resultForTarget = m.winner === tw ? 'W' : 'L';
            }
            if (recentForm.length < 5) recentForm.push(resultForTarget);
            if (recentGames.length < 10) {
                recentGames.push({
                    matchId: m.matchId,
                    white: m.white,
                    black: m.black,
                    whiteName: m.whiteName,
                    blackName: m.blackName,
                    result: resultForTarget,
                    winnerColor: m.winnerColor,
                    reason: m.reason,
                    timeControl: m.timeControl,
                    isPaid: m.isPaid,
                    wagerEth: m.wagerEth,
                    pgn: m.pgn,
                    moveCount: m.moveCount,
                    timestamp: m.timestamp
                });
            }
            if (recentGames.length >= 10) break;
        }

        const club = u.clubId && db.clubs[u.clubId] ? db.clubs[u.clubId] : null;
        const viewerUser = viewerWallet ? db.users[normalizeWallet(viewerWallet)] : null;
        const myNote = (viewerUser && viewerUser.notes && viewerUser.notes[tw]) ? viewerUser.notes[tw] : '';

        return {
            type: 'PROFILE_DATA',
            wallet: tw,
            username: getDisplayName(tw),
            ratings,
            presence,
            relationship: rel,
            isFollowing,
            followerCount: getFollowerWallets(tw).length,
            friendCount: getAcceptedFriendWallets(tw).length,
            totalZkLtcWon: Number((u.totalZkLtcWon || 0).toFixed(4)),
            currentStreak: u.currentStreak || 0,
            bestStreak: u.bestStreak || 0,
            recentForm,
            recentGames,
            h2h: computeHeadToHead(viewerWallet, tw),
            club: club ? { id: club.id, name: club.name, tag: club.tag } : null,
            note: myNote,
            privacy: u.privacy || { ...DEFAULT_PRIVACY },
            createdAt: u.createdAt || null
        };
    }

    // =========================================================================
    // 7. DIRECT CHALLENGE LIFECYCLE HELPERS
    // =========================================================================
    function expireDirectChallenge(challengeId) {
        const ch = directChallenges.get(challengeId);
        if (!ch) return;
        if (ch.timeoutHandle) clearTimeout(ch.timeoutHandle);
        directChallenges.delete(challengeId);

        sendToWallet(ch.fromWallet, {
            type: 'DIRECT_CHALLENGE_EXPIRED',
            challengeId,
            toWallet: ch.toWallet,
            toName: ch.toName,
            isPaid: ch.isPaid,
            matchId: ch.matchId || null
        });
        sendToWallet(ch.toWallet, {
            type: 'DIRECT_CHALLENGE_EXPIRED',
            challengeId,
            fromWallet: ch.fromWallet,
            fromName: ch.fromName
        });
    }

    function canSendToTarget(senderWallet, targetWallet, settingKey) {
        if (isBlockedBetween(senderWallet, targetWallet)) {
            return { allowed: false, reason: 'Action unavailable due to privacy/block settings.' };
        }
        const targetUser = ensureSocialUser(targetWallet);
        const mode = (targetUser.privacy && targetUser.privacy[settingKey]) || 'everyone';
        if (mode === 'nobody') {
            return { allowed: false, reason: `${getDisplayName(targetWallet)} has disabled incoming ${settingKey === 'dms' ? 'DMs' : 'challenges'}.` };
        }
        if (mode === 'friends' && getRelationship(senderWallet, targetWallet) !== 'friends') {
            return { allowed: false, reason: `${getDisplayName(targetWallet)} only accepts ${settingKey === 'dms' ? 'DMs' : 'challenges'} from friends.` };
        }
        return { allowed: true };
    }

    // =========================================================================
    // 8. CONNECTION & MESSAGE ROUTER
    // =========================================================================
    function onConnect(ws) {
        ws.socialNonce = crypto.randomBytes(16).toString('hex');
        ws.socialWallet = null;
        ws.presenceState = 'online';
        sendSafe(ws, { type: 'SOCIAL_HELLO', nonce: ws.socialNonce });
    }

    function onDisconnect(ws) {
        const w = ws.socialWallet;
        if (!w) return;
        const socks = onlineSockets.get(w);
        if (socks) {
            socks.delete(ws);
            if (socks.size === 0) {
                onlineSockets.delete(w);
                const u = db.users[w];
                if (u) {
                    u.lastSeen = Date.now();
                    saveDb();
                }
            }
        }
        notifyPresenceChange(w);
    }

    async function handleMessage(ws, message) {
        const { type } = message;

        // ---------- 1. ZERO-POPUP SOCIAL AUTHENTICATION ----------
        if (type === 'AUTH_SOCIAL') {
            const cleanWallet = normalizeWallet(message.wallet);
            if (!cleanWallet || !message.signature) {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Missing social authentication parameters.' });
                return true;
            }

            try {
                const expectedAuthMsg = `LITCHESS_SOCIAL_${cleanWallet}_${ws.socialNonce}`;
                let recovered = null;

                if (message.delegateAddress && message.delegateSignature) {
                    const cleanDelegate = normalizeWallet(message.delegateAddress);
                    if (!cleanDelegate) throw new Error('Invalid delegate address');
                    const expectedDelegateMsg = `LITCHESS_DELEGATE_${cleanWallet}_${cleanDelegate}`;
                    const delegateSigner = ethers.verifyMessage(expectedDelegateMsg, message.delegateSignature).toLowerCase();
                    const nonceSigner = ethers.verifyMessage(expectedAuthMsg, message.signature).toLowerCase();
                    if (delegateSigner === cleanWallet && nonceSigner === cleanDelegate) {
                        recovered = cleanWallet;
                    }
                } else {
                    const directSigner = ethers.verifyMessage(expectedAuthMsg, message.signature).toLowerCase();
                    if (directSigner === cleanWallet) {
                        recovered = cleanWallet;
                    }
                }

                if (recovered !== cleanWallet) {
                    sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Invalid social signature.' });
                    return true;
                }

                ws.socialNonce = crypto.randomBytes(16).toString('hex');

                if (ws.socialWallet && ws.socialWallet !== cleanWallet) {
                    onDisconnect(ws);
                }

                ws.socialWallet = cleanWallet;
                ws.presenceState = 'online';

                if (!onlineSockets.has(cleanWallet)) {
                    onlineSockets.set(cleanWallet, new Set());
                }
                onlineSockets.get(cleanWallet).add(ws);

                const resolvedName = await fetchUsername(cleanWallet);
                ensurePlayerRecord(cleanWallet);
                const u = ensureSocialUser(cleanWallet, resolvedName);
                u.lastSeen = Date.now();
                if (resolvedName && !resolvedName.includes('...')) {
                    u.username = resolvedName;
                    usernameToAddress.set(resolvedName.toLowerCase(), cleanWallet);
                }
                await saveDb();

                sendSafe(ws, { type: 'SOCIAL_AUTH_OK', wallet: cleanWallet, username: getDisplayName(cleanWallet) });
                sendSafe(ws, buildFriendsSyncPayload(cleanWallet));
                notifyPresenceChange(cleanWallet);
            } catch (err) {
                console.error('[SOCIAL AUTH] Error:', err.message);
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Social authentication failed.' });
            }
            return true;
        }

        // ---------- 2. PRESENCE STATUS UPDATE (Online <-> Away) ----------
        if (type === 'PRESENCE_SET') {
            if (!ws.socialWallet) return true;
            const nextState = message.status === 'away' ? 'away' : 'online';
            if (ws.presenceState !== nextState) {
                ws.presenceState = nextState;
                notifyPresenceChange(ws.socialWallet);
            }
            return true;
        }

        // ---------- 3. MULTI-RESULT FUZZY SEARCH (Works for Guests & Authed) ----------
        if (type === 'SEARCH_USERS') {
            const rawQuery = String(message.query || '').trim();
            const query = rawQuery.toLowerCase();
            if (!query) {
                sendSafe(ws, { type: 'SEARCH_USERS_RESULT', query: rawQuery, results: [] });
                return true;
            }

            const candidateWallets = new Set();

            for (const w of Object.keys(db.users)) candidateWallets.add(w.toLowerCase());
            for (const w of Object.keys(playerRatings)) candidateWallets.add(w.toLowerCase());
            for (const w of onlineSockets.keys()) candidateWallets.add(w.toLowerCase());
            for (const [, r] of rooms.entries()) {
                for (const [, p] of r.players) {
                    if (p.wallet) candidateWallets.add(p.wallet.toLowerCase());
                }
            }

            if (/^0x[0-9a-f]{40}$/.test(query) && !candidateWallets.has(query)) {
                const onChainName = await fetchUsername(query);
                ensureSocialUser(query, onChainName);
                candidateWallets.add(query);
            }

            const scored = [];
            for (const w of candidateWallets) {
                if (!/^0x[0-9a-f]{40}$/.test(w)) continue;
                const uname = getDisplayName(w);
                const lowerName = uname.toLowerCase();
                let score = 0;

                if (lowerName === query || w === query) score = 100;
                else if (lowerName.startsWith(query) || w.startsWith(query)) score = 70;
                else if (lowerName.includes(query)) score = 40;
                else continue;

                const presence = computePresence(w);
                if (presence.status === 'in_match') score += 15;
                else if (presence.status === 'online') score += 12;
                else if (presence.status === 'away') score += 5;

                const ratings = getRatingsObject(w);
                scored.push({
                    score,
                    wallet: w,
                    username: uname,
                    clubTag: getClubTagForWallet(w),
                    ratings,
                    presence,
                    relationship: getRelationship(ws.socialWallet, w),
                    isFollowing: ws.socialWallet
                        ? db.follows.some(f => f.follower === ws.socialWallet && f.target === w)
                        : false
                });
            }

            scored.sort((a, b) => b.score - a.score || (b.ratings.blitz || 2000) - (a.ratings.blitz || 2000));
            const limit = Math.min(12, Math.max(1, Number(message.limit) || 8));

            sendSafe(ws, {
                type: 'SEARCH_USERS_RESULT',
                query: rawQuery,
                results: scored.slice(0, limit).map(({ score, ...rest }) => rest)
            });
            return true;
        }

        // ---------- 4. GLOBAL ELO LEADERBOARD ----------
        if (type === 'GET_LEADERBOARD') {
            const format = ['bullet', 'blitz', 'rapid'].includes(message.format) ? message.format : 'blitz';
            const allWallets = new Set([
                ...Object.keys(playerRatings),
                ...Object.keys(db.users)
            ]);

            const entries = [];
            for (const w of allWallets) {
                if (!/^0x[0-9a-f]{40}$/.test(w)) continue;
                const r = getRatingsObject(w);
                entries.push({
                    wallet: w,
                    username: getDisplayName(w),
                    clubTag: getClubTagForWallet(w),
                    rating: r[format] || 2000,
                    ratings: r,
                    presence: computePresence(w),
                    relationship: getRelationship(ws.socialWallet, w),
                    isFollowing: ws.socialWallet
                        ? db.follows.some(f => f.follower === ws.socialWallet && f.target === w)
                        : false
                });
            }

            entries.sort((a, b) => b.rating - a.rating || (b.ratings.gamesPlayed || 0) - (a.ratings.gamesPlayed || 0));
            sendSafe(ws, {
                type: 'LEADERBOARD_DATA',
                format,
                players: entries.slice(0, 25)
            });
            return true;
        }

        // ---------- 5. PLAYER PROFILE INSPECTOR ----------
        if (type === 'GET_PROFILE') {
            let target = normalizeWallet(message.wallet);
            if (!target && message.username) {
                const lookup = String(message.username).trim().toLowerCase();
                target = usernameToAddress.get(lookup) || null;
                if (!target) {
                    for (const [w, u] of Object.entries(db.users)) {
                        if (u.username && u.username.toLowerCase() === lookup) {
                            target = w;
                            break;
                        }
                    }
                }
            }
            if (!target) {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Player profile not found.' });
                return true;
            }
            sendSafe(ws, buildProfilePayload(ws.socialWallet, target));
            return true;
        }

        // ---------- 6. CLUBS LIST & DETAILS (Readable by anyone) ----------
        if (type === 'CLUB_LIST') {
            const clubs = Object.values(db.clubs)
                .map(c => buildClubSummary(c, false))
                .sort((a, b) => b.memberCount - a.memberCount || b.avgBlitz - a.avgBlitz);
            sendSafe(ws, { type: 'CLUB_LIST_DATA', clubs });
            return true;
        }

        if (type === 'CLUB_DETAILS') {
            const clubId = String(message.clubId || '').trim().toLowerCase();
            const club = db.clubs[clubId];
            if (!club) {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Club not found.' });
                return true;
            }
            sendSafe(ws, { type: 'CLUB_DETAILS_DATA', club: buildClubSummary(club, true) });
            return true;
        }

        if (type === 'GET_ACTIVITY_FEED') {
            sendSafe(ws, { type: 'ACTIVITY_FEED_DATA', events: getFilteredActivityFeed(ws.socialWallet) });
            return true;
        }

        // =====================================================================
        // AUTHENTICATED SOCIAL ACTIONS BELOW THIS LINE
        // =====================================================================
        const AUTH_ONLY_TYPES = new Set([
            'FRIENDS_SYNC_REQUEST',
            'FRIEND_REQUEST_SEND',
            'FRIEND_REQUEST_RESPOND',
            'FRIEND_REMOVE',
            'FOLLOW_TOGGLE',
            'USER_BLOCK',
            'USER_UNBLOCK',
            'USER_REPORT',
            'PRIVACY_UPDATE',
            'PLAYER_NOTE_SAVE',
            'DIRECT_CHALLENGE_SEND',
            'DIRECT_CHALLENGE_RESPOND',
            'DIRECT_CHALLENGE_CANCEL',
            'DM_SEND',
            'DM_HISTORY',
            'DM_MARK_READ',
            'CLUB_CREATE',
            'CLUB_JOIN',
            'CLUB_LEAVE',
            'CLUB_CHAT_SEND'
        ]);

        if (!AUTH_ONLY_TYPES.has(type)) {
            return false;
        }

        if (!ws.socialWallet) {
            sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Connect your Web3 wallet to use social features.' });
            return true;
        }

        const me = ws.socialWallet;

        // ---------- FRIENDS SYNC REQUEST ----------
        if (type === 'FRIENDS_SYNC_REQUEST') {
            sendSafe(ws, buildFriendsSyncPayload(me));
            return true;
        }

        // ---------- FRIEND REQUEST SEND ----------
        if (type === 'FRIEND_REQUEST_SEND') {
            const target = normalizeWallet(message.targetWallet);
            if (!target || target === me) {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Invalid friend request target.' });
                return true;
            }
            if (isBlockedBetween(me, target)) {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Cannot send friend request to this user.' });
                return true;
            }

            const existing = db.friendships.find(f =>
                (f.requester === me && f.recipient === target) ||
                (f.requester === target && f.recipient === me)
            );

            if (existing) {
                if (existing.status === 'accepted') {
                    sendSafe(ws, { type: 'SOCIAL_INFO', message: `You are already friends with ${getDisplayName(target)}.` });
                    return true;
                }
                if (existing.status === 'pending' && existing.requester === target) {
                    existing.status = 'accepted';
                    existing.updatedAt = Date.now();
                    await saveDb();
                    sendToWallet(target, { type: 'SOCIAL_INFO', message: `${getDisplayName(me)} accepted your friend request!` });
                    pushSyncToWallet(me);
                    pushSyncToWallet(target);
                    return true;
                }
                if (existing.status === 'pending' && existing.requester === me) {
                    sendSafe(ws, { type: 'SOCIAL_INFO', message: 'Friend request already pending.' });
                    return true;
                }
            }

            ensureSocialUser(target);
            const reqRecord = {
                id: crypto.randomBytes(10).toString('hex'),
                requester: me,
                recipient: target,
                status: 'pending',
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            db.friendships.push(reqRecord);
            await saveDb();

            sendToWallet(target, {
                type: 'FRIEND_REQUEST_RECEIVED',
                request: {
                    id: reqRecord.id,
                    wallet: me,
                    username: getDisplayName(me),
                    clubTag: getClubTagForWallet(me),
                    ratings: getRatingsObject(me),
                    presence: computePresence(me),
                    createdAt: reqRecord.createdAt
                }
            });
            sendSafe(ws, { type: 'SOCIAL_INFO', message: `Friend request sent to ${getDisplayName(target)}.` });
            pushSyncToWallet(me);
            pushSyncToWallet(target);
            return true;
        }

        // ---------- FRIEND REQUEST RESPOND (accept / decline / cancel) ----------
        if (type === 'FRIEND_REQUEST_RESPOND') {
            const { requestId, action } = message;
            const idx = db.friendships.findIndex(f => f.id === requestId && f.status === 'pending');
            if (idx === -1) {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Friend request no longer exists.' });
                return true;
            }
            const reqRecord = db.friendships[idx];

            if (action === 'accept') {
                if (reqRecord.recipient !== me) {
                    sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Not authorized to accept this request.' });
                    return true;
                }
                reqRecord.status = 'accepted';
                reqRecord.updatedAt = Date.now();
                await saveDb();
                sendToWallet(reqRecord.requester, {
                    type: 'SOCIAL_INFO',
                    message: `${getDisplayName(me)} accepted your friend request!`
                });
                sendSafe(ws, { type: 'SOCIAL_INFO', message: `You are now friends with ${getDisplayName(reqRecord.requester)}!` });
                pushSyncToWallet(me);
                pushSyncToWallet(reqRecord.requester);
                return true;
            }

            if (action === 'decline') {
                if (reqRecord.recipient !== me) {
                    sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Not authorized to decline this request.' });
                    return true;
                }
                db.friendships.splice(idx, 1);
                await saveDb();
                sendSafe(ws, { type: 'SOCIAL_INFO', message: 'Friend request declined.' });
                pushSyncToWallet(me);
                pushSyncToWallet(reqRecord.requester);
                return true;
            }

            if (action === 'cancel') {
                if (reqRecord.requester !== me) {
                    sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Not authorized to cancel this request.' });
                    return true;
                }
                const target = reqRecord.recipient;
                db.friendships.splice(idx, 1);
                await saveDb();
                sendSafe(ws, { type: 'SOCIAL_INFO', message: 'Friend request cancelled.' });
                pushSyncToWallet(me);
                pushSyncToWallet(target);
                return true;
            }
            return true;
        }

        // ---------- FRIEND REMOVE ----------
        if (type === 'FRIEND_REMOVE') {
            const target = normalizeWallet(message.targetWallet);
            if (!target) return true;
            const before = db.friendships.length;
            db.friendships = db.friendships.filter(f =>
                !(f.status === 'accepted' &&
                    ((f.requester === me && f.recipient === target) || (f.requester === target && f.recipient === me)))
            );
            if (db.friendships.length !== before) {
                await saveDb();
                sendSafe(ws, { type: 'SOCIAL_INFO', message: `Removed ${getDisplayName(target)} from friends.` });
                pushSyncToWallet(me);
                pushSyncToWallet(target);
            }
            return true;
        }

        // ---------- FOLLOW TOGGLE (One-way Lichess-style follow) ----------
        if (type === 'FOLLOW_TOGGLE') {
            const target = normalizeWallet(message.targetWallet);
            if (!target || target === me) return true;
            if (isBlockedBetween(me, target)) {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Cannot follow this user.' });
                return true;
            }
            const idx = db.follows.findIndex(f => f.follower === me && f.target === target);
            if (idx !== -1) {
                db.follows.splice(idx, 1);
                await saveDb();
                sendSafe(ws, { type: 'SOCIAL_INFO', message: `Unfollowed ${getDisplayName(target)}.` });
            } else {
                ensureSocialUser(target);
                db.follows.push({ follower: me, target, createdAt: Date.now() });
                await saveDb();
                sendSafe(ws, { type: 'SOCIAL_INFO', message: `Now following ${getDisplayName(target)}!` });
            }
            pushSyncToWallet(me);
            return true;
        }

        // ---------- BLOCK / UNBLOCK / REPORT ----------
        if (type === 'USER_BLOCK') {
            const target = normalizeWallet(message.targetWallet);
            if (!target || target === me) return true;
            db.friendships = db.friendships.filter(f =>
                !((f.requester === me && f.recipient === target) || (f.requester === target && f.recipient === me))
            );
            db.follows = db.follows.filter(f =>
                !((f.follower === me && f.target === target) || (f.follower === target && f.target === me))
            );
            db.friendships.push({
                id: crypto.randomBytes(8).toString('hex'),
                requester: me,
                recipient: target,
                status: 'blocked',
                createdAt: Date.now(),
                updatedAt: Date.now()
            });
            await saveDb();
            sendSafe(ws, { type: 'SOCIAL_INFO', message: `Blocked ${getDisplayName(target)}.` });
            pushSyncToWallet(me);
            pushSyncToWallet(target);
            return true;
        }

        if (type === 'USER_UNBLOCK') {
            const target = normalizeWallet(message.targetWallet);
            if (!target) return true;
            db.friendships = db.friendships.filter(f =>
                !(f.status === 'blocked' && f.requester === me && f.recipient === target)
            );
            await saveDb();
            sendSafe(ws, { type: 'SOCIAL_INFO', message: `Unblocked ${getDisplayName(target)}.` });
            pushSyncToWallet(me);
            return true;
        }

        if (type === 'USER_REPORT') {
            const target = normalizeWallet(message.targetWallet);
            const reason = String(message.reason || '').trim().slice(0, 240);
            if (!target || !reason) return true;
            db.reports.push({
                id: crypto.randomBytes(8).toString('hex'),
                reporter: me,
                target,
                reason,
                createdAt: Date.now()
            });
            if (db.reports.length > 500) db.reports.shift();
            await saveDb();
            sendSafe(ws, { type: 'SOCIAL_INFO', message: 'Report submitted to LitChess moderation.' });
            return true;
        }

        // ---------- PRIVACY SETTINGS & SCOUTING NOTES ----------
        if (type === 'PRIVACY_UPDATE') {
            const u = ensureSocialUser(me);
            const allowed = ['everyone', 'friends', 'nobody'];
            if (allowed.includes(message.challenges)) u.privacy.challenges = message.challenges;
            if (allowed.includes(message.dms)) u.privacy.dms = message.dms;
            await saveDb();
            sendSafe(ws, { type: 'SOCIAL_INFO', message: 'Privacy preferences saved.' });
            pushSyncToWallet(me);
            return true;
        }

        if (type === 'PLAYER_NOTE_SAVE') {
            const target = normalizeWallet(message.targetWallet);
            if (!target || target === me) return true;
            const u = ensureSocialUser(me);
            const note = String(message.note || '').trim().slice(0, 300);
            if (note) u.notes[target] = note;
            else delete u.notes[target];
            await saveDb();
            sendSafe(ws, { type: 'SOCIAL_INFO', message: 'Private scouting note saved.' });
            return true;
        }

        // ---------- DIRECT IN-APP CHALLENGES (Free & Wagered zkLTC) ----------
        if (type === 'DIRECT_CHALLENGE_SEND') {
            const target = normalizeWallet(message.targetWallet);
            if (!target || target === me) {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Invalid challenge target.' });
                return true;
            }
            const perm = canSendToTarget(me, target, 'challenges');
            if (!perm.allowed) {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: perm.reason });
                return true;
            }

            const targetPresence = computePresence(target);
            if (targetPresence.status === 'offline') {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: `${getDisplayName(target)} is currently offline.` });
                return true;
            }
            if (targetPresence.status === 'in_match') {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: `${getDisplayName(target)} is already in an active match.` });
                return true;
            }

            const timeControl = ['bullet', 'blitz', 'rapid'].includes(message.timeControl) ? message.timeControl : 'blitz';
            const sidePref = [0, 1, 2].includes(Number(message.sidePref)) ? Number(message.sidePref) : 2;
            const isPaid = !!message.isPaid;
            const stake = isPaid ? String(message.stake || '0.01') : '0';
            const matchId = isPaid ? String(message.matchId || '') : null;
            const ephemeralPrivateKey = isPaid ? String(message.ephemeralPrivateKey || '') : null;

            if (isPaid && (!/^0x[0-9a-fA-F]{64}$/.test(matchId) || !ephemeralPrivateKey)) {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Invalid staked challenge parameters.' });
                return true;
            }

            for (const [cid, existing] of directChallenges.entries()) {
                if (existing.fromWallet === me && existing.toWallet === target) {
                    if (existing.timeoutHandle) clearTimeout(existing.timeoutHandle);
                    directChallenges.delete(cid);
                }
            }

            const challengeId = crypto.randomBytes(10).toString('hex');
            const ttlMs = isPaid ? 120000 : 60000;
            const now = Date.now();
            const ch = {
                challengeId,
                fromWallet: me,
                fromName: getDisplayName(me),
                toWallet: target,
                toName: getDisplayName(target),
                timeControl,
                sidePref: isPaid ? 0 : sidePref,
                isPaid,
                stake,
                matchId,
                ephemeralPrivateKey,
                createdAt: now,
                expiresAt: now + ttlMs,
                timeoutHandle: setTimeout(() => expireDirectChallenge(challengeId), ttlMs)
            };
            directChallenges.set(challengeId, ch);

            sendToWallet(target, {
                type: 'DIRECT_CHALLENGE_RECEIVED',
                challenge: {
                    challengeId,
                    fromWallet: me,
                    fromName: ch.fromName,
                    fromClubTag: getClubTagForWallet(me),
                    fromRatings: getRatingsObject(me),
                    timeControl,
                    sidePref: ch.sidePref,
                    isPaid,
                    stake,
                    matchId,
                    ephemeralPrivateKey,
                    expiresAt: ch.expiresAt
                }
            });

            sendSafe(ws, {
                type: 'DIRECT_CHALLENGE_SENT',
                challengeId,
                toWallet: target,
                toName: ch.toName,
                timeControl,
                isPaid,
                stake,
                matchId,
                expiresAt: ch.expiresAt
            });
            return true;
        }

        if (type === 'DIRECT_CHALLENGE_RESPOND') {
            const { challengeId, accepted } = message;
            const ch = directChallenges.get(challengeId);
            if (!ch) {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Challenge expired or already closed.' });
                return true;
            }
            if (ch.toWallet !== me) {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Not authorized to respond to this challenge.' });
                return true;
            }

            if (ch.timeoutHandle) clearTimeout(ch.timeoutHandle);
            directChallenges.delete(challengeId);

            if (!accepted) {
                sendToWallet(ch.fromWallet, {
                    type: 'DIRECT_CHALLENGE_DECLINED',
                    challengeId,
                    toWallet: me,
                    toName: getDisplayName(me),
                    isPaid: ch.isPaid,
                    matchId: ch.matchId || null
                });
                sendSafe(ws, { type: 'SOCIAL_INFO', message: `Declined challenge from ${ch.fromName}.` });
                return true;
            }

            if (ch.isPaid) {
                sendToWallet(ch.fromWallet, {
                    type: 'DIRECT_CHALLENGE_ACCEPTED',
                    challengeId,
                    matchId: ch.matchId,
                    color: 'w',
                    timeControl: ch.timeControl,
                    isPaid: true,
                    stake: ch.stake,
                    opponentWallet: me,
                    opponentName: getDisplayName(me)
                });
                sendToWallet(me, {
                    type: 'DIRECT_CHALLENGE_ACCEPTED',
                    challengeId,
                    matchId: ch.matchId,
                    color: 'b',
                    timeControl: ch.timeControl,
                    isPaid: true,
                    stake: ch.stake,
                    opponentWallet: ch.fromWallet,
                    opponentName: ch.fromName
                });
                return true;
            }

            let challengerColor = 'w';
            if (ch.sidePref === 0) challengerColor = 'w';
            else if (ch.sidePref === 1) challengerColor = 'b';
            else challengerColor = Math.random() < 0.5 ? 'w' : 'b';
            const recipientColor = challengerColor === 'w' ? 'b' : 'w';

            const newMatchId = createDirectFreeRoom({
                whiteWallet: challengerColor === 'w' ? ch.fromWallet : me,
                blackWallet: challengerColor === 'w' ? me : ch.fromWallet,
                timeControl: ch.timeControl
            });

            sendToWallet(ch.fromWallet, {
                type: 'DIRECT_CHALLENGE_ACCEPTED',
                challengeId,
                matchId: newMatchId,
                color: challengerColor,
                timeControl: ch.timeControl,
                isPaid: false,
                stake: '0',
                opponentWallet: me,
                opponentName: getDisplayName(me)
            });

            sendToWallet(me, {
                type: 'DIRECT_CHALLENGE_ACCEPTED',
                challengeId,
                matchId: newMatchId,
                color: recipientColor,
                timeControl: ch.timeControl,
                isPaid: false,
                stake: '0',
                opponentWallet: ch.fromWallet,
                opponentName: ch.fromName
            });
            return true;
        }

        if (type === 'DIRECT_CHALLENGE_CANCEL') {
            const { challengeId } = message;
            const ch = directChallenges.get(challengeId);
            if (!ch || ch.fromWallet !== me) return true;
            if (ch.timeoutHandle) clearTimeout(ch.timeoutHandle);
            directChallenges.delete(challengeId);
            sendToWallet(ch.toWallet, {
                type: 'DIRECT_CHALLENGE_EXPIRED',
                challengeId,
                fromWallet: me,
                fromName: ch.fromName
            });
            sendSafe(ws, { type: 'SOCIAL_INFO', message: 'Direct challenge cancelled.' });
            return true;
        }

        // ---------- DIRECT MESSAGES (DMs) ----------
        if (type === 'DM_SEND') {
            const target = normalizeWallet(message.targetWallet);
            const rawBody = String(message.body || '').trim();
            if (!target || target === me || !rawBody) return true;

            const perm = canSendToTarget(me, target, 'dms');
            if (!perm.allowed) {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: perm.reason });
                return true;
            }

            const lowerBody = rawBody.toLowerCase();
            if (RESTRICTED_WORDS.some(w => lowerBody.includes(w))) {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Message blocked by moderation filter.' });
                return true;
            }

            const threadId = getThreadId(me, target);
            const msgObj = {
                id: crypto.randomBytes(8).toString('hex'),
                threadId,
                sender: me,
                senderName: getDisplayName(me),
                recipient: target,
                recipientName: getDisplayName(target),
                body: rawBody.slice(0, 320),
                readAt: null,
                createdAt: Date.now()
            };

            db.directMessages.push(msgObj);

            const threadMsgs = db.directMessages.filter(m => m.threadId === threadId);
            if (threadMsgs.length > 100) {
                const oldestId = threadMsgs[0].id;
                const dropIdx = db.directMessages.findIndex(m => m.id === oldestId);
                if (dropIdx !== -1) db.directMessages.splice(dropIdx, 1);
            }
            await saveDb();

            const payload = { type: 'DM_RECEIVED', message: msgObj };
            sendToWallet(me, payload);
            sendToWallet(target, payload);
            return true;
        }

        if (type === 'DM_HISTORY') {
            const target = normalizeWallet(message.targetWallet);
            if (!target) return true;
            const threadId = getThreadId(me, target);

            let markedAny = false;
            const now = Date.now();
            const messages = [];
            for (const m of db.directMessages) {
                if (m.threadId === threadId) {
                    if (m.recipient === me && !m.readAt) {
                        m.readAt = now;
                        markedAny = true;
                    }
                    messages.push(m);
                }
            }
            if (markedAny) {
                await saveDb();
                pushSyncToWallet(me);
            }

            sendSafe(ws, {
                type: 'DM_HISTORY_DATA',
                partnerWallet: target,
                partnerName: getDisplayName(target),
                partnerPresence: computePresence(target),
                messages: messages.slice(-60)
            });
            return true;
        }

        if (type === 'DM_MARK_READ') {
            const target = normalizeWallet(message.targetWallet);
            if (!target) return true;
            const threadId = getThreadId(me, target);
            let changed = false;
            const now = Date.now();
            for (const m of db.directMessages) {
                if (m.threadId === threadId && m.recipient === me && !m.readAt) {
                    m.readAt = now;
                    changed = true;
                }
            }
            if (changed) {
                await saveDb();
                pushSyncToWallet(me);
            }
            return true;
        }

        // ---------- CLUBS / GUILDS ----------
        if (type === 'CLUB_CREATE') {
            const name = String(message.name || '').trim().slice(0, 28);
            const rawTag = String(message.tag || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
            const description = String(message.description || '').trim().slice(0, 140);

            if (name.length < 3 || rawTag.length < 2) {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Club name (min 3 chars) and tag (2–6 alphanumeric chars) required.' });
                return true;
            }
            if (RESTRICTED_WORDS.some(w => name.toLowerCase().includes(w) || description.toLowerCase().includes(w))) {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Club name or description blocked by moderation.' });
                return true;
            }

            const clubId = rawTag.toLowerCase() + '-' + crypto.randomBytes(3).toString('hex');
            if (Object.values(db.clubs).some(c => c.tag.toUpperCase() === rawTag)) {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: `Club tag [${rawTag}] is already taken.` });
                return true;
            }

            const u = ensureSocialUser(me);
            if (u.clubId && db.clubs[u.clubId]) {
                db.clubs[u.clubId].members = db.clubs[u.clubId].members.filter(m => m !== me);
            }

            db.clubs[clubId] = {
                id: clubId,
                name,
                tag: rawTag,
                description,
                owner: me,
                members: [me],
                messages: [],
                createdAt: Date.now()
            };
            u.clubId = clubId;
            await saveDb();

            emitActivityEvent(me, 'club', `founded club [${rawTag}] ${name}`, { clubId });
            sendSafe(ws, { type: 'CLUB_DETAILS_DATA', club: buildClubSummary(db.clubs[clubId], true) });
            pushSyncToWallet(me);
            notifyPresenceChange(me);
            return true;
        }

        if (type === 'CLUB_JOIN') {
            const clubId = String(message.clubId || '').trim().toLowerCase();
            const club = db.clubs[clubId];
            if (!club) {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Club not found.' });
                return true;
            }
            const u = ensureSocialUser(me);
            if (u.clubId && u.clubId !== clubId && db.clubs[u.clubId]) {
                db.clubs[u.clubId].members = db.clubs[u.clubId].members.filter(m => m !== me);
            }
            if (!club.members.includes(me)) {
                club.members.push(me);
            }
            u.clubId = clubId;
            await saveDb();

            emitActivityEvent(me, 'club', `joined club [${club.tag}] ${club.name}`, { clubId });
            sendSafe(ws, { type: 'CLUB_DETAILS_DATA', club: buildClubSummary(club, true) });
            pushSyncToWallet(me);
            notifyPresenceChange(me);
            return true;
        }

        if (type === 'CLUB_LEAVE') {
            const u = ensureSocialUser(me);
            if (!u.clubId || !db.clubs[u.clubId]) return true;
            const club = db.clubs[u.clubId];
            club.members = club.members.filter(m => m !== me);
            if (club.members.length === 0) {
                delete db.clubs[u.clubId];
            } else if (club.owner === me) {
                club.owner = club.members[0];
            }
            u.clubId = null;
            await saveDb();
            sendSafe(ws, { type: 'SOCIAL_INFO', message: `Left club [${club.tag}].` });
            pushSyncToWallet(me);
            notifyPresenceChange(me);
            return true;
        }

        if (type === 'CLUB_CHAT_SEND') {
            const u = ensureSocialUser(me);
            if (!u.clubId || !db.clubs[u.clubId]) {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Join a club to chat in club comms.' });
                return true;
            }
            const body = String(message.body || '').trim().slice(0, 260);
            if (!body) return true;
            if (RESTRICTED_WORDS.some(w => body.toLowerCase().includes(w))) {
                sendSafe(ws, { type: 'SOCIAL_ERROR', reason: 'Club message blocked by moderation.' });
                return true;
            }
            const club = db.clubs[u.clubId];
            const msg = {
                id: crypto.randomBytes(6).toString('hex'),
                clubId: club.id,
                sender: me,
                senderName: getDisplayName(me),
                body,
                createdAt: Date.now()
            };
            club.messages = club.messages || [];
            club.messages.push(msg);
            if (club.messages.length > 60) club.messages.shift();
            await saveDb();

            for (const memberWallet of club.members) {
                sendToWallet(memberWallet, { type: 'CLUB_CHAT_MESSAGE', message: msg });
            }
            return true;
        }

        return false;
    }

    return {
        onConnect,
        onDisconnect,
        handleMessage,
        notifyPresenceChange,
        recordMatchCompleted,
        emitActivityEvent,
        getDisplayName,
        computePresence
    };
}

module.exports = { createSocialServer };