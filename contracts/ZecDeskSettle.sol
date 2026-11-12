// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, ebool, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {IERC7984} from "./vendor/openzeppelin-confidential/interfaces/IERC7984.sol";
import {IZcashHeaderRelayReader} from "./interfaces/IZcashHeaderRelayReader.sol";
import {ZcashMaskedPayment} from "./interfaces/IZcashMaskedPaymentVerifier.sol";
import {Env, IZecDeskEvents, Order, Side, Status} from "./ZecDeskTypes.sol";

/// @title ZecDeskSettle: the desk's funding, settlement and refund steps
/// @notice An external library ZecDesk calls through DELEGATECALL: it runs in the desk's storage, as the desk
///         (`address(this)` is the desk, so FHE access and token transfers are the desk's), with the caller's
///         `msg.sender`. Its events and errors are the desk's (IZecDeskEvents). Research prototype, testnets only.
library ZecDeskSettle {
    // ───────────────────────────── Sell funding ─────────────────────────────

    /// @notice The Sell winner locks its quote (the desk must be its ERC-7984 operator) and gives its receiver
    ///         commitment and its mask R'. The publication of `funded` and of M = Z + R' is requested.
    function fund(
        Order storage o,
        bytes32 orderId,
        bytes32 receiverCommitment,
        externalEuint64 mask,
        bytes calldata inputProof,
        IERC7984 token
    ) external {
        if (o.side != Side.Sell) revert IZecDeskEvents.WrongSide();
        if (o.status != Status.Matched) revert IZecDeskEvents.BadStatus();
        if (msg.sender != o.winner) revert IZecDeskEvents.NotWinner();
        if (block.timestamp > o.fundDeadline) revert IZecDeskEvents.FundWindowClosed();
        if (receiverCommitment == bytes32(0)) revert IZecDeskEvents.ZeroCommitment();

        euint64 r = FHE.fromExternal(mask, inputProof);
        FHE.allowTransient(o.best, address(token));
        euint64 locked = token.confidentialTransferFrom(msg.sender, address(this), o.best);
        ebool funded = FHE.eq(locked, o.best);
        euint64 m = FHE.add(o.size, r);
        _keep(locked, msg.sender);
        FHE.allowThis(funded);
        FHE.makePubliclyDecryptable(funded);
        FHE.allowThis(m);
        FHE.makePubliclyDecryptable(m);
        o.escrow = locked;
        o.fundedHandle = funded;
        o.maskedHandle = m;
        o.receiverCommitment = receiverCommitment;
        o.status = Status.Funding;
        o.stepAt = uint64(block.timestamp);
        emit IZecDeskEvents.FundingSubmitted(orderId, receiverCommitment);
    }

    /// @notice A Sell's funding: `cleartexts` = abi.encode(bool funded, uint64 maskedAmount). A short funding voids the
    ///         order and returns whatever moved (0 under ERC-7984's all-or-nothing transfer).
    function publishFunding(
        Order storage o,
        bytes32 orderId,
        bytes calldata cleartexts,
        bytes calldata decryptionProof,
        Env memory e
    ) external {
        if (o.side != Side.Sell) revert IZecDeskEvents.WrongSide();
        if (o.status != Status.Funding) revert IZecDeskEvents.BadStatus();
        bytes32[] memory hs = new bytes32[](2);
        hs[0] = ebool.unwrap(o.fundedHandle);
        hs[1] = euint64.unwrap(o.maskedHandle);
        FHE.checkSignatures(hs, cleartexts, decryptionProof);
        (bool funded, uint64 m) = abi.decode(cleartexts, (bool, uint64));
        if (!funded) {
            o.status = Status.Void;
            _pay(e.token, o.escrow, o.winner);
            emit IZecDeskEvents.Voided(orderId);
            return;
        }
        o.maskedAmount = m;
        o.payDeadline = uint64(block.timestamp) + e.payWindow;
        o.status = Status.Funded;
        emit IZecDeskEvents.Funded(orderId, m, o.payDeadline);
    }

    // ───────────────────────────── settlement ─────────────────────────────

    /// @notice A payment proof, until payDeadline + proveGrace (reopened after a drop). The payment is judged on Zcash
    ///         time: the anchor follows the payment's block, so an anchor at or before the deadline proves the payment
    ///         was mined in time.
    function proveSettlement(
        Order storage o,
        bytes32 orderId,
        bytes calldata journal,
        bytes calldata seal,
        Env memory e
    ) external {
        if (o.status != (o.side == Side.Buy ? Status.Matched : Status.Funded)) revert IZecDeskEvents.BadStatus();
        if (block.timestamp > proveDeadline(o, e.proveGrace)) revert IZecDeskEvents.ProveWindowClosed();

        (ZcashMaskedPayment memory p, uint256 work) = e.verifier.verify(journal, seal);
        if (p.paymentRef != o.paymentRef) revert IZecDeskEvents.WrongPaymentRef();
        if (p.receiverCommitment != o.receiverCommitment) revert IZecDeskEvents.WrongReceiver();
        if (p.maskedAmount != o.maskedAmount) revert IZecDeskEvents.WrongMaskedAmount();
        IZcashHeaderRelayReader.HeaderInfo memory h = e.relay.headerOf(p.anchor);
        if (!h.known || h.time > o.payDeadline) revert IZecDeskEvents.PaidLate();
        if (work < e.minWork) revert IZecDeskEvents.NotEnoughWork();

        (, uint256 tipHeight,) = e.relay.bestChainTip();
        o.anchor = p.anchor;
        o.readyHeight = uint64(tipHeight + e.finalizeDepth);
        o.readyTime = uint64(block.timestamp + e.finalizeDelay);
        o.status = Status.Proven;
        emit IZecDeskEvents.SettlementPending(orderId, p.anchor, o.readyHeight, o.readyTime);
    }

    /// @notice After finality: pays the escrow, less the fee, to the winner (Buy) or the user (Sell).
    function finalizeSettlement(Order storage o, bytes32 orderId, Env memory e) external {
        if (o.status != Status.Proven) revert IZecDeskEvents.BadStatus();
        if (!e.relay.isInBestChain(o.anchor)) revert IZecDeskEvents.AnchorLeftBestChain();
        (, uint256 tipHeight,) = e.relay.bestChainTip();
        if (tipHeight < o.readyHeight || block.timestamp < o.readyTime) revert IZecDeskEvents.NotFinal();
        if (e.relay.confirmationWork(o.anchor) < e.minWork) revert IZecDeskEvents.NotEnoughWork();
        o.status = Status.Settled;
        _payWithFee(e, o.escrow, o.side == Side.Buy ? o.winner : o.user);
        emit IZecDeskEvents.Settled(orderId);
    }

    /// @notice Drops a pending settlement whose anchor left the best chain; the proving window reopens.
    function dropSettlement(Order storage o, bytes32 orderId, IZcashHeaderRelayReader relay) external {
        if (o.status != Status.Proven) revert IZecDeskEvents.BadStatus();
        if (relay.isInBestChain(o.anchor)) revert IZecDeskEvents.AnchorStillInBestChain();
        o.anchor = bytes32(0);
        o.readyHeight = 0;
        o.readyTime = 0;
        o.droppedAt = uint64(block.timestamp);
        o.status = o.side == Side.Buy ? Status.Matched : Status.Funded;
        emit IZecDeskEvents.SettlementDropped(orderId);
    }

    /// @notice Ends an order that can't settle and returns its escrow (see ZecDesk.refund for the cases).
    function refund(Order storage o, bytes32 orderId, Env memory e) external {
        Status s = o.status;
        bool buy = o.side == Side.Buy;

        if (s == Status.NoMatch) {
            o.status = Status.Refunded;
            if (buy) _pay(e.token, o.escrow, o.user);
            emit IZecDeskEvents.Refunded(orderId);
            return;
        }
        if (s == Status.Resolving || s == Status.Funding) {
            if (block.timestamp <= uint256(o.stepAt) + e.resolveTimeout) revert IZecDeskEvents.TooSoon();
            o.status = Status.Refunded;
            if (buy) _pay(e.token, o.escrow, o.user);
            else if (s == Status.Funding) _pay(e.token, o.escrow, o.winner);
            emit IZecDeskEvents.Refunded(orderId);
            return;
        }
        if (!buy && s == Status.Matched) {
            if (block.timestamp <= o.fundDeadline) revert IZecDeskEvents.TooSoon();
            o.status = Status.Void;
            emit IZecDeskEvents.Voided(orderId);
            return;
        }
        if ((buy && s == Status.Matched) || (!buy && s == Status.Funded)) {
            if (block.timestamp <= proveDeadline(o, e.proveGrace)) revert IZecDeskEvents.TooSoon();
            o.status = Status.Refunded;
            _pay(e.token, o.escrow, buy ? o.user : o.winner);
            emit IZecDeskEvents.Refunded(orderId);
            return;
        }
        revert IZecDeskEvents.BadStatus();
    }

    // ───────────────────────────── helpers ─────────────────────────────

    /// @notice The last second a proof is accepted: payDeadline, or the last drop, plus the grace.
    function proveDeadline(Order storage o, uint32 proveGrace) internal view returns (uint256) {
        uint256 base = o.payDeadline > o.droppedAt ? o.payDeadline : o.droppedAt;
        return base + proveGrace;
    }

    function _keep(euint64 h, address party) private {
        FHE.allowThis(h);
        FHE.allow(h, party);
    }

    function _pay(IERC7984 token, euint64 amount, address to) private {
        FHE.allowTransient(amount, address(token));
        token.confidentialTransfer(to, amount);
    }

    function _payWithFee(Env memory e, euint64 amount, address to) private {
        if (e.feeShift == 0) {
            _pay(e.token, amount, to);
            return;
        }
        euint64 fee = FHE.shr(amount, e.feeShift);
        euint64 net = FHE.sub(amount, fee);
        _pay(e.token, net, to);
        _pay(e.token, fee, e.feeRecipient);
    }
}
