/**
 * ============================================================================
 * LITCHESS SOCIAL, PRESENCE, DMs, CLUBS & DIRECT CHALLENGE CLIENT ENGINE
 * File: public/social.js (Loaded immediately after public/app.js)
 * ============================================================================
 */

(function () {
    'use strict';

    const state = {
        socket: null,
        nonce: null,
        authedWallet: null,
        isAuthing: false,
        authRetryTimer: null,
        me: null,
        friends: [],
        following: [],
        incomingRequests: [],
        outgoingRequests: [],
        blocked: [],
        dmThreads: [],
        unreadDmTotal: 0,
        incomingChallenges: [],
        myClub: null,
        clubsList: [],
        activityFeed: [],
        leaderboard: [],
        activeTab: 'friends',
        activeDmPartner: null,
        activeProfile: null,
        dcTarget: null,
        activeIncomingChallenge: null,
        activeOutgoingChallenge: null,
        challengeCountdownTimer: null,
        presenceIdleTimer: null,
        isAway: false,
        searchTimers: { home: null, arena: null }
    };

    const AWAY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes idle -> Away

    // =========================================================================
    // 1. HELPERS (Copy-paste-safe HTML escaping & Time Control formatting)
    // =========================================================================
    function esc(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '\x26amp;')
            .replace(/</g, '\x26lt;')
            .replace(/>/g, '\x26gt;')
            .replace(/"/g, '\x26quot;')
            .replace(/'/g, '\x26#39;');
    }

    function shortWallet(w) {
        if (!w || w.length < 12) return w || '';
        return w.slice(0, 6) + '...' + w.slice(-4);
    }

    function formatTimeControlLabel(tc) {
        const key = String(tc || 'blitz').toLowerCase();
        if (key === 'bullet') return '1+0 BULLET';
        if (key === 'blitz3_2') return '3+2 BLITZ';
        if (key === 'blitz5') return '5+0 BLITZ';
        if (key === 'rapid') return '10+0 RAPID';
        return '3+0 BLITZ';
    }

    function timeAgo(ts) {
        if (!ts) return 'Offline';
        const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        if (diff < 60) return 'just now';
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        return `${Math.floor(diff / 86400)}d ago`;
    }

    function presenceDotHtml(presence) {
        const s = presence && presence.status ? presence.status : 'offline';
        if (s === 'in_match') return '<span class="p-dot p-match" title="In Match — Click to Spectate">⚔️</span>';
        if (s === 'online') return '<span class="p-dot p-online" title="Online">●</span>';
        if (s === 'away') return '<span class="p-dot p-away" title="Away">●</span>';
        return '<span class="p-dot p-offline" title="Offline">●</span>';
    }

    function presenceLabel(presence) {
        const s = presence && presence.status ? presence.status : 'offline';
        if (s === 'in_match') return `Playing ${formatTimeControlLabel(presence.timeControl)}${presence.isPaid ? ' (zkLTC)' : ''}`;
        if (s === 'online') return 'Online (Lobby)';
        if (s === 'away') return 'Away';
        return presence && presence.lastSeen ? `Last seen ${timeAgo(presence.lastSeen)}` : 'Offline';
    }

    function clubTagHtml(tag) {
        return tag ? `<span class="club-tag-pill">[${esc(tag)}]</span>` : '';
    }

    function getBridge() {
        return window.LitChessBridge || {};
    }

    function getSocket() {
        const ctx = getBridge().getContext ? getBridge().getContext() : {};
        const sock = state.socket || ctx.lobbySocket;
        if (sock && sock.readyState === WebSocket.OPEN) return sock;
        return null;
    }

    function sendSocial(payload) {
        const sock = getSocket();
        if (!sock) {
            if (typeof window.connectLobbyTelemetrySocket === 'function') {
                window.connectLobbyTelemetrySocket();
            }
            setTimeout(() => {
                const retrySock = getSocket();
                if (retrySock) retrySock.send(JSON.stringify(payload));
            }, 450);
            return false;
        }
        sock.send(JSON.stringify(payload));
        return true;
    }

    function notifyToast(msg, type = 'info', ms = 4000) {
        if (typeof window.showToast === 'function') window.showToast(msg, type, ms);
    }

    function playNotifSound() {
        if (window.EventBus && typeof window.EventBus.emit === 'function') {
            window.EventBus.emit('notification');
        }
    }

    // =========================================================================
    // 2. ZERO-POPUP SOCIAL AUTHENTICATION (RACE-FREE ON F5 REFRESH) & PRESENCE
    // =========================================================================
    function scheduleAuthRetry(delayMs = 700) {
        if (state.authRetryTimer) clearTimeout(state.authRetryTimer);
        state.authRetryTimer = setTimeout(() => {
            state.authRetryTimer = null;
            attemptSocialAuth();
        }, delayMs);
    }

    async function attemptSocialAuth() {
        if (state.isAuthing) return;
        const ctx = getBridge().getContext ? getBridge().getContext() : {};
        const wallet = ctx.wallet ? ctx.wallet.toLowerCase() : null;
        if (!wallet) return;

        const sock = getSocket();
        if (!sock) {
            if (typeof window.connectLobbyTelemetrySocket === 'function') {
                window.connectLobbyTelemetrySocket();
            }
            scheduleAuthRetry(800);
            return;
        }

        if (state.authedWallet === wallet) return;

        // If socket is open but we missed SOCIAL_HELLO (or nonce was spent), wait briefly then reconnect
        if (!state.nonce) {
            scheduleAuthRetry(600);
            return;
        }

        state.isAuthing = true;
        const nonceToSign = state.nonce;
        try {
            const expectedMsg = `LITCHESS_SOCIAL_${wallet}_${nonceToSign}`;
            let delegateBundle = typeof window.getCachedDelegatedSession === 'function'
                ? window.getCachedDelegatedSession(wallet)
                : null;

            if (!delegateBundle && ctx.signer && typeof window.getOrCreateDelegatedSession === 'function') {
                delegateBundle = await window.getOrCreateDelegatedSession(wallet, ctx.signer);
            }

            const activeSock = getSocket();
            if (!activeSock) {
                scheduleAuthRetry(800);
                return;
            }

            if (delegateBundle && delegateBundle.delegateWallet) {
                const signature = await delegateBundle.delegateWallet.signMessage(expectedMsg);
                activeSock.send(JSON.stringify({
                    type: 'AUTH_SOCIAL',
                    wallet,
                    signature,
                    delegateAddress: delegateBundle.delegateAddress,
                    delegateSignature: delegateBundle.delegateSignature
                }));
            } else if (ctx.signer) {
                const signature = await ctx.signer.signMessage(expectedMsg);
                activeSock.send(JSON.stringify({
                    type: 'AUTH_SOCIAL',
                    wallet,
                    signature
                }));
            }
        } catch (err) {
            console.warn('[SOCIAL] Auth skipped or cancelled:', err.message);
        } finally {
            state.isAuthing = false;
        }
    }

    function resetPresenceIdleTimer() {
        if (state.presenceIdleTimer) clearTimeout(state.presenceIdleTimer);
        if (state.isAway && !document.hidden) {
            state.isAway = false;
            if (state.authedWallet) sendSocial({ type: 'PRESENCE_SET', status: 'online' });
        }
        state.presenceIdleTimer = setTimeout(() => {
            if (!state.isAway && state.authedWallet) {
                state.isAway = true;
                sendSocial({ type: 'PRESENCE_SET', status: 'away' });
            }
        }, AWAY_TIMEOUT_MS);
    }

    function setupPresenceTrackers() {
        document.addEventListener('visibilitychange', () => {
            if (!state.authedWallet) return;
            if (document.hidden) {
                state.isAway = true;
                sendSocial({ type: 'PRESENCE_SET', status: 'away' });
            } else {
                state.isAway = false;
                sendSocial({ type: 'PRESENCE_SET', status: 'online' });
                resetPresenceIdleTimer();
            }
        });
        ['mousemove', 'keydown', 'click', 'touchstart'].forEach(evt => {
            window.addEventListener(evt, resetPresenceIdleTimer, { passive: true });
        });
        resetPresenceIdleTimer();
    }

    // =========================================================================
    // 3. BADGES & NOTIFICATION BELL
    // =========================================================================
    function updateNotificationBadges() {
        const reqCount = state.incomingRequests.length;
        const dmCount = state.unreadDmTotal || 0;
        const chCount = state.activeIncomingChallenge ? 1 : 0;
        const total = reqCount + dmCount + chCount;

        $('#badge-tab-requests').text(reqCount).toggleClass('hidden-element', reqCount === 0);
        $('#badge-tab-dms').text(dmCount).toggleClass('hidden-element', dmCount === 0);
        $('#social-bell-badge-home').text(total).toggleClass('hidden-element', total === 0);

        renderHomePopover();
    }

    function renderHomePopover() {
        const box = $('#home-social-popover');
        if (box.hasClass('hidden-element')) return;
        box.empty();

        if (!state.authedWallet) {
            box.html('<div class="popover-title">Social Hub</div><div class="social-empty-state">Connect your wallet to see friend requests, DMs, and live invites.</div>');
            return;
        }

        let html = '<div class="popover-title">Live Notifications</div>';
        let hasItems = false;

        if (state.incomingRequests.length > 0) {
            hasItems = true;
            state.incomingRequests.forEach(r => {
                html += `
                    <div class="social-row">
                        <div class="social-row-info" data-open-profile="${esc(r.wallet)}">
                            <div class="social-row-title">${presenceDotHtml(r.presence)} ${esc(r.username)}</div>
                            <div class="social-row-sub">Sent you a friend request</div>
                        </div>
                        <div class="social-row-actions">
                            <button class="btn-icon-xs btn-icon-accept" data-req-accept="${esc(r.id)}">✓</button>
                            <button class="btn-icon-xs btn-icon-decline" data-req-decline="${esc(r.id)}">✕</button>
                        </div>
                    </div>`;
            });
        }

        const unreadThreads = state.dmThreads.filter(t => t.unread > 0);
        if (unreadThreads.length > 0) {
            hasItems = true;
            unreadThreads.forEach(t => {
                html += `
                    <div class="social-row" data-home-open-dm="${esc(t.wallet)}">
                        <div class="social-row-info">
                            <div class="social-row-title">💬 ${esc(t.username)} <span class="tab-badge">${t.unread}</span></div>
                            <div class="social-row-sub">${esc(t.lastMessage)}</div>
                        </div>
                    </div>`;
            });
        }

        if (!hasItems) {
            html += '<div class="social-empty-state">All caught up! No unread notifications.</div>';
        }

        box.html(html);
    }

    // =========================================================================
    // 4. RENDERING: FRIENDS, FOLLOWING, REQUESTS, DMs, CLUBS, FEED, LEADERBOARD
    // =========================================================================
    function renderFriendsAndFollowing() {
        const fList = $('#friends-list').empty();
        const onlineCount = state.friends.filter(f => f.presence && f.presence.status !== 'offline').length;
        $('#friends-online-count').text(`${onlineCount} / ${state.friends.length} online`);

        if (!state.authedWallet) {
            fList.html('<div class="social-empty-state">Connect wallet to sync friends & live presence.</div>');
        } else if (state.friends.length === 0) {
            fList.html('<div class="social-empty-state">No friends yet. Use the search bar above to find players!</div>');
        } else {
            state.friends.forEach(f => {
                const isPlaying = f.presence && f.presence.status === 'in_match' && f.presence.activeMatchId;
                const isAvailable = f.presence && (f.presence.status === 'online' || f.presence.status === 'away');
                const dmBadge = f.unreadDms > 0 ? `<span class="tab-badge">${f.unreadDms}</span>` : '';

                fList.append(`
                    <div class="social-row">
                        <div class="social-row-info" data-open-profile="${esc(f.wallet)}">
                            <div class="social-row-title">
                                ${presenceDotHtml(f.presence)}
                                <span>${esc(f.username)}</span>
                                ${clubTagHtml(f.clubTag)}
                            </div>
                            <div class="social-row-sub">${esc(presenceLabel(f.presence))} • ${f.ratings.blitz || 2000}</div>
                        </div>
                        <div class="social-row-actions">
                            ${isPlaying ? `<button class="btn-icon-xs btn-icon-spectate" data-spectate="${esc(f.presence.activeMatchId)}" title="Spectate Match">👁️</button>` : ''}
                            ${isAvailable ? `<button class="btn-icon-xs" data-challenge-wallet="${esc(f.wallet)}" data-challenge-name="${esc(f.username)}" title="Challenge">⚔️</button>` : ''}
                            <button class="btn-icon-xs" data-open-dm="${esc(f.wallet)}" data-open-dm-name="${esc(f.username)}" title="Direct Message">💬${dmBadge}</button>
                        </div>
                    </div>
                `);
            });
        }

        const folList = $('#following-list').empty();
        $('#following-count').text(state.following.length);
        if (state.following.length === 0) {
            folList.html('<div class="social-empty-state">Follow top players to track & spectate them.</div>');
        } else {
            state.following.forEach(u => {
                const isPlaying = u.presence && u.presence.status === 'in_match' && u.presence.activeMatchId;
                folList.append(`
                    <div class="social-row">
                        <div class="social-row-info" data-open-profile="${esc(u.wallet)}">
                            <div class="social-row-title">
                                ${presenceDotHtml(u.presence)}
                                <span>${esc(u.username)}</span>
                                ${clubTagHtml(u.clubTag)}
                            </div>
                            <div class="social-row-sub">${esc(presenceLabel(u.presence))} • ${u.ratings.blitz || 2000}</div>
                        </div>
                        <div class="social-row-actions">
                            ${isPlaying ? `<button class="btn-icon-xs btn-icon-spectate" data-spectate="${esc(u.presence.activeMatchId)}" title="Spectate">👁️</button>` : ''}
                            <button class="btn-icon-xs" data-follow-toggle="${esc(u.wallet)}" title="Unfollow">★</button>
                        </div>
                    </div>
                `);
            });
        }
    }

    function renderRequestsAndBlocked() {
        const inc = $('#incoming-requests-list').empty();
        if (state.incomingRequests.length === 0) {
            inc.html('<div class="social-empty-state">No incoming friend requests.</div>');
        } else {
            state.incomingRequests.forEach(r => {
                inc.append(`
                    <div class="social-row">
                        <div class="social-row-info" data-open-profile="${esc(r.wallet)}">
                            <div class="social-row-title">${presenceDotHtml(r.presence)} ${esc(r.username)} ${clubTagHtml(r.clubTag)}</div>
                            <div class="social-row-sub">Blitz ${r.ratings.blitz || 2000} • ${timeAgo(r.createdAt)}</div>
                        </div>
                        <div class="social-row-actions">
                            <button class="btn-icon-xs btn-icon-accept" data-req-accept="${esc(r.id)}" title="Accept">✓</button>
                            <button class="btn-icon-xs btn-icon-decline" data-req-decline="${esc(r.id)}" title="Decline">✕</button>
                        </div>
                    </div>
                `);
            });
        }

        const out = $('#outgoing-requests-list').empty();
        if (state.outgoingRequests.length === 0) {
            out.html('<div class="social-empty-state">No sent requests.</div>');
        } else {
            state.outgoingRequests.forEach(r => {
                out.append(`
                    <div class="social-row">
                        <div class="social-row-info" data-open-profile="${esc(r.wallet)}">
                            <div class="social-row-title">${presenceDotHtml(r.presence)} ${esc(r.username)}</div>
                            <div class="social-row-sub">Pending • ${timeAgo(r.createdAt)}</div>
                        </div>
                        <div class="social-row-actions">
                            <button class="btn-icon-xs btn-icon-decline" data-req-cancel="${esc(r.id)}" title="Cancel Request">Cancel</button>
                        </div>
                    </div>
                `);
            });
        }

        const blk = $('#blocked-users-list').empty();
        if (state.blocked.length === 0) {
            blk.html('<div class="social-empty-state">No blocked users.</div>');
        } else {
            state.blocked.forEach(b => {
                blk.append(`
                    <div class="social-row">
                        <div class="social-row-info">
                            <div class="social-row-title">🚫 ${esc(b.username)}</div>
                        </div>
                        <div class="social-row-actions">
                            <button class="btn-icon-xs" data-unblock-wallet="${esc(b.wallet)}">Unblock</button>
                        </div>
                    </div>
                `);
            });
        }
    }

    function renderDmThreads() {
        const list = $('#dm-threads-list').empty();
        if (!state.authedWallet) {
            list.html('<div class="social-empty-state">Connect wallet to access Direct Messages.</div>');
            return;
        }
        if (state.dmThreads.length === 0) {
            list.html('<div class="social-empty-state">No DM conversations yet. Click 💬 next to a friend.</div>');
            return;
        }
        state.dmThreads.forEach(t => {
            list.append(`
                <div class="social-row" style="cursor:pointer;" data-open-dm="${esc(t.wallet)}" data-open-dm-name="${esc(t.username)}">
                    <div class="social-row-info">
                        <div class="social-row-title">
                            ${presenceDotHtml(t.presence)}
                            <span>${esc(t.username)}</span>
                            ${t.unread > 0 ? `<span class="tab-badge">${t.unread}</span>` : ''}
                        </div>
                        <div class="social-row-sub">${esc(t.lastMessage)}</div>
                    </div>
                    <small class="muted-counter">${timeAgo(t.lastTimestamp)}</small>
                </div>
            `);
        });
    }

    function openDmConversation(partnerWallet, partnerName) {
        if (!state.authedWallet) {
            notifyToast('Connect your wallet to send Direct Messages.', 'warn');
            return;
        }
        switchSocialTab('dms');
        state.activeDmPartner = { wallet: partnerWallet.toLowerCase(), username: partnerName || shortWallet(partnerWallet) };
        $('#dm-threads-view').addClass('hidden-element');
        $('#dm-chat-view').removeClass('hidden-element');
        $('#dm-chat-partner-name').text(state.activeDmPartner.username);
        $('#dm-chat-partner-status').text('Loading...');
        $('#dm-chat-messages').html('<div class="social-empty-state">Loading history...</div>');
        sendSocial({ type: 'DM_HISTORY', targetWallet: partnerWallet });
    }

    function renderDmHistory(data) {
        if (!state.activeDmPartner || state.activeDmPartner.wallet !== data.partnerWallet) return;
        $('#dm-chat-partner-name').text(data.partnerName);
        $('#dm-chat-partner-status').text(presenceLabel(data.partnerPresence));
        const box = $('#dm-chat-messages').empty();
        if (!data.messages || data.messages.length === 0) {
            box.html('<div class="social-empty-state">Start the conversation!</div>');
        } else {
            data.messages.forEach(appendDmBubble);
        }
        if (box[0]) box.scrollTop(box[0].scrollHeight);
    }

    function appendDmBubble(msg) {
        const box = $('#dm-chat-messages');
        box.find('.social-empty-state').remove();
        const isMine = msg.sender === state.authedWallet;
        box.append(`
            <div class="dm-bubble ${isMine ? 'mine' : 'theirs'}">
                <div>${esc(msg.body)}</div>
                <span class="dm-bubble-time">${timeAgo(msg.createdAt)}</span>
            </div>
        `);
        if (box[0]) box.scrollTop(box[0].scrollHeight);
    }

    function renderClubsView() {
        const myBox = $('#club-my-view');
        const browseBox = $('#club-browse-view');

        if (state.myClub) {
            const c = state.myClub;
            const membersHtml = (c.members || []).slice(0, 8).map((m, idx) => `
                <div class="social-row" style="padding:4px 3px;">
                    <div class="social-row-info" data-open-profile="${esc(m.wallet)}">
                        <div class="social-row-title" style="font-size:11px;">
                            #${idx + 1} ${presenceDotHtml(m.presence)} ${esc(m.username)} ${m.isOwner ? '👑' : ''}
                        </div>
                    </div>
                    <span class="friend-elo">${m.blitz}</span>
                </div>
            `).join('');

            const msgsHtml = (c.messages || []).length > 0
                ? c.messages.map(m => `<div><strong style="color:#93c5fd;">${esc(m.senderName)}:</strong> ${esc(m.body)}</div>`).join('')
                : '<div class="social-empty-state" style="padding:4px;">Club chat is quiet. Say hello!</div>';

            myBox.removeClass('hidden-element').html(`
                <div class="club-card">
                    <div class="club-card-head">
                        <div>
                            <span class="club-tag-pill">[${esc(c.tag)}]</span>
                            <strong style="font-size:12.5px; color:#fff; margin-left:4px;">${esc(c.name)}</strong>
                        </div>
                        <button id="btn-club-leave" class="btn-icon-xs btn-icon-decline" title="Leave Club">Leave</button>
                    </div>
                    <div class="club-card-desc">${esc(c.description || 'Competitive LitChess Guild')} • Avg Blitz ${c.avgBlitz}</div>
                    <button id="btn-club-enter-arena" data-tourney-id="${esc(c.tourneyId)}" class="btn-cta-launch" style="padding:7px; font-size:11px; margin-bottom:8px;">
                        🏆 Enter [${esc(c.tag)}] Club Arena
                    </button>
                    <div class="social-subhead"><span>Club Chat</span></div>
                    <div id="club-chat-scroll" class="club-chat-box">${msgsHtml}</div>
                    <div class="dm-input-row" style="margin-bottom:8px;">
                        <input type="text" id="club-chat-input" placeholder="Message club..." maxlength="260">
                        <button id="btn-club-chat-send">Send</button>
                    </div>
                    <div class="social-subhead"><span>Roster (${c.memberCount})</span></div>
                    <div>${membersHtml}</div>
                </div>
            `);
            const sc = $('#club-chat-scroll');
            if (sc[0]) sc.scrollTop(sc[0].scrollHeight);
            browseBox.addClass('hidden-element');
            return;
        }

        myBox.addClass('hidden-element').empty();
        browseBox.removeClass('hidden-element').empty();

        if (!state.clubsList || state.clubsList.length === 0) {
            browseBox.html('<div class="social-empty-state">No clubs created yet. Click "+ Create" to found the first guild!</div>');
            return;
        }

        state.clubsList.forEach(c => {
            browseBox.append(`
                <div class="club-card">
                    <div class="club-card-head">
                        <div>
                            <span class="club-tag-pill">[${esc(c.tag)}]</span>
                            <strong style="font-size:12px; color:#fff; margin-left:4px;">${esc(c.name)}</strong>
                        </div>
                        <button class="btn-mini-accent" data-join-club="${esc(c.id)}">Join</button>
                    </div>
                    <div class="club-card-desc">${esc(c.description || 'Open Chess Guild')}</div>
                    <small class="muted-counter">👥 ${c.memberCount} members • Avg Blitz ${c.avgBlitz}</small>
                </div>
            `);
        });
    }

    function renderActivityFeed() {
        const list = $('#activity-feed-list').empty();
        if (!state.activityFeed || state.activityFeed.length === 0) {
            list.html('<div class="social-empty-state">No recent activity yet. Play a rated match to appear here!</div>');
            return;
        }
        state.activityFeed.forEach(ev => {
            list.append(`
                <div class="activity-item">
                    <span class="activity-actor" data-open-profile="${esc(ev.actor)}">${esc(ev.actorName)}</span>
                    ${clubTagHtml(ev.actorClubTag)}
                    ${esc(ev.text)}
                    <span class="activity-time">${timeAgo(ev.createdAt)}</span>
                </div>
            `);
        });
    }

    function renderLeaderboard(players) {
        const list = $('#leaderboard-list').empty();
        if (!players || players.length === 0) {
            list.html('<div class="social-empty-state">No ranked players yet.</div>');
            return;
        }
        players.forEach((p, idx) => {
            const medal = idx === 0 ? '🥇' : (idx === 1 ? '🥈' : (idx === 2 ? '🥉' : `#${idx + 1}`));
            list.append(`
                <div class="social-row">
                    <div class="social-row-info" data-open-profile="${esc(p.wallet)}">
                        <div class="social-row-title">
                            <span>${medal}</span>
                            ${presenceDotHtml(p.presence)}
                            <span>${esc(p.username)}</span>
                            ${clubTagHtml(p.clubTag)}
                        </div>
                        <div class="social-row-sub">${p.ratings.gamesPlayed || 0} games • ${p.ratings.wins || 0}W</div>
                    </div>
                    <span class="friend-elo">${p.rating}</span>
                </div>
            `);
        });
    }

    // =========================================================================
    // 5. DEBOUNCED MULTI-RESULT SEARCH AUTOCOMPLETE
    // =========================================================================
    function triggerFuzzySearch(query, target) {
        const dropdown = target === 'home' ? $('#search-dropdown-home') : $('#search-dropdown-arena');
        const trimmed = String(query || '').trim();
        if (!trimmed) {
            dropdown.addClass('hidden-element').empty();
            return;
        }
        state._lastSearchTarget = target;
        sendSocial({ type: 'SEARCH_USERS', query: trimmed, limit: 8 });
    }

    function renderSearchDropdown(data) {
        const targets = state._lastSearchTarget === 'home'
            ? [$('#search-dropdown-home')]
            : [$('#search-dropdown-arena')];

        targets.forEach($dd => {
            $dd.empty().removeClass('hidden-element');
            if (!data.results || data.results.length === 0) {
                $dd.html(`<div class="social-empty-state">No players found matching "${esc(data.query)}".</div>`);
                return;
            }
            data.results.forEach(p => {
                const isSelf = p.relationship === 'self';
                const isFriend = p.relationship === 'friends';
                const isPending = p.relationship === 'outgoing_request' || p.relationship === 'incoming_request';
                const isPlaying = p.presence && p.presence.status === 'in_match' && p.presence.activeMatchId;

                let friendBtn = '';
                if (!isSelf && !isFriend && !isPending && p.relationship !== 'blocked_by_me' && p.relationship !== 'blocked_by_them') {
                    friendBtn = `<button class="btn-icon-xs btn-icon-accept" data-send-freq="${esc(p.wallet)}" title="Send Friend Request">+ Friend</button>`;
                } else if (isFriend) {
                    friendBtn = `<span class="club-tag-pill" style="color:#34d399; border-color:#10b981;">Friend</span>`;
                } else if (isPending) {
                    friendBtn = `<span class="club-tag-pill">Pending</span>`;
                }

                $dd.append(`
                    <div class="search-result-row" data-open-profile="${esc(p.wallet)}">
                        <div class="search-res-main">
                            <div class="search-res-name">
                                ${presenceDotHtml(p.presence)}
                                <span>${esc(p.username)}</span>
                                ${clubTagHtml(p.clubTag)}
                            </div>
                            <div class="search-res-meta">⚡${p.ratings.bullet} • 🔥${p.ratings.blitz} • ⏱️${p.ratings.rapid}</div>
                        </div>
                        <div class="search-res-btns" onclick="event.stopPropagation();">
                            ${isPlaying ? `<button class="btn-icon-xs btn-icon-spectate" data-spectate="${esc(p.presence.activeMatchId)}" title="Spectate">👁️</button>` : ''}
                            ${friendBtn}
                        </div>
                    </div>
                `);
            });
        });
    }

    // =========================================================================
    // 6. PLAYER PROFILE DOSSIER MODAL
    // =========================================================================
    function openPlayerProfile(walletOrUsername, isUsername = false) {
        if (!walletOrUsername) return;
        $('#search-dropdown-home, #search-dropdown-arena, #home-social-popover').addClass('hidden-element');
        if (isUsername) {
            sendSocial({ type: 'GET_PROFILE', username: walletOrUsername });
        } else {
            sendSocial({ type: 'GET_PROFILE', wallet: walletOrUsername });
        }
    }

    function renderProfileModal(p) {
        state.activeProfile = p;
        $('#prof-presence-dot').html(presenceDotHtml(p.presence));
        $('#prof-username').text(p.username);
        $('#prof-presence-label').text(presenceLabel(p.presence));
        $('#prof-wallet-short').text(shortWallet(p.wallet));

        if (p.club && p.club.tag) {
            $('#prof-club-badge').text(`[${p.club.tag}] ${p.club.name}`).removeClass('hidden-element');
        } else {
            $('#prof-club-badge').addClass('hidden-element');
        }

        if (p.h2h && p.h2h.isRival) {
            $('#prof-rival-badge').removeClass('hidden-element');
        } else {
            $('#prof-rival-badge').addClass('hidden-element');
        }

        $('#prof-elo-bullet').text(p.ratings.bullet || 2000);
        $('#prof-elo-blitz').text(p.ratings.blitz || 2000);
        $('#prof-elo-rapid').text(p.ratings.rapid || 2000);
        $('#prof-zkl-won').text(p.totalZkLtcWon || 0);

        const w = p.ratings.wins || 0;
        const d = p.ratings.draws || 0;
        const l = p.ratings.losses || 0;
        const total = w + d + l;
        $('#prof-wdl-text').text(`${w}W • ${d}D • ${l}L (${total} games)`);

        if (p.currentStreak >= 2) {
            $('#prof-streak-text').text(`🔥 ${p.currentStreak} Win Streak (Best: ${p.bestStreak})`);
        } else if (p.bestStreak >= 2) {
            $('#prof-streak-text').text(`Best Streak: ${p.bestStreak}`);
        } else {
            $('#prof-streak-text').text(`${p.friendCount || 0} Friends • ${p.followerCount || 0} Followers`);
        }

        if (total > 0) {
            $('#wdl-bar-w').css('width', `${(w / total) * 100}%`);
            $('#wdl-bar-d').css('width', `${(d / total) * 100}%`);
            $('#wdl-bar-l').css('width', `${(l / total) * 100}%`);
        } else {
            $('#wdl-bar-w').css('width', '0%');
            $('#wdl-bar-d').css('width', '100%');
            $('#wdl-bar-l').css('width', '0%');
        }

        const formWrap = $('#prof-form-pills').empty();
        if (p.recentForm && p.recentForm.length > 0) {
            p.recentForm.forEach(res => formWrap.append(`<span class="form-pill ${res}">${res}</span>`));
        } else {
            formWrap.html('<small style="color:#64748b;">No rated games yet</small>');
        }

        if (p.h2h && p.h2h.total > 0) {
            $('#prof-h2h-box').removeClass('hidden-element');
            $('#prof-h2h-title').text(p.h2h.isRival ? '⚔️ Rivalry Series vs You' : 'Head-to-Head vs You');
            $('#prof-h2h-score').text(`${p.h2h.myWins}W – ${p.h2h.draws}D – ${p.h2h.theirWins}L (${p.h2h.total} games)`);
        } else {
            $('#prof-h2h-box').addClass('hidden-element');
        }

        const actionBar = $('#prof-action-bar').empty();
        const isSelf = p.relationship === 'self';
        if (!isSelf) {
            const isPlaying = p.presence && p.presence.status === 'in_match' && p.presence.activeMatchId;
            if (isPlaying) {
                actionBar.append(`<button class="btn-spectate-sm" data-spectate="${esc(p.presence.activeMatchId)}">👁️ Spectate Live</button>`);
            } else if (p.presence && p.presence.status !== 'offline') {
                actionBar.append(`<button class="btn-cta-launch" style="padding:7px 11px;" data-challenge-wallet="${esc(p.wallet)}" data-challenge-name="${esc(p.username)}">⚔️ Challenge</button>`);
            }

            if (p.relationship === 'friends') {
                actionBar.append(`<button class="btn-secondary" data-unfriend-wallet="${esc(p.wallet)}">✓ Friends (Remove)</button>`);
            } else if (p.relationship === 'outgoing_request') {
                actionBar.append(`<button class="btn-secondary" disabled>⏳ Request Sent</button>`);
            } else if (p.relationship === 'incoming_request') {
                const req = state.incomingRequests.find(r => r.wallet === p.wallet);
                if (req) {
                    actionBar.append(`<button class="btn-friend-add" data-req-accept="${esc(req.id)}">✓ Accept Request</button>`);
                }
            } else if (p.relationship === 'none') {
                actionBar.append(`<button class="btn-friend-add" data-send-freq="${esc(p.wallet)}">+ Add Friend</button>`);
            }

            actionBar.append(`<button class="btn-secondary" data-follow-toggle="${esc(p.wallet)}">${p.isFollowing ? '★ Following' : '☆ Follow'}</button>`);
            actionBar.append(`<button class="btn-secondary" data-open-dm="${esc(p.wallet)}" data-open-dm-name="${esc(p.username)}">💬 Message</button>`);

            $('#prof-note-section, #prof-safety-bar').removeClass('hidden-element');
            $('#prof-note-input').val(p.note || '');
            $('#btn-prof-block')
                .text(p.relationship === 'blocked_by_me' ? '🔓 Unblock User' : '🚫 Block User')
                .data('blocked', p.relationship === 'blocked_by_me');
        } else {
            actionBar.html('<span style="font-size:12px; color:#93c5fd;">This is your institutional player dossier.</span>');
            $('#prof-note-section, #prof-safety-bar').addClass('hidden-element');
        }

        const gamesBox = $('#prof-recent-games').empty();
        if (!p.recentGames || p.recentGames.length === 0) {
            gamesBox.html('<div class="social-empty-state">No recorded matches yet.</div>');
        } else {
            p.recentGames.forEach((g, idx) => {
                const stakeTag = g.isPaid && g.wagerEth > 0 ? ` • ${g.wagerEth} zkLTC` : '';
                gamesBox.append(`
                    <div class="prof-game-row">
                        <div>
                            <span class="form-pill ${g.result}" style="margin-right:5px;">${g.result}</span>
                            <strong>${esc(g.whiteName)}</strong> vs <strong>${esc(g.blackName)}</strong>
                            <div style="font-size:10px; color:#64748b; margin-top:2px;">
                                ${esc(formatTimeControlLabel(g.timeControl))}${stakeTag} • ${esc(g.reason.replace(/_/g, ' '))} • ${timeAgo(g.timestamp)}
                            </div>
                        </div>
                        ${g.pgn ? `<button class="btn-icon-xs" data-analyze-game-idx="${idx}" title="Open in Analysis Board">🔍 Analyze</button>` : ''}
                    </div>
                `);
            });
        }

        $('#player-profile-modal').removeClass('hidden-element');
    }

    // =========================================================================
    // 7. 1-CLICK DIRECT CHALLENGES (FREE & WAGERED ZKLTC OVER WEBSOCKET)
    // =========================================================================
    function openDirectChallengeModal(targetWallet, targetName) {
        if (!state.authedWallet) {
            notifyToast('Connect your wallet first to challenge players.', 'warn');
            return;
        }
        state.dcTarget = { wallet: targetWallet.toLowerCase(), username: targetName || shortWallet(targetWallet) };
        $('#dc-target-name').text(state.dcTarget.username);
        $('#dc-paid-toggle').prop('checked', false);
        $('#dc-stake-wrap').addClass('hidden-element');
        $('#dc-side-wrap').removeClass('hidden-element');
        $('#player-profile-modal').addClass('hidden-element');
        $('#direct-challenge-modal').removeClass('hidden-element');
    }

    async function submitDirectChallenge() {
        if (!state.dcTarget) return;
        const ctx = getBridge().getContext ? getBridge().getContext() : {};
        const timeControl = $('#dc-time-control').val() || 'blitz';
        const isPaid = $('#dc-paid-toggle').is(':checked');
        const sidePref = parseInt($('input[name="dcSidePref"]:checked').val() || 2, 10);

        if (!isPaid) {
            sendSocial({
                type: 'DIRECT_CHALLENGE_SEND',
                targetWallet: state.dcTarget.wallet,
                timeControl,
                sidePref,
                isPaid: false
            });
            $('#direct-challenge-modal').addClass('hidden-element');
            return;
        }

        const rawStake = $('#dc-stake-input').val();
        const stake = typeof window.normalizeStake === 'function' ? window.normalizeStake(rawStake) : rawStake;
        if (!stake || !ctx.contract || !ctx.signer || !ctx.wallet) {
            notifyToast('Connect your wallet and enter a valid zkLTC wager.', 'error');
            return;
        }

        const tcVal = timeControl === 'bullet' ? 0 : (timeControl === 'rapid' ? 2 : 1);
        const matchId = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map(b => b.toString(16).padStart(2, '0')).join('');
        const ephemeralWallet = ethers.Wallet.createRandom();

        try {
            $('#btn-dc-send').prop('disabled', true).text('Signing Escrow...');
            if (typeof window.getOrCreateDelegatedSession === 'function') {
                await window.getOrCreateDelegatedSession(ctx.wallet, ctx.signer);
            }
            const tx = await ctx.contract.createChallenge(matchId, tcVal, ephemeralWallet.address, {
                value: ethers.utils.parseEther(stake.toString())
            });
            notifyToast('Escrowing wager on LitVM...', 'info');
            await tx.wait();

            sendSocial({
                type: 'DIRECT_CHALLENGE_SEND',
                targetWallet: state.dcTarget.wallet,
                timeControl,
                sidePref: 0,
                isPaid: true,
                stake: stake.toString(),
                matchId,
                ephemeralPrivateKey: ephemeralWallet.privateKey
            });
            $('#direct-challenge-modal').addClass('hidden-element');
            notifyToast(`Wagered challenge (${stake} zkLTC) sent to ${state.dcTarget.username}!`, 'success');
        } catch (err) {
            notifyToast('Staked challenge failed: ' + (err.reason || err.message), 'error');
        } finally {
            $('#btn-dc-send').prop('disabled', false).text('Send Challenge');
        }
    }

    function renderIncomingChallengeBanner(ch) {
        state.activeIncomingChallenge = ch;
        playNotifSound();
        updateNotificationBadges();

        const wagerStr = ch.isPaid ? ` • 💰 ${esc(ch.stake)} zkLTC Wager` : ' • Free Duel';
        const acceptLabel = ch.isPaid ? `✓ Accept & Stake (${esc(ch.stake)} zkLTC)` : '✓ Accept Match';

        $('#incoming-challenge-banner').removeClass('hidden-element').html(`
            <div class="challenge-banner-row">
                <div>
                    <div class="challenge-banner-title">⚔️ Challenge from ${esc(ch.fromName)} ${clubTagHtml(ch.fromClubTag)}</div>
                    <div class="challenge-banner-sub">${esc(formatTimeControlLabel(ch.timeControl))}${wagerStr} • Blitz ${ch.fromRatings?.blitz || 2000}</div>
                </div>
                <span id="inc-ch-timer" class="challenge-countdown-pill">60s</span>
            </div>
            <div class="challenge-banner-actions">
                <button id="btn-inc-ch-accept" class="btn-cta-launch">${acceptLabel}</button>
                <button id="btn-inc-ch-decline" class="btn-danger">Decline</button>
            </div>
        `);

        startBannerCountdown('#inc-ch-timer', ch.expiresAt, () => {
            $('#incoming-challenge-banner').addClass('hidden-element').empty();
            state.activeIncomingChallenge = null;
            updateNotificationBadges();
        });
    }

    function renderOutgoingChallengeBanner(ch) {
        state.activeOutgoingChallenge = ch;
        const wagerStr = ch.isPaid ? ` (${esc(ch.stake)} zkLTC)` : ' (Free)';
        $('#outgoing-challenge-banner').removeClass('hidden-element').html(`
            <div class="challenge-banner-row">
                <div>
                    <div class="challenge-banner-title">⏳ Challenge Sent to ${esc(ch.toName)}</div>
                    <div class="challenge-banner-sub">${esc(formatTimeControlLabel(ch.timeControl))}${wagerStr} — Waiting for response...</div>
                </div>
                <span id="out-ch-timer" class="challenge-countdown-pill">60s</span>
            </div>
            <div class="challenge-banner-actions">
                <button id="btn-out-ch-cancel" class="btn-warning">${ch.isPaid ? 'Cancel & Refund Stake' : 'Cancel Invite'}</button>
            </div>
        `);

        startBannerCountdown('#out-ch-timer', ch.expiresAt, () => {
            if (!ch.isPaid) {
                $('#outgoing-challenge-banner').addClass('hidden-element').empty();
                state.activeOutgoingChallenge = null;
            }
        });
    }

    function renderRefundPromptBanner(matchId, reasonText) {
        $('#outgoing-challenge-banner').removeClass('hidden-element').html(`
            <div class="challenge-banner-row">
                <div>
                    <div class="challenge-banner-title">💰 Refund Available</div>
                    <div class="challenge-banner-sub">${esc(reasonText)}</div>
                </div>
            </div>
            <div class="challenge-banner-actions">
                <button id="btn-dc-refund-now" data-refund-match="${esc(matchId)}" class="btn-cta-launch">Refund Escrowed zkLTC</button>
                <button id="btn-dc-refund-dismiss" class="btn-secondary">Dismiss</button>
            </div>
        `);
    }

    function startBannerCountdown(selector, expiresAt, onZero) {
        if (state.challengeCountdownTimer) clearInterval(state.challengeCountdownTimer);
        const tick = () => {
            const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
            $(selector).text(`${left}s`);
            if (left <= 0) {
                clearInterval(state.challengeCountdownTimer);
                if (onZero) onZero();
            }
        };
        tick();
        state.challengeCountdownTimer = setInterval(tick, 500);
    }

    async function acceptActiveIncomingChallenge() {
        const ch = state.activeIncomingChallenge;
        if (!ch) return;

        if (!ch.isPaid) {
            $('#btn-inc-ch-accept').prop('disabled', true).text('Launching...');
            sendSocial({ type: 'DIRECT_CHALLENGE_RESPOND', challengeId: ch.challengeId, accepted: true });
            return;
        }

        const ctx = getBridge().getContext ? getBridge().getContext() : {};
        if (!ctx.wallet || !ctx.contract || !ctx.signer) {
            notifyToast('Connect your wallet to accept a wagered challenge.', 'warn');
            return;
        }
        if (!ch.ephemeralPrivateKey || !ch.matchId) {
            notifyToast('Missing challenge signature key.', 'error');
            return;
        }

        try {
            $('#btn-inc-ch-accept').prop('disabled', true).text('Staking on LitVM...');
            if (typeof window.getOrCreateDelegatedSession === 'function') {
                await window.getOrCreateDelegatedSession(ctx.wallet, ctx.signer);
            }
            const localEph = new ethers.Wallet(ch.ephemeralPrivateKey);
            const messageHash = ethers.utils.solidityKeccak256(['address', 'bytes32'], [ctx.wallet, ch.matchId]);
            const signature = await localEph.signMessage(ethers.utils.arrayify(messageHash));

            const tx = await ctx.contract.joinChallenge(ch.matchId, signature, {
                value: ethers.utils.parseEther(ch.stake.toString())
            });
            notifyToast('Confirming wager deposit on LitVM...', 'info');
            await tx.wait();

            sendSocial({ type: 'DIRECT_CHALLENGE_RESPOND', challengeId: ch.challengeId, accepted: true });
        } catch (err) {
            notifyToast('Failed to accept staked challenge: ' + (err.reason || err.message), 'error');
            $('#btn-inc-ch-accept').prop('disabled', false).text(`✓ Accept & Stake (${ch.stake} zkLTC)`);
        }
    }

    async function refundStakedChallenge(matchId) {
        const ctx = getBridge().getContext ? getBridge().getContext() : {};
        if (!ctx.contract || !matchId) return;
        try {
            notifyToast('Refunding escrowed stake on-chain...', 'info');
            const tx = await ctx.contract.cancelCreatedMatch(matchId);
            await tx.wait();
            notifyToast('Full zkLTC stake refunded to your wallet!', 'success');
            $('#outgoing-challenge-banner').addClass('hidden-element').empty();
            state.activeOutgoingChallenge = null;
        } catch (err) {
            notifyToast('Refund failed: ' + (err.reason || err.message), 'error');
        }
    }

    // =========================================================================
    // 8. TAB SWITCHER & INCOMING WEBSOCKET ROUTER
    // =========================================================================
    function switchSocialTab(tabName) {
        state.activeTab = tabName;
        $('.social-tab-btn').removeClass('active');
        $(`.social-tab-btn[data-tab="${tabName}"]`).addClass('active');
        $('.social-tab-pane').addClass('hidden-element');
        $(`#social-pane-${tabName}`).removeClass('hidden-element');

        if (tabName === 'clubs') {
            sendSocial({ type: 'CLUB_LIST' });
            if (state.myClub) sendSocial({ type: 'CLUB_DETAILS', clubId: state.myClub.id });
        } else if (tabName === 'feed') {
            sendSocial({ type: 'GET_ACTIVITY_FEED' });
            if (!$('#leaderboard-view').hasClass('hidden-element')) {
                sendSocial({ type: 'GET_LEADERBOARD', format: $('#leaderboard-format-select').val() || 'blitz' });
            }
        }
    }

    function handleMessage(data) {
        if (!data || !data.type) return false;

        switch (data.type) {
            case 'SOCIAL_HELLO':
                state.nonce = data.nonce;
                state.isAuthing = false;
                attemptSocialAuth();
                return true;

            case 'SOCIAL_AUTH_OK':
                state.authedWallet = data.wallet;
                state.nonce = null; // Nonce consumed & rotated server-side
                if (state.authRetryTimer) {
                    clearTimeout(state.authRetryTimer);
                    state.authRetryTimer = null;
                }
                if (typeof window.updateProfileRatingsDisplay === 'function') {
                    window.updateProfileRatingsDisplay();
                }
                return true;

            case 'SOCIAL_ERROR':
                notifyToast(data.reason || 'Social action failed.', 'error');
                return true;

            case 'SOCIAL_INFO':
                notifyToast(data.message, 'success');
                return true;

            case 'FRIENDS_SYNC':
                state.me = data.me || null;
                state.friends = data.friends || [];
                state.following = data.following || [];
                state.incomingRequests = data.incomingRequests || [];
                state.outgoingRequests = data.outgoingRequests || [];
                state.blocked = data.blocked || [];
                state.dmThreads = data.dmThreads || [];
                state.unreadDmTotal = data.unreadDmTotal || 0;
                state.myClub = data.myClub || null;
                state.activityFeed = data.activityFeed || [];

                if (state.me && state.me.privacy) {
                    $('#privacy-challenges-select').val(state.me.privacy.challenges || 'everyone');
                    $('#privacy-dms-select').val(state.me.privacy.dms || 'everyone');
                }

                renderFriendsAndFollowing();
                renderRequestsAndBlocked();
                renderDmThreads();
                renderClubsView();
                renderActivityFeed();
                updateNotificationBadges();

                if (typeof window.updateProfileRatingsDisplay === 'function') {
                    window.updateProfileRatingsDisplay();
                }

                if (Array.isArray(data.incomingChallenges) && data.incomingChallenges.length > 0 && !state.activeIncomingChallenge) {
                    renderIncomingChallengeBanner(data.incomingChallenges[0]);
                }

                if (state.activeProfile && !$('#player-profile-modal').hasClass('hidden-element')) {
                    sendSocial({ type: 'GET_PROFILE', wallet: state.activeProfile.wallet });
                }
                return true;

            case 'FRIEND_PRESENCE_UPDATE': {
                const updateList = (arr) => {
                    const item = arr.find(x => x.wallet === data.wallet);
                    if (item) {
                        item.presence = data.presence;
                        if (data.username) item.username = data.username;
                        if (data.clubTag !== undefined) item.clubTag = data.clubTag;
                    }
                };
                updateList(state.friends);
                updateList(state.following);
                updateList(state.dmThreads);
                renderFriendsAndFollowing();
                renderDmThreads();
                if (state.activeDmPartner && state.activeDmPartner.wallet === data.wallet) {
                    $('#dm-chat-partner-status').text(presenceLabel(data.presence));
                }
                return true;
            }

            case 'FRIEND_REQUEST_RECEIVED':
                playNotifSound();
                notifyToast(`👥 ${data.request.username} sent you a friend request!`, 'info', 5000);
                return true;

            case 'SEARCH_USERS_RESULT':
                renderSearchDropdown(data);
                return true;

            case 'LEADERBOARD_DATA':
                state.leaderboard = data.players || [];
                renderLeaderboard(state.leaderboard);
                return true;

            case 'PROFILE_DATA':
                renderProfileModal(data);
                return true;

            case 'DIRECT_CHALLENGE_RECEIVED':
                renderIncomingChallengeBanner(data.challenge);
                return true;

            case 'DIRECT_CHALLENGE_SENT':
                renderOutgoingChallengeBanner(data);
                return true;

            case 'DIRECT_CHALLENGE_ACCEPTED':
                if (state.challengeCountdownTimer) clearInterval(state.challengeCountdownTimer);
                $('#incoming-challenge-banner, #outgoing-challenge-banner').addClass('hidden-element').empty();
                state.activeIncomingChallenge = null;
                state.activeOutgoingChallenge = null;
                updateNotificationBadges();
                if (getBridge().launchDirectMatch) {
                    getBridge().launchDirectMatch(data);
                }
                return true;

            case 'DIRECT_CHALLENGE_DECLINED':
                if (state.challengeCountdownTimer) clearInterval(state.challengeCountdownTimer);
                state.activeOutgoingChallenge = null;
                if (data.isPaid && data.matchId) {
                    renderRefundPromptBanner(data.matchId, `${data.toName} declined your staked challenge.`);
                } else {
                    $('#outgoing-challenge-banner').addClass('hidden-element').empty();
                    notifyToast(`${data.toName} declined your challenge.`, 'warn');
                }
                return true;

            case 'DIRECT_CHALLENGE_EXPIRED':
                if (state.challengeCountdownTimer) clearInterval(state.challengeCountdownTimer);
                if (state.activeIncomingChallenge && state.activeIncomingChallenge.challengeId === data.challengeId) {
                    $('#incoming-challenge-banner').addClass('hidden-element').empty();
                    state.activeIncomingChallenge = null;
                    updateNotificationBadges();
                }
                if (state.activeOutgoingChallenge && state.activeOutgoingChallenge.challengeId === data.challengeId) {
                    state.activeOutgoingChallenge = null;
                    if (data.isPaid && data.matchId) {
                        renderRefundPromptBanner(data.matchId, `Challenge to ${data.toName} expired.`);
                    } else {
                        $('#outgoing-challenge-banner').addClass('hidden-element').empty();
                        notifyToast('Direct challenge expired.', 'info');
                    }
                }
                return true;

            case 'DM_RECEIVED': {
                const msg = data.message;
                const partnerWallet = msg.sender === state.authedWallet ? msg.recipient : msg.sender;
                const isOpenThread = state.activeTab === 'dms' &&
                    !$('#dm-chat-view').hasClass('hidden-element') &&
                    state.activeDmPartner &&
                    state.activeDmPartner.wallet === partnerWallet;

                if (isOpenThread) {
                    appendDmBubble(msg);
                    if (msg.recipient === state.authedWallet) {
                        sendSocial({ type: 'DM_MARK_READ', targetWallet: partnerWallet });
                    }
                } else if (msg.recipient === state.authedWallet) {
                    playNotifSound();
                    notifyToast(`💬 ${msg.senderName}: ${msg.body.slice(0, 60)}`, 'info');
                }
                sendSocial({ type: 'FRIENDS_SYNC_REQUEST' });
                return true;
            }

            case 'DM_HISTORY_DATA':
                renderDmHistory(data);
                return true;

            case 'CLUB_LIST_DATA':
                state.clubsList = data.clubs || [];
                renderClubsView();
                return true;

            case 'CLUB_DETAILS_DATA':
                state.myClub = data.club;
                renderClubsView();
                return true;

            case 'CLUB_CHAT_MESSAGE':
                if (state.myClub && state.myClub.id === data.message.clubId) {
                    state.myClub.messages = state.myClub.messages || [];
                    state.myClub.messages.push(data.message);
                    const sc = $('#club-chat-scroll');
                    if (sc.length) {
                        sc.find('.social-empty-state').remove();
                        sc.append(`<div><strong style="color:#93c5fd;">${esc(data.message.senderName)}:</strong> ${esc(data.message.body)}</div>`);
                        sc.scrollTop(sc[0].scrollHeight);
                    }
                }
                return true;

            case 'ACTIVITY_FEED_DATA':
                state.activityFeed = data.events || [];
                renderActivityFeed();
                return true;

            case 'ACTIVITY_EVENT':
                if (data.event) {
                    state.activityFeed.unshift(data.event);
                    if (state.activityFeed.length > 30) state.activityFeed.length = 30;
                    renderActivityFeed();
                }
                return true;

            default:
                return false;
        }
    }

    // =========================================================================
    // 9. DOM EVENT BINDINGS
    // =========================================================================
    function bindDomEvents() {
        $(document).on('click', '.social-tab-btn', function () {
            switchSocialTab($(this).data('tab'));
        });

        $('#feed-subtab-activity').click(function () {
            $('#feed-subtab-activity').addClass('active');
            $('#feed-subtab-leaderboard').removeClass('active');
            $('#activity-feed-view').removeClass('hidden-element');
            $('#leaderboard-view').addClass('hidden-element');
            sendSocial({ type: 'GET_ACTIVITY_FEED' });
        });

        $('#feed-subtab-leaderboard').click(function () {
            $('#feed-subtab-leaderboard').addClass('active');
            $('#feed-subtab-activity').removeClass('active');
            $('#leaderboard-view').removeClass('hidden-element');
            $('#activity-feed-view').addClass('hidden-element');
            sendSocial({ type: 'GET_LEADERBOARD', format: $('#leaderboard-format-select').val() || 'blitz' });
        });

        $('#leaderboard-format-select').change(function () {
            sendSocial({ type: 'GET_LEADERBOARD', format: $(this).val() });
        });

        $('#search-user-input-home').on('input', function () {
            clearTimeout(state.searchTimers.home);
            const val = $(this).val();
            state.searchTimers.home = setTimeout(() => triggerFuzzySearch(val, 'home'), 250);
        }).on('keypress', function (e) {
            if (e.which === 13) triggerFuzzySearch($(this).val(), 'home');
        });
        $('#btn-search-user-home').off('click').on('click', () => triggerFuzzySearch($('#search-user-input-home').val(), 'home'));

        $('#search-user-input').on('input', function () {
            clearTimeout(state.searchTimers.arena);
            const val = $(this).val();
            state.searchTimers.arena = setTimeout(() => triggerFuzzySearch(val, 'arena'), 250);
        }).on('keypress', function (e) {
            if (e.which === 13) triggerFuzzySearch($(this).val(), 'arena');
        });
        $('#btn-search-user').off('click').on('click', () => triggerFuzzySearch($('#search-user-input').val(), 'arena'));

        $(document).on('click', function (e) {
            if (!$(e.target).closest('.global-search-wrap').length) $('#search-dropdown-home').addClass('hidden-element');
            if (!$(e.target).closest('.arena-search-wrap').length) $('#search-dropdown-arena').addClass('hidden-element');
            if (!$(e.target).closest('#btn-social-bell-home, #home-social-popover').length) $('#home-social-popover').addClass('hidden-element');
        });

        $('#btn-social-bell-home').click(function () {
            $('#home-social-popover').toggleClass('hidden-element');
            renderHomePopover();
        });

        $(document).on('click', '[data-home-open-dm]', function () {
            const w = $(this).data('home-open-dm');
            const thread = state.dmThreads.find(t => t.wallet === w);
            $('#home-social-popover').addClass('hidden-element');
            if ($('#home-view-container').is(':visible')) {
                $('.mode-btn[data-mode="2p"]').click();
            }
            openDmConversation(w, thread ? thread.username : shortWallet(w));
        });

        $(document).on('click', '[data-open-profile]', function () {
            openPlayerProfile($(this).data('open-profile'), false);
        });

        $('#opponent-name').click(function () {
            const ctx = getBridge().getContext ? getBridge().getContext() : {};
            if (ctx.opponentWallet) openPlayerProfile(ctx.opponentWallet, false);
            else if (
                ctx.opponentUsername &&
                !ctx.opponentUsername.startsWith('LitEngine') &&
                !ctx.opponentUsername.startsWith('Guest_') &&
                ctx.opponentUsername !== 'Opponent'
            ) {
                openPlayerProfile(ctx.opponentUsername, true);
            }
        });

        $('#user-name').click(function () {
            const ctx = getBridge().getContext ? getBridge().getContext() : {};
            if (ctx.wallet) openPlayerProfile(ctx.wallet, false);
        });

        $('#btn-quick-add-opponent').click(function () {
            const ctx = getBridge().getContext ? getBridge().getContext() : {};
            if (ctx.opponentWallet) {
                sendSocial({ type: 'FRIEND_REQUEST_SEND', targetWallet: ctx.opponentWallet });
            }
        });

        $('#btn-close-profile-modal').click(() => $('#player-profile-modal').addClass('hidden-element'));
        $('#player-profile-modal').click(function (e) { if (e.target === this) $(this).addClass('hidden-element'); });

        $('#btn-prof-copy-wallet').click(() => {
            if (state.activeProfile && state.activeProfile.wallet) {
                navigator.clipboard.writeText(state.activeProfile.wallet);
                notifyToast('Wallet address copied!', 'success', 2000);
            }
        });

        $('#btn-prof-save-note').click(() => {
            if (!state.activeProfile) return;
            sendSocial({
                type: 'PLAYER_NOTE_SAVE',
                targetWallet: state.activeProfile.wallet,
                note: $('#prof-note-input').val()
            });
        });

        $('#btn-prof-run-it-back').click(() => {
            if (!state.activeProfile) return;
            openDirectChallengeModal(state.activeProfile.wallet, state.activeProfile.username);
        });

        $('#btn-prof-block').click(function () {
            if (!state.activeProfile) return;
            const isBlocked = $(this).data('blocked');
            sendSocial({
                type: isBlocked ? 'USER_UNBLOCK' : 'USER_BLOCK',
                targetWallet: state.activeProfile.wallet
            });
        });

        $('#btn-prof-report').click(() => {
            if (!state.activeProfile) return;
            const reason = window.prompt(`Report ${state.activeProfile.username} — briefly describe the issue:`);
            if (reason && reason.trim()) {
                sendSocial({ type: 'USER_REPORT', targetWallet: state.activeProfile.wallet, reason: reason.trim() });
            }
        });

        $(document).on('click', '[data-analyze-game-idx]', function () {
            const idx = parseInt($(this).data('analyze-game-idx'), 10);
            const g = state.activeProfile && state.activeProfile.recentGames ? state.activeProfile.recentGames[idx] : null;
            if (g && g.pgn && getBridge().loadReplayForAnalysis) {
                $('#player-profile-modal').addClass('hidden-element');
                getBridge().loadReplayForAnalysis(g);
            }
        });

        $(document).on('click', '[data-send-freq]', function () {
            sendSocial({ type: 'FRIEND_REQUEST_SEND', targetWallet: $(this).data('send-freq') });
        });
        $(document).on('click', '[data-req-accept]', function () {
            sendSocial({ type: 'FRIEND_REQUEST_RESPOND', requestId: $(this).data('req-accept'), action: 'accept' });
        });
        $(document).on('click', '[data-req-decline]', function () {
            sendSocial({ type: 'FRIEND_REQUEST_RESPOND', requestId: $(this).data('req-decline'), action: 'decline' });
        });
        $(document).on('click', '[data-req-cancel]', function () {
            sendSocial({ type: 'FRIEND_REQUEST_RESPOND', requestId: $(this).data('req-cancel'), action: 'cancel' });
        });
        $(document).on('click', '[data-unfriend-wallet]', function () {
            sendSocial({ type: 'FRIEND_REMOVE', targetWallet: $(this).data('unfriend-wallet') });
        });
        $(document).on('click', '[data-follow-toggle]', function () {
            sendSocial({ type: 'FOLLOW_TOGGLE', targetWallet: $(this).data('follow-toggle') });
        });
        $(document).on('click', '[data-unblock-wallet]', function () {
            sendSocial({ type: 'USER_UNBLOCK', targetWallet: $(this).data('unblock-wallet') });
        });
        $(document).on('click', '[data-spectate]', function () {
            const mId = $(this).data('spectate');
            $('#player-profile-modal, #search-dropdown-home, #search-dropdown-arena').addClass('hidden-element');
            if (typeof window.spectateMatchById === 'function') window.spectateMatchById(mId);
        });

        $(document).on('click', '[data-open-dm]', function () {
            $('#player-profile-modal').addClass('hidden-element');
            if ($('#home-view-container').is(':visible')) {
                $('.mode-btn[data-mode="2p"]').click();
            }
            openDmConversation($(this).data('open-dm'), $(this).data('open-dm-name'));
        });

        $('#dm-chat-back').click(() => {
            state.activeDmPartner = null;
            $('#dm-chat-view').addClass('hidden-element');
            $('#dm-threads-view').removeClass('hidden-element');
            renderDmThreads();
        });

        $('#dm-chat-challenge-btn').click(() => {
            if (state.activeDmPartner) {
                openDirectChallengeModal(state.activeDmPartner.wallet, state.activeDmPartner.username);
            }
        });

        const sendCurrentDm = () => {
            if (!state.activeDmPartner) return;
            const body = $('#dm-chat-input').val().trim();
            if (!body) return;
            sendSocial({ type: 'DM_SEND', targetWallet: state.activeDmPartner.wallet, body });
            $('#dm-chat-input').val('');
        };
        $('#btn-dm-send').click(sendCurrentDm);
        $('#dm-chat-input').keypress(e => { if (e.which === 13) sendCurrentDm(); });

        $(document).on('click', '[data-challenge-wallet]', function () {
            openDirectChallengeModal($(this).data('challenge-wallet'), $(this).data('challenge-name'));
        });

        $('#btn-close-challenge-modal, #btn-dc-cancel').click(() => $('#direct-challenge-modal').addClass('hidden-element'));
        $('#dc-paid-toggle').change(function () {
            const paid = $(this).is(':checked');
            $('#dc-stake-wrap').toggleClass('hidden-element', !paid);
            $('#dc-side-wrap').toggleClass('hidden-element', paid);
            $('#dc-paid-label').toggleClass('active-text', paid);
        });
        $('.dc-tier-btn').click(function () {
            $('.dc-tier-btn').removeClass('selected-tier');
            $(this).addClass('selected-tier');
            $('#dc-stake-input').val($(this).data('amount'));
        });
        $('#btn-dc-send').click(submitDirectChallenge);

        $(document).on('click', '#btn-inc-ch-accept', acceptActiveIncomingChallenge);
        $(document).on('click', '#btn-inc-ch-decline', () => {
            if (!state.activeIncomingChallenge) return;
            sendSocial({ type: 'DIRECT_CHALLENGE_RESPOND', challengeId: state.activeIncomingChallenge.challengeId, accepted: false });
            $('#incoming-challenge-banner').addClass('hidden-element').empty();
            state.activeIncomingChallenge = null;
            updateNotificationBadges();
        });

        $(document).on('click', '#btn-out-ch-cancel', async () => {
            const ch = state.activeOutgoingChallenge;
            if (!ch) return;
            sendSocial({ type: 'DIRECT_CHALLENGE_CANCEL', challengeId: ch.challengeId });
            if (ch.isPaid && ch.matchId) {
                await refundStakedChallenge(ch.matchId);
            } else {
                $('#outgoing-challenge-banner').addClass('hidden-element').empty();
                state.activeOutgoingChallenge = null;
            }
        });

        $(document).on('click', '#btn-dc-refund-now', function () {
            refundStakedChallenge($(this).data('refund-match'));
        });
        $(document).on('click', '#btn-dc-refund-dismiss', () => {
            $('#outgoing-challenge-banner').addClass('hidden-element').empty();
        });

        $('#btn-open-create-club').click(() => {
            if (!state.authedWallet) {
                notifyToast('Connect your wallet to found a club.', 'warn');
                return;
            }
            $('#create-club-modal').removeClass('hidden-element');
        });
        $('#btn-close-club-modal, #btn-club-create-cancel').click(() => $('#create-club-modal').addClass('hidden-element'));
        $('#btn-club-create-submit').click(() => {
            const name = $('#club-create-name').val().trim();
            const tag = $('#club-create-tag').val().trim().toUpperCase();
            const description = $('#club-create-desc').val().trim();
            sendSocial({ type: 'CLUB_CREATE', name, tag, description });
            $('#create-club-modal').addClass('hidden-element');
            $('#club-create-name, #club-create-tag, #club-create-desc').val('');
        });

        $(document).on('click', '[data-join-club]', function () {
            sendSocial({ type: 'CLUB_JOIN', clubId: $(this).data('join-club') });
        });
        $(document).on('click', '#btn-club-leave', () => sendSocial({ type: 'CLUB_LEAVE' }));
        $(document).on('click', '#btn-club-enter-arena', function () {
            const tid = $(this).data('tourney-id');
            if (tid && getBridge().openClubTournament) getBridge().openClubTournament(tid);
        });
        $(document).on('click', '#btn-club-chat-send', () => {
            const body = $('#club-chat-input').val().trim();
            if (!body) return;
            sendSocial({ type: 'CLUB_CHAT_SEND', body });
            $('#club-chat-input').val('');
        });
        $(document).on('keypress', '#club-chat-input', (e) => {
            if (e.which === 13) $('#btn-club-chat-send').click();
        });

        $('#privacy-challenges-select, #privacy-dms-select').change(() => {
            if (!state.authedWallet) {
                notifyToast('Connect your wallet to save privacy preferences.', 'warn');
                return;
            }
            sendSocial({
                type: 'PRIVACY_UPDATE',
                challenges: $('#privacy-challenges-select').val(),
                dms: $('#privacy-dms-select').val()
            });
        });
    }

    // =========================================================================
    // 10. PUBLIC LIFECYCLE HOOKS (Called by public/app.js)
    // =========================================================================
    window.LitSocial = {
        onSocketOpen(ws) {
            state.socket = ws;
            state.nonce = null;
            state.authedWallet = null;
            state.isAuthing = false;
        },
        onWalletChanged(wallet) {
            if (!wallet) {
                if (state.authRetryTimer) {
                    clearTimeout(state.authRetryTimer);
                    state.authRetryTimer = null;
                }
                state.authedWallet = null;
                state.me = null;
                state.friends = [];
                state.following = [];
                state.incomingRequests = [];
                state.outgoingRequests = [];
                state.blocked = [];
                state.dmThreads = [];
                state.unreadDmTotal = 0;
                state.myClub = null;
                renderFriendsAndFollowing();
                renderRequestsAndBlocked();
                renderDmThreads();
                renderClubsView();
                updateNotificationBadges();
                return;
            }
            attemptSocialAuth();
        },
        onUsernameRegistered() {
            // Reopen the lobby socket cleanly so the server sends a fresh SOCIAL_HELLO nonce
            // and re-reads the newly claimed on-chain handle from UsernameRegistry.
            const sock = getSocket();
            state.authedWallet = null;
            state.nonce = null;
            if (sock) {
                try { sock.close(); } catch (_) {}
            } else if (typeof window.connectLobbyTelemetrySocket === 'function') {
                window.connectLobbyTelemetrySocket();
            }
        },
        handleMessage,
        openProfile: openPlayerProfile,
        isFriend(wallet) {
            if (!wallet) return false;
            const w = wallet.toLowerCase();
            return state.friends.some(f => f.wallet === w);
        }
    };

    $(document).ready(() => {
        bindDomEvents();
        setupPresenceTrackers();

        // Refresh safety net: if wallet auto-reconnected right before/after SOCIAL_HELLO
        setTimeout(() => { if (!state.authedWallet) attemptSocialAuth(); }, 900);
        setTimeout(() => { if (!state.authedWallet) attemptSocialAuth(); }, 2500);
    });
})();