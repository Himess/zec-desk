// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, ebool, euint8, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC7984} from "./vendor/openzeppelin-confidential/interfaces/IERC7984.sol";
import {IZcashHeaderRelayReader} from "./interfaces/IZcashHeaderRelayReader.sol";
import {IZcashMaskedPaymentVerifier} from "./interfaces/IZcashMaskedPaymentVerifier.sol";
import {Env, IZecDeskEvents, NO_WINNER, Order, Params, Side, Status} from "./ZecDeskTypes.sol";
import {ZecDeskMatch} from "./ZecDeskMatch.sol";
import {ZecDeskSettle} from "./ZecDeskSettle.sol";

/// @title ZecDesk: confidential swaps between shielded ZEC and an ERC-7984 confidential dollar
/// @notice Research prototype, testnets only, not audited. docs/PHASE0-DESIGN.md is the design.
///         - Buy: the user locks cUSDC; allowlisted makers quote encrypted ZEC amounts; the best quote at or above the
///           user's encrypted floor wins; the winner pays shielded ZEC to the user's committed receiver; a Seam
///           amount-hidden payment proof releases the cUSDC to the winner.
///         - Sell: the user states an encrypted ZEC amount and an encrypted cUSDC floor; makers quote cUSDC; the winner
///           locks its quote; the user pays the ZEC to the winner's committed receiver; a proof releases the cUSDC to
///           the user.
///         Amounts stay encrypted. The only value published about an amount is the masked M = Z + R (mod 2^64), where
///         R is known only to the two counterparties, so M says nothing about Z.
/// @dev Rules (docs/PHASE0-DESIGN.md § 17 of the brief): no Zcash transaction id, note, nullifier, address or viewing
///      key ever reaches this contract; receivers appear only as salted commitments; every order ends settled or
///      refunded.
contract ZecDesk is ZamaEthereumConfig, Ownable2Step, ReentrancyGuard, IZecDeskEvents {
    // ───────────────────────────── types ─────────────────────────────

    /// @notice An order as clients read it. Handles are returned as bytes32 so a party with access can decrypt them.
    struct OrderView {
        Side side;
        Status status;
        uint8 makerCount;
        uint8 quoteCount;
        uint8 winnerSlot;
        address user;
        address winner;
        bytes32 paymentRef;
        bytes32 receiverCommitment;
        uint64 quoteEndBlock;
        uint64 fundDeadline;
        uint64 payDeadline;
        uint64 maskedAmount;
        bytes32 anchor;
        uint64 readyHeight;
        uint64 readyTime;
        bytes32 sizeHandle;
        bytes32 bestHandle;
        bytes32 escrowHandle;
        uint64 stepAt; // when the pending publication was requested (RESOLVE_TIMEOUT runs from it)
        uint64 proveDeadline; // the last second a proof is accepted (payDeadline, or the last drop, + PROVE_GRACE)
    }

    // ───────────────────────────── constants and immutables ─────────────────────────────

    uint8 public constant NONE = NO_WINNER;
    uint8 public constant MAX_ALLOWLIST = 32;

    IERC7984 public immutable TOKEN;
    IZcashMaskedPaymentVerifier public immutable VERIFIER;
    IZcashHeaderRelayReader public immutable RELAY;
    address public immutable FEE_RECIPIENT;

    uint32 public immutable QUOTE_WINDOW_BLOCKS;
    uint32 public immutable RESOLVE_TIMEOUT;
    uint32 public immutable FUND_WINDOW;
    uint32 public immutable PAY_WINDOW;
    uint32 public immutable PROVE_GRACE;
    uint32 public immutable FINALIZE_DEPTH;
    uint32 public immutable FINALIZE_DELAY;
    uint32 public immutable SELL_COOLDOWN_BLOCKS;
    uint8 public immutable MAX_MAKERS;
    uint8 public immutable FEE_SHIFT;
    uint64 public immutable MAX_USD;
    uint64 public immutable MAX_ZAT;
    uint256 public immutable MIN_WORK;

    // ───────────────────────────── storage ─────────────────────────────

    address[] private _makers;
    mapping(address => bool) public isMaker;
    bool public paused;

    mapping(address => uint64) public nonces;
    mapping(address => uint64) public lastSellBlock;
    mapping(bytes32 => Order) private _orders;
    mapping(bytes32 => mapping(uint8 => address)) private _makerAt;
    mapping(bytes32 => mapping(address => uint8)) private _slotPlusOne;
    mapping(bytes32 => mapping(address => bool)) private _quoted;

    constructor(
        IERC7984 token,
        IZcashMaskedPaymentVerifier verifier,
        IZcashHeaderRelayReader relay,
        Params memory p,
        address feeRecipient,
        address admin
    ) Ownable(admin) {
        if (address(token) == address(0) || address(verifier) == address(0) || address(relay) == address(0)) revert BadParams();
        if (verifier.relay() != address(relay)) revert RelayMismatch();
        if (p.quoteWindowBlocks == 0 || p.payWindow == 0 || p.maxMakers == 0 || p.maxMakers > MAX_ALLOWLIST) revert BadParams();
        if (p.resolveTimeout == 0 || p.fundWindow == 0 || p.maxUsd == 0 || p.maxZat == 0) revert BadParams();
        if (p.feeShift != 0 && (p.feeShift < 4 || feeRecipient == address(0))) revert BadParams(); // at most 6.25 %
        TOKEN = token;
        VERIFIER = verifier;
        RELAY = relay;
        FEE_RECIPIENT = feeRecipient;
        QUOTE_WINDOW_BLOCKS = p.quoteWindowBlocks;
        RESOLVE_TIMEOUT = p.resolveTimeout;
        FUND_WINDOW = p.fundWindow;
        PAY_WINDOW = p.payWindow;
        PROVE_GRACE = p.proveGrace;
        FINALIZE_DEPTH = p.finalizeDepth;
        FINALIZE_DELAY = p.finalizeDelay;
        SELL_COOLDOWN_BLOCKS = p.sellCooldownBlocks;
        MAX_MAKERS = p.maxMakers;
        FEE_SHIFT = p.feeShift;
        MAX_USD = p.maxUsd;
        MAX_ZAT = p.maxZat;
        MIN_WORK = p.minWork;
    }

    // ───────────────────────────── admin (new orders only) ─────────────────────────────

    /// @notice Allowlists or removes a maker. Orders already open keep the makers they snapshotted.
    function setMaker(address maker, bool allowed) external onlyOwner {
        if (maker == address(0)) revert BadParams();
        if (allowed == isMaker[maker]) return;
        isMaker[maker] = allowed;
        if (allowed) {
            if (_makers.length >= MAX_ALLOWLIST) revert TooManyMakers();
            _makers.push(maker);
        } else {
            uint256 n = _makers.length;
            for (uint256 i; i < n; ++i) {
                if (_makers[i] == maker) {
                    _makers[i] = _makers[n - 1];
                    _makers.pop();
                    break;
                }
            }
        }
        emit MakerSet(maker, allowed);
    }

    /// @notice Stops new orders. Open orders run to their end as usual.
    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    // ───────────────────────────── opening ─────────────────────────────

    /// @notice Opens a Buy: locks up to MAX_USD of the caller's cUSDC (the desk must be the caller's ERC-7984 operator).
    /// @param expectedNonce the caller's next nonce; the mask is derived from the order's paymentRef, so a stale nonce
    ///        reverts instead of locking a wrong mask.
    /// @param amount cUSDC to spend; floorZat the least zatoshi accepted; mask R (derived from the receiver salt and the
    ///        paymentRef, see IZcashMaskedPaymentVerifier); all three under one input proof.
    /// @param receiverCommitment keccak256(salt32 || receiver43) of a fresh Ironwood receiver of the caller's.
    function openBuy(
        uint64 expectedNonce,
        externalEuint64 amount,
        externalEuint64 floorZat,
        externalEuint64 mask,
        bytes calldata inputProof,
        bytes32 receiverCommitment
    ) external nonReentrant returns (bytes32 orderId) {
        if (receiverCommitment == bytes32(0)) revert ZeroCommitment();
        Order storage o;
        (orderId, o) = _newOrder(expectedNonce, Side.Buy);
        o.receiverCommitment = receiverCommitment;

        ZecDeskMatch.lockBuy(o, amount, floorZat, mask, inputProof, TOKEN, MAX_USD);

        ZecDeskMatch.snapshot(o, _makers, _makerAt[orderId], _slotPlusOne[orderId], MAX_MAKERS);
        emit OrderOpened(orderId, Side.Buy, msg.sender, o.paymentRef, receiverCommitment);
    }

    /// @notice Opens a Sell of up to MAX_ZAT zatoshi for at least `floorUsd` cUSDC. Nothing is locked by the user.
    function openSell(uint64 expectedNonce, externalEuint64 zat, externalEuint64 floorUsd, bytes calldata inputProof)
        external
        nonReentrant
        returns (bytes32 orderId)
    {
        uint64 last = lastSellBlock[msg.sender];
        if (last != 0 && block.number < uint256(last) + SELL_COOLDOWN_BLOCKS) revert TooSoon();
        lastSellBlock[msg.sender] = uint64(block.number);
        Order storage o;
        (orderId, o) = _newOrder(expectedNonce, Side.Sell);

        ZecDeskMatch.lockSell(o, zat, floorUsd, inputProof, MAX_ZAT);

        ZecDeskMatch.snapshot(o, _makers, _makerAt[orderId], _slotPlusOne[orderId], MAX_MAKERS);
        emit OrderOpened(orderId, Side.Sell, msg.sender, o.paymentRef, bytes32(0));
    }

    // ───────────────────────────── quoting and resolution ─────────────────────────────

    /// @notice A snapshotted maker's encrypted quote: zatoshi it pays (Buy) or cUSDC it pays (Sell). Once per order.
    ///         The running best is updated here, in the maker's own transaction, so resolution costs the same whatever
    ///         the number of makers. Ties keep the earlier quote.
    function quote(bytes32 orderId, externalEuint64 value, bytes calldata inputProof) external nonReentrant {
        ZecDeskMatch.quote(
            _orders[orderId], _slotPlusOne[orderId], _quoted[orderId], orderId, value, inputProof
        );
    }

    /// @notice After the quote window, anyone: compares the best quote with the floor under FHE and requests the
    ///         publication of the winner's slot (NONE if no quote meets the floor) and, on a Buy, of M = best + R.
    function resolve(bytes32 orderId) external nonReentrant {
        ZecDeskMatch.resolve(_orders[orderId], orderId);
    }

    /// @notice Publishes a Buy's resolution: `cleartexts` = abi.encode(uint8 winnerSlot, uint64 maskedAmount), with
    ///         the KMS decryption proof. Runs once per order (the status guards replays).
    function publishBuyResolution(bytes32 orderId, bytes calldata cleartexts, bytes calldata decryptionProof)
        external
        nonReentrant
    {
        ZecDeskMatch.publishBuyResolution(
            _orders[orderId], _makerAt[orderId], orderId, cleartexts, decryptionProof, PAY_WINDOW
        );
    }

    /// @notice Publishes a Sell's resolution: `cleartexts` = abi.encode(uint8 winnerSlot). A Sell's M comes later, with
    ///         the winner's funding.
    function publishSellResolution(bytes32 orderId, bytes calldata cleartexts, bytes calldata decryptionProof)
        external
        nonReentrant
    {
        ZecDeskMatch.publishSellResolution(
            _orders[orderId], _makerAt[orderId], orderId, cleartexts, decryptionProof, FUND_WINDOW
        );
    }

    // ───────────────────────────── Sell funding ─────────────────────────────

    /// @notice The Sell winner locks its quote (the desk must be its ERC-7984 operator) and gives its receiver
    ///         commitment and its mask R'. The desk requests the publication of `funded` (the full quote moved) and
    ///         of M = Z + R'.
    function fund(bytes32 orderId, bytes32 receiverCommitment, externalEuint64 mask, bytes calldata inputProof)
        external
        nonReentrant
    {
        ZecDeskSettle.fund(_orders[orderId], orderId, receiverCommitment, mask, inputProof, TOKEN);
    }

    /// @notice Publishes a Sell's funding: `cleartexts` = abi.encode(bool funded, uint64 maskedAmount). A short funding
    ///         voids the order and returns whatever moved (0 under ERC-7984's all-or-nothing transfer).
    function publishFunding(bytes32 orderId, bytes calldata cleartexts, bytes calldata decryptionProof)
        external
        nonReentrant
    {
        ZecDeskSettle.publishFunding(_orders[orderId], orderId, cleartexts, decryptionProof, _env());
    }

    // ───────────────────────────── settlement ─────────────────────────────

    /// @notice Anyone may submit the payment proof, until payDeadline + PROVE_GRACE (reopened after a drop). The payment
    ///         is judged on Zcash time: the anchor follows the payment's block, so an anchor at or before the deadline
    ///         proves the payment was mined in time.
    function proveSettlement(bytes32 orderId, bytes calldata journal, bytes calldata seal) external nonReentrant {
        ZecDeskSettle.proveSettlement(_orders[orderId], orderId, journal, seal, _env());
    }

    /// @notice After finality, anyone: pays the escrow, less the fee, to the winner (Buy) or the user (Sell).
    function finalizeSettlement(bytes32 orderId) external nonReentrant {
        ZecDeskSettle.finalizeSettlement(_orders[orderId], orderId, _env());
    }

    /// @notice Anyone: drops a pending settlement whose anchor left the best chain. The payment can be proven again
    ///         with an anchor on the new best chain; the proving window reopens.
    function dropSettlement(bytes32 orderId) external nonReentrant {
        ZecDeskSettle.dropSettlement(_orders[orderId], orderId, RELAY);
    }

    /// @notice Anyone: ends an order that can't settle and returns its escrow.
    ///         - NoMatch: the Buy escrow to the user.
    ///         - A publication that never came (RESOLVE_TIMEOUT): Resolving returns the Buy escrow to the user; Funding
    ///           returns the Sell lock to the winner.
    ///         - Sell, Matched, past fundDeadline: Void (the winner never funded).
    ///         - Matched (Buy) or Funded (Sell) past payDeadline + PROVE_GRACE with nothing pending: the escrow back to
    ///           the user (Buy) or the winner (Sell).
    function refund(bytes32 orderId) external nonReentrant {
        ZecDeskSettle.refund(_orders[orderId], orderId, _env());
    }

    // ───────────────────────────── views ─────────────────────────────

    function getOrder(bytes32 orderId) external view returns (OrderView memory v) {
        Order storage o = _orders[orderId];
        v.side = o.side;
        v.status = o.status;
        v.makerCount = o.makerCount;
        v.quoteCount = o.quoteCount;
        v.winnerSlot = o.winnerSlot;
        v.user = o.user;
        v.winner = o.winner;
        v.paymentRef = o.paymentRef;
        v.receiverCommitment = o.receiverCommitment;
        v.quoteEndBlock = o.quoteEndBlock;
        v.fundDeadline = o.fundDeadline;
        v.payDeadline = o.payDeadline;
        v.maskedAmount = o.maskedAmount;
        v.anchor = o.anchor;
        v.readyHeight = o.readyHeight;
        v.readyTime = o.readyTime;
        v.sizeHandle = euint64.unwrap(o.size);
        v.bestHandle = euint64.unwrap(o.best);
        v.escrowHandle = euint64.unwrap(o.escrow);
        v.stepAt = o.stepAt;
        v.proveDeadline = o.payDeadline == 0 ? 0 : uint64(ZecDeskSettle.proveDeadline(o, PROVE_GRACE));
    }

    /// @notice Handles waiting for publication: the winner slot, M, and (Sell) the funded flag.
    function publicationHandles(bytes32 orderId) external view returns (bytes32 winner, bytes32 masked, bytes32 funded) {
        Order storage o = _orders[orderId];
        return (euint8.unwrap(o.winnerHandle), euint64.unwrap(o.maskedHandle), ebool.unwrap(o.fundedHandle));
    }

    function makerAt(bytes32 orderId, uint8 slot) external view returns (address) {
        return _makerAt[orderId][slot];
    }

    function makers() external view returns (address[] memory) {
        return _makers;
    }

    /// @notice The order id and payment reference a caller's next order will have.
    function nextOrder(address user) external view returns (bytes32 orderId, bytes32 paymentRef) {
        orderId = _orderId(user, nonces[user]);
        paymentRef = _paymentRef(orderId);
    }

    // ───────────────────────────── internals ─────────────────────────────

    function _newOrder(uint64 expectedNonce, Side side) private returns (bytes32 orderId, Order storage o) {
        if (paused) revert Paused();
        uint64 n = nonces[msg.sender];
        if (n != expectedNonce) revert NonceMismatch();
        if (_makers.length == 0) revert NoMakers();
        nonces[msg.sender] = n + 1;
        orderId = _orderId(msg.sender, n);
        o = _orders[orderId];
        o.side = side;
        o.status = Status.Open;
        o.user = msg.sender;
        o.winnerSlot = NONE;
        o.paymentRef = _paymentRef(orderId);
        o.quoteEndBlock = uint64(block.number + QUOTE_WINDOW_BLOCKS);
    }

    function _orderId(address user, uint64 n) private view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), user, n));
    }

    function _paymentRef(bytes32 orderId) private view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), orderId));
    }

    /// @dev The immutables the settlement library needs.
    function _env() private view returns (Env memory) {
        return Env({
            token: TOKEN,
            verifier: VERIFIER,
            relay: RELAY,
            feeRecipient: FEE_RECIPIENT,
            resolveTimeout: RESOLVE_TIMEOUT,
            fundWindow: FUND_WINDOW,
            payWindow: PAY_WINDOW,
            proveGrace: PROVE_GRACE,
            finalizeDepth: FINALIZE_DEPTH,
            finalizeDelay: FINALIZE_DELAY,
            feeShift: FEE_SHIFT,
            minWork: MIN_WORK
        });
    }
}
