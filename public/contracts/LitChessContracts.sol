// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title LitChessUsernameRegistry
 * @notice On-chain identity registry mapping wallet addresses to unique lowercase handles.
 */
contract LitChessUsernameRegistry {
    mapping(address => string) private _usernames;
    mapping(bytes32 => address) private _nameHashToOwner;

    event UsernameRegistered(address indexed user, string username);

    error UsernameEmpty();
    error UsernameTooLong();
    error UsernameAlreadyTaken();

    function registerUsername(string calldata _name) external {
        uint256 len = bytes(_name).length;
        if (len == 0) revert UsernameEmpty();
        if (len > 20) revert UsernameTooLong();

        bytes32 nameHash = keccak256(abi.encodePacked(_name));
        address currentHolder = _nameHashToOwner[nameHash];
        if (currentHolder != address(0) && currentHolder != msg.sender) {
            revert UsernameAlreadyTaken();
        }

        // Release previous username if the caller is updating their handle
        string memory oldName = _usernames[msg.sender];
        if (bytes(oldName).length > 0) {
            delete _nameHashToOwner[keccak256(abi.encodePacked(oldName))];
        }

        _usernames[msg.sender] = _name;
        _nameHashToOwner[nameHash] = msg.sender;

        emit UsernameRegistered(msg.sender, _name);
    }

    function getUsername(address _user) external view returns (string memory) {
        return _usernames[_user];
    }

    function resolveUsername(string calldata _name) external view returns (address) {
        return _nameHashToOwner[keccak256(abi.encodePacked(_name))];
    }
}

/**
 * @title LitChessEscrowclean
 * @notice Institutional Zero-Trust Chess Escrow, Matchmaking Queue, Challenge Link Verifier,
 *         Tournament Pool, and EIP-712 State-Channel Settlement Protocol.
 */
contract LitChessEscrowclean {
    // =========================================================================
    // 1. ENUMS & STRUCTS (100% ABI-Compatible with app.js & server.js)
    // =========================================================================
    enum TimeControl { Bullet, Blitz, Rapid }
    enum ColorPref { White, Black, Random }
    enum MatchStatus { Created, Active, Resolved, Aborted }

    struct PendingMatch {
        address player;
        uint256 stake;
        TimeControl tc;
        uint256 timestamp;
        ColorPref pref;
    }

    struct Match {
        bytes32 matchId;
        address payable playerWhite;
        address payable playerBlack;
        uint256 wagerAmount;
        MatchStatus status;
        uint256 lastMoveTimestamp;
        TimeControl timeControl;
    }

    struct Tournament {
        bytes32 tourneyId;
        uint256 entryFee;
        uint256 totalPot;
        address creator;
        bool isActive;
    }

    // =========================================================================
    // 2. STATE VARIABLES & CONSTANTS
    // =========================================================================
    address public owner;
    address public serverOracle;
    bool public paused;

    uint256 public constant STALLED_HATCH_TIME = 1 hours;
    uint256 public constant TAX_RATE = 250; // 2.50% protocol fee (in basis points, 10000 = 100%)
    uint256 private constant BPS_DENOMINATOR = 10000;

    uint256 private _unlocked = 1;
    uint256 private _matchNonce;
    uint256 public accumulatedProtocolFees;

    // Multi-Oracle fleet support for horizontal scaling
    mapping(address => bool) public authorizedOracles;

    // Pull-fallback balances if a smart-contract wallet reverts on direct native transfer
    mapping(address => uint256) public claimableBalances;

    // Core Protocol Storage Mappings
    mapping(bytes32 => Match) public matches;
    mapping(bytes32 => address) public challengeEphemeralKeys;
    mapping(uint256 => mapping(TimeControl => PendingMatch[])) public pendingMatches;
    mapping(bytes32 => Tournament) public tournaments;
    mapping(bytes32 => mapping(address => bool)) public tournamentParticipants;

    // EIP-712 Domain & Typehashes for Trustless State-Channel Resolution
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant STATE_SETTLEMENT_TYPEHASH =
        keccak256("StateSettlement(bytes32 matchId,address winner,uint256 moveCount,bytes32 fenHash)");

    // =========================================================================
    // 3. EVENTS (Exact ABI Signatures)
    // =========================================================================
    event Paused();
    event Unpaused();
    event QueuedForMatch(address indexed player, uint256 stake, TimeControl tc, ColorPref pref);
    event CancelledQueue(address indexed player, uint256 stake, TimeControl tc);
    event MatchCreated(bytes32 indexed matchId, address indexed creator, uint256 wager, TimeControl tc);
    event ChallengeCreated(bytes32 indexed matchId, address indexed creator, uint256 wager, TimeControl tc, address ephemeralKey);
    event MatchStarted(bytes32 indexed matchId, address white, address black);
    event MatchResolved(bytes32 indexed matchId, address winner, uint256 payout);
    event MatchAborted(bytes32 indexed matchId);
    event TournamentCreated(bytes32 indexed tourneyId, uint256 entryFee);
    event TournamentJoined(bytes32 indexed tourneyId, address player);
    event TournamentResolved(bytes32 indexed tourneyId, address winner, uint256 payout);
    event OracleAuthorizationUpdated(address indexed oracle, bool authorized);
    event FallbackBalanceCredited(address indexed user, uint256 amount);

    // =========================================================================
    // 4. MODIFIERS
    // =========================================================================
    modifier nonReentrant() {
        require(_unlocked == 1, "ReentrancyGuard: reentrant call");
        _unlocked = 2;
        _;
        _unlocked = 1;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    modifier onlyOracle() {
        require(msg.sender == serverOracle || authorizedOracles[msg.sender], "Not authorized oracle");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Protocol is paused");
        _;
    }

    // =========================================================================
    // 5. CONSTRUCTOR & ADMIN FUNCTIONS
    // =========================================================================
    constructor(address _serverOracle) {
        require(_serverOracle != address(0), "Invalid oracle address");
        owner = msg.sender;
        serverOracle = _serverOracle;
        authorizedOracles[_serverOracle] = true;

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("LitChessEscrow")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function setServerOracle(address _newOracle) external onlyOwner {
        require(_newOracle != address(0), "Invalid oracle address");
        serverOracle = _newOracle;
        authorizedOracles[_newOracle] = true;
        emit OracleAuthorizationUpdated(_newOracle, true);
    }

    function setOracleAuthorization(address _oracle, bool _authorized) external onlyOwner {
        authorizedOracles[_oracle] = _authorized;
        emit OracleAuthorizationUpdated(_oracle, _authorized);
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused();
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused();
    }

    function withdrawProtocolFees(address payable _to) external onlyOwner nonReentrant {
        uint256 amount = accumulatedProtocolFees;
        require(amount > 0, "No fees to withdraw");
        accumulatedProtocolFees = 0;
        (bool ok, ) = _to.call{value: amount}("");
        require(ok, "Fee withdrawal failed");
    }

    // =========================================================================
    // 6. ON-CHAIN MATCHMAKING QUEUE
    // =========================================================================
    function queueForMatch(
        uint256 _stake,
        TimeControl _tc,
        ColorPref _pref
    ) external payable whenNotPaused nonReentrant {
        require(_stake > 0 && msg.value == _stake, "Msg.value must equal stake");

        PendingMatch[] storage queue = pendingMatches[_stake][_tc];
        uint256 len = queue.length;

        // Prevent duplicate queueing by the same player in the same pool
        for (uint256 i = 0; i < len; i++) {
            require(queue[i].player != msg.sender, "Already in queue");
        }

        // Attempt to pair with the oldest compatible waiting opponent
        for (uint256 i = 0; i < len; i++) {
            PendingMatch memory candidate = queue[i];
            if (_areColorsCompatible(candidate.pref, _pref)) {
                // Remove candidate from queue (swap and pop)
                queue[i] = queue[len - 1];
                queue.pop();

                (address payable white, address payable black) = _assignColors(
                    payable(candidate.player),
                    candidate.pref,
                    payable(msg.sender),
                    _pref
                );

                bytes32 matchId = keccak256(
                    abi.encodePacked(block.timestamp, block.prevrandao, white, black, ++_matchNonce)
                );

                matches[matchId] = Match({
                    matchId: matchId,
                    playerWhite: white,
                    playerBlack: black,
                    wagerAmount: _stake,
                    status: MatchStatus.Active,
                    lastMoveTimestamp: block.timestamp,
                    timeControl: _tc
                });

                emit MatchStarted(matchId, white, black);
                return;
            }
        }

        // No compatible opponent found: enqueue caller
        queue.push(PendingMatch({
            player: msg.sender,
            stake: _stake,
            tc: _tc,
            timestamp: block.timestamp,
            pref: _pref
        }));

        emit QueuedForMatch(msg.sender, _stake, _tc, _pref);
    }

    function cancelQueue(uint256 _stake, TimeControl _tc) external nonReentrant {
        PendingMatch[] storage queue = pendingMatches[_stake][_tc];
        uint256 len = queue.length;
        bool found = false;

        for (uint256 i = 0; i < len; i++) {
            if (queue[i].player == msg.sender) {
                queue[i] = queue[len - 1];
                queue.pop();
                found = true;
                break;
            }
        }

        require(found, "No pending queue entry found");
        _transferOrCredit(payable(msg.sender), _stake);
        emit CancelledQueue(msg.sender, _stake, _tc);
    }

    function clearPendingMatches(uint256 _stake, TimeControl _tc) external onlyOracle nonReentrant {
        PendingMatch[] storage queue = pendingMatches[_stake][_tc];
        while (queue.length > 0) {
            PendingMatch memory entry = queue[queue.length - 1];
            queue.pop();
            _transferOrCredit(payable(entry.player), entry.stake);
            emit CancelledQueue(entry.player, entry.stake, _tc);
        }
    }

    function getPendingMatches(
        uint256 _stake,
        TimeControl _tc
    ) external view returns (PendingMatch[] memory) {
        return pendingMatches[_stake][_tc];
    }

    // =========================================================================
    // 7. DIRECT MATCHES & EPHEMERAL-KEY CHALLENGE LINKS
    // =========================================================================
    function createMatch(bytes32 _matchId, TimeControl _tc) external payable whenNotPaused nonReentrant {
        require(msg.value > 0, "Wager required");
        require(matches[_matchId].wagerAmount == 0, "Match ID already exists");

        matches[_matchId] = Match({
            matchId: _matchId,
            playerWhite: payable(msg.sender),
            playerBlack: payable(address(0)),
            wagerAmount: msg.value,
            status: MatchStatus.Created,
            lastMoveTimestamp: block.timestamp,
            timeControl: _tc
        });

        emit MatchCreated(_matchId, msg.sender, msg.value, _tc);
    }

    function joinMatch(bytes32 _matchId) external payable whenNotPaused nonReentrant {
        Match storage m = matches[_matchId];
        require(m.wagerAmount > 0 && m.status == MatchStatus.Created, "Match not joinable");
        require(m.playerWhite != msg.sender, "Cannot play against yourself");
        require(msg.value == m.wagerAmount, "Incorrect wager amount");

        m.playerBlack = payable(msg.sender);
        m.status = MatchStatus.Active;
        m.lastMoveTimestamp = block.timestamp;

        emit MatchStarted(_matchId, m.playerWhite, m.playerBlack);
    }

    function cancelCreatedMatch(bytes32 _matchId) external nonReentrant {
        Match storage m = matches[_matchId];
        require(m.playerWhite == msg.sender, "Not match creator");
        require(m.status == MatchStatus.Created && m.playerBlack == address(0), "Match already active or settled");

        uint256 refund = m.wagerAmount;
        m.status = MatchStatus.Aborted;
        m.wagerAmount = 0;

        _transferOrCredit(payable(msg.sender), refund);
        emit MatchAborted(_matchId);
    }

    function createChallenge(
        bytes32 _matchId,
        TimeControl _tc,
        address _ephemeralPublicKey
    ) external payable whenNotPaused nonReentrant {
        require(msg.value > 0, "Wager required");
        require(_ephemeralPublicKey != address(0), "Invalid ephemeral key");
        require(matches[_matchId].wagerAmount == 0, "Match ID already exists");

        matches[_matchId] = Match({
            matchId: _matchId,
            playerWhite: payable(msg.sender),
            playerBlack: payable(address(0)),
            wagerAmount: msg.value,
            status: MatchStatus.Created,
            lastMoveTimestamp: block.timestamp,
            timeControl: _tc
        });

        challengeEphemeralKeys[_matchId] = _ephemeralPublicKey;

        emit ChallengeCreated(_matchId, msg.sender, msg.value, _tc, _ephemeralPublicKey);
    }

    function joinChallenge(
        bytes32 _matchId,
        bytes calldata _signature
    ) external payable whenNotPaused nonReentrant {
        Match storage m = matches[_matchId];
        require(m.wagerAmount > 0 && m.status == MatchStatus.Created, "Challenge not available");
        require(m.playerWhite != msg.sender, "Cannot join own challenge");
        require(msg.value == m.wagerAmount, "Stake mismatch");

        address expectedSigner = challengeEphemeralKeys[_matchId];
        require(expectedSigner != address(0), "Not a challenge match");

        // Verify signature produced by app.js: solidityKeccak256(["address", "bytes32"], [userWalletAddress, challengeMatchId])
        bytes32 innerHash = keccak256(abi.encodePacked(msg.sender, _matchId));
        bytes32 ethSignedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", innerHash));
        require(_recoverSigner(ethSignedHash, _signature) == expectedSigner, "Invalid challenge signature");

        m.playerBlack = payable(msg.sender);
        m.status = MatchStatus.Active;
        m.lastMoveTimestamp = block.timestamp;

        emit MatchStarted(_matchId, m.playerWhite, m.playerBlack);
    }

    // =========================================================================
    // 8. ZERO-TRUST ORACLE SETTLEMENT, ABORTS & EIP-712 STATE CHANNELS
    // =========================================================================
    function resolveMatch(bytes32 _matchId, address _winner) external onlyOracle nonReentrant {
        _settleMatchInternal(_matchId, _winner);
    }

    /**
     * @notice Trustless EIP-712 State-Channel Settlement: allows either player to settle
     *         directly on-chain if both players co-signed the terminal state.
     */
    function resolveMatchBySignedState(
        bytes32 _matchId,
        address _winner,
        uint256 _moveCount,
        bytes32 _fenHash,
        bytes calldata _sigWhite,
        bytes calldata _sigBlack
    ) external nonReentrant {
        Match storage m = matches[_matchId];
        require(m.status == MatchStatus.Active, "Match not active");

        bytes32 structHash = keccak256(
            abi.encode(STATE_SETTLEMENT_TYPEHASH, _matchId, _winner, _moveCount, _fenHash)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

        require(_recoverSigner(digest, _sigWhite) == m.playerWhite, "Invalid White signature");
        require(_recoverSigner(digest, _sigBlack) == m.playerBlack, "Invalid Black signature");

        _settleMatchInternal(_matchId, _winner);
    }

    function _settleMatchInternal(bytes32 _matchId, address _winner) internal {
        Match storage m = matches[_matchId];
        require(m.status == MatchStatus.Active, "Match is not active");
        require(
            _winner == address(0) || _winner == m.playerWhite || _winner == m.playerBlack,
            "Invalid winner address"
        );

        m.status = MatchStatus.Resolved;
        uint256 totalPot = m.wagerAmount * 2;

        if (_winner == address(0)) {
            // Draw: refund both players in full without protocol tax
            _transferOrCredit(m.playerWhite, m.wagerAmount);
            _transferOrCredit(m.playerBlack, m.wagerAmount);
            emit MatchResolved(_matchId, address(0), m.wagerAmount);
        } else {
            uint256 tax = (totalPot * TAX_RATE) / BPS_DENOMINATOR;
            uint256 payout = totalPot - tax;
            accumulatedProtocolFees += tax;

            _transferOrCredit(payable(_winner), payout);
            emit MatchResolved(_matchId, _winner, payout);
        }
    }

    function serverAbortMatch(bytes32 _matchId) external onlyOracle nonReentrant {
        Match storage m = matches[_matchId];
        require(m.status == MatchStatus.Active || m.status == MatchStatus.Created, "Cannot abort settled match");

        uint256 wager = m.wagerAmount;
        m.status = MatchStatus.Aborted;

        if (m.playerWhite != address(0)) _transferOrCredit(m.playerWhite, wager);
        if (m.playerBlack != address(0)) _transferOrCredit(m.playerBlack, wager);

        emit MatchAborted(_matchId);
    }

    function refundStalledMatch(bytes32 _matchId) external nonReentrant {
        Match storage m = matches[_matchId];
        require(m.status == MatchStatus.Active, "Match not active");
        require(block.timestamp >= m.lastMoveTimestamp + STALLED_HATCH_TIME, "Stalled hatch timer not expired");
        require(msg.sender == m.playerWhite || msg.sender == m.playerBlack, "Only match players");

        uint256 wager = m.wagerAmount;
        m.status = MatchStatus.Aborted;

        _transferOrCredit(m.playerWhite, wager);
        _transferOrCredit(m.playerBlack, wager);

        emit MatchAborted(_matchId);
    }

    // =========================================================================
    // 9. TOURNAMENT ESCROW ENGINE
    // =========================================================================
    function createTournament(bytes32 _tourneyId, uint256 _entryFee) external whenNotPaused {
        require(_entryFee > 0, "Entry fee must be > 0");
        require(tournaments[_tourneyId].creator == address(0), "Tournament ID already exists");

        tournaments[_tourneyId] = Tournament({
            tourneyId: _tourneyId,
            entryFee: _entryFee,
            totalPot: 0,
            creator: msg.sender,
            isActive: true
        });

        emit TournamentCreated(_tourneyId, _entryFee);
    }

    function joinTournament(bytes32 _tourneyId) external payable whenNotPaused nonReentrant {
        Tournament storage t = tournaments[_tourneyId];
        require(t.isActive, "Tournament not active");
        require(msg.value == t.entryFee, "Exact entry fee required");
        require(!tournamentParticipants[_tourneyId][msg.sender], "Already joined tournament");

        tournamentParticipants[_tourneyId][msg.sender] = true;
        t.totalPot += msg.value;

        emit TournamentJoined(_tourneyId, msg.sender);
    }

    function resolveTournament(bytes32 _tourneyId, address _winner) external onlyOracle nonReentrant {
        Tournament storage t = tournaments[_tourneyId];
        require(t.isActive, "Tournament already resolved");
        require(tournamentParticipants[_tourneyId][_winner], "Winner was not a participant");

        t.isActive = false;
        uint256 pot = t.totalPot;
        t.totalPot = 0;

        uint256 tax = (pot * TAX_RATE) / BPS_DENOMINATOR;
        uint256 payout = pot - tax;
        accumulatedProtocolFees += tax;

        _transferOrCredit(payable(_winner), payout);
        emit TournamentResolved(_tourneyId, _winner, payout);
    }

    // =========================================================================
    // 10. GRIEF-PROOF PAYOUT ENGINE & CRYPTOGRAPHIC HELPERS
    // =========================================================================
    function _transferOrCredit(address payable _to, uint256 _amount) internal {
        if (_amount == 0) return;
        (bool success, ) = _to.call{value: _amount, gas: 30000}("");
        if (!success) {
            claimableBalances[_to] += _amount;
            emit FallbackBalanceCredited(_to, _amount);
        }
    }

    function claimFailedPayout() external nonReentrant {
        uint256 amount = claimableBalances[msg.sender];
        require(amount > 0, "No claimable balance");
        claimableBalances[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Transfer failed");
    }

    function _areColorsCompatible(ColorPref a, ColorPref b) internal pure returns (bool) {
        if (a == ColorPref.Random || b == ColorPref.Random) return true;
        return a != b;
    }

    function _assignColors(
        address payable p1,
        ColorPref pref1,
        address payable p2,
        ColorPref pref2
    ) internal view returns (address payable white, address payable black) {
        if (pref1 == ColorPref.White || pref2 == ColorPref.Black) return (p1, p2);
        if (pref1 == ColorPref.Black || pref2 == ColorPref.White) return (p2, p1);
        if (uint256(keccak256(abi.encodePacked(block.prevrandao, p1, p2))) % 2 == 0) {
            return (p1, p2);
        }
        return (p2, p1);
    }

    function _recoverSigner(bytes32 _ethSignedMessageHash, bytes memory _signature) internal pure returns (address) {
        if (_signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(_signature, 32))
            s := mload(add(_signature, 64))
            v := byte(0, mload(add(_signature, 96)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(_ethSignedMessageHash, v, r, s);
    }
}