// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ebool, euint8, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {IERC7984} from "./vendor/openzeppelin-confidential/interfaces/IERC7984.sol";
import {IZcashHeaderRelayReader} from "./interfaces/IZcashHeaderRelayReader.sol";
import {IZcashMaskedPaymentVerifier} from "./interfaces/IZcashMaskedPaymentVerifier.sol";

/// @dev The desk's types, shared by ZecDesk and its settlement library (ZecDeskSettle), which runs in the desk's
///      storage through DELEGATECALL. The desk is split in two because Sepolia prices code at about 1,560 gas a byte
///      since Glamsterdam, and one contract of the desk's size would exceed the 2^24 gas a transaction may use.

enum Side {
    Buy,
    Sell
}

enum Status {
    None,
    Open, // quoting
    Resolving, // waiting for the winner (and, on a Buy, M) to be published
    Matched, // Buy: the winner owes the ZEC payment. Sell: the winner owes its funding.
    Funding, // Sell: funding submitted; waiting for `funded` and M to be published
    Funded, // Sell: the user owes the ZEC payment
    Proven, // a payment proof is pending finality
    Settled,
    Refunded,
    NoMatch, // no quote, or none at or above the floor
    Void // Sell: the winner didn't fund, or funded short
}

struct Params {
    uint32 quoteWindowBlocks;
    uint32 resolveTimeout; // seconds a publication may take before the order can be refunded
    uint32 fundWindow; // seconds, Sell
    uint32 payWindow; // seconds of Zcash time, from the match (Buy) or the funding (Sell)
    uint32 proveGrace; // seconds after the pay deadline during which a proof is still accepted
    uint32 finalizeDepth; // relay headers on top of the tip at proof time
    uint32 finalizeDelay; // seconds
    uint32 sellCooldownBlocks; // D-10(a): blocks between two Sell orders of one address
    uint8 maxMakers; // makers snapshotted per order
    uint8 feeShift; // 0 = no fee; else fee = amount >> feeShift
    uint64 maxUsd; // largest Buy, in the token's units
    uint64 maxZat; // largest Sell, in zatoshi
    uint256 minWork; // Zcash work required on top of the anchor (one tier for every order)
}

struct Order {
    Side side;
    Status status;
    uint8 makerCount;
    uint8 quoteCount;
    uint8 winnerSlot;
    address user;
    address winner;
    bytes32 paymentRef;
    bytes32 receiverCommitment; // Buy: the user's; Sell: the winner's, set by `fund`
    uint64 quoteEndBlock;
    uint64 stepAt; // when the current step started (resolution, funding), for the publication timeout
    uint64 fundDeadline;
    uint64 payDeadline;
    uint64 maskedAmount;
    uint64 droppedAt;
    bytes32 anchor;
    uint64 readyHeight;
    uint64 readyTime;
    euint64 size; // Buy: the escrowed cUSDC (the handle the token returned). Sell: the ZEC amount, in zatoshi.
    euint64 floor; // Buy: least zatoshi accepted. Sell: least cUSDC accepted.
    euint64 mask; // Buy: the user's R.
    euint64 best; // running best quote
    euint8 bestSlot; // its maker's slot (NONE while no quote beats 0)
    euint8 winnerHandle; // published: the winner's slot, or NONE
    euint64 maskedHandle; // published: M
    euint64 escrow; // Buy: = size. Sell: the winner's lock (the handle the token returned).
    ebool fundedHandle; // published (Sell): the winner locked its full quote
}

/// @dev What the settlement library needs of the desk's immutables, passed with each call.
struct Env {
    IERC7984 token;
    IZcashMaskedPaymentVerifier verifier;
    IZcashHeaderRelayReader relay;
    address feeRecipient;
    uint32 resolveTimeout;
    uint32 fundWindow;
    uint32 payWindow;
    uint32 proveGrace;
    uint32 finalizeDepth;
    uint32 finalizeDelay;
    uint8 feeShift;
    uint256 minWork;
}

/// @dev The winner slot meaning "no winner".
uint8 constant NO_WINNER = type(uint8).max;

/// @notice The desk's events and errors: no amounts, no Zcash identifiers. ZecDesk inherits them, and its settlement
///         library emits and reverts with the same ones, so they appear from the desk's address.
interface IZecDeskEvents {
    event MakerSet(address indexed maker, bool allowed);
    event PausedSet(bool paused);
    event OrderOpened(
        bytes32 indexed orderId, Side side, address indexed user, bytes32 paymentRef, bytes32 receiverCommitment
    );
    event Quoted(bytes32 indexed orderId, address indexed maker);
    event ResolutionRequested(bytes32 indexed orderId);
    event Matched(bytes32 indexed orderId, address indexed winner, uint64 maskedAmount, uint64 deadline);
    event NoMatch(bytes32 indexed orderId);
    event FundingSubmitted(bytes32 indexed orderId, bytes32 receiverCommitment);
    event Funded(bytes32 indexed orderId, uint64 maskedAmount, uint64 payDeadline);
    event Voided(bytes32 indexed orderId);
    event SettlementPending(bytes32 indexed orderId, bytes32 anchor, uint64 readyHeight, uint64 readyTime);
    event SettlementDropped(bytes32 indexed orderId);
    event Settled(bytes32 indexed orderId);
    event Refunded(bytes32 indexed orderId);

    error BadParams();
    error RelayMismatch();
    error Paused();
    error NonceMismatch();
    error ZeroCommitment();
    error TooSoon();
    error NoMakers();
    error BadStatus();
    error WrongSide();
    error QuoteWindowClosed();
    error QuoteWindowOpen();
    error NotAMaker();
    error AlreadyQuoted();
    error NotWinner();
    error FundWindowClosed();
    error ProveWindowClosed();
    error WrongPaymentRef();
    error WrongReceiver();
    error WrongMaskedAmount();
    error PaidLate();
    error NotEnoughWork();
    error AnchorLeftBestChain();
    error AnchorStillInBestChain();
    error NotFinal();
    error TooManyMakers();
}
