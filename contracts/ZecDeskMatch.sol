// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, ebool, euint8, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {IERC7984} from "./vendor/openzeppelin-confidential/interfaces/IERC7984.sol";
import {IZecDeskEvents, NO_WINNER, Order, Side, Status} from "./ZecDeskTypes.sol";

/// @title ZecDeskMatch: the desk's quoting, resolution and the publication of its result
/// @notice An external library ZecDesk calls through DELEGATECALL: it runs in the desk's storage, as the desk, with the
///         caller's `msg.sender` (an encrypted quote's input proof is bound to the desk and to the maker who sends
///         it). Its events and errors are the desk's (IZecDeskEvents). Research prototype, testnets only.
library ZecDeskMatch {
    // ───────────────────────────── opening ─────────────────────────────

    /// @notice A new Buy's encrypted inputs: locks up to `maxUsd` of the caller's cUSDC (a short balance moves 0), and
    ///         keeps the floor and the mask; starts the running best at 0 with no maker.
    function lockBuy(
        Order storage o,
        externalEuint64 amount,
        externalEuint64 floorZat,
        externalEuint64 mask,
        bytes calldata inputProof,
        IERC7984 token,
        uint64 maxUsd
    ) external {
        _startBest(o);
        euint64 a = FHE.min(FHE.fromExternal(amount, inputProof), maxUsd);
        FHE.allowTransient(a, address(token));
        euint64 locked = token.confidentialTransferFrom(msg.sender, address(this), a);
        o.size = locked;
        o.escrow = locked;
        o.floor = FHE.fromExternal(floorZat, inputProof);
        o.mask = FHE.fromExternal(mask, inputProof);
        _keep(o.size, msg.sender);
        _keep(o.floor, msg.sender);
        _keep(o.mask, msg.sender);
    }

    /// @notice A new Sell's encrypted inputs: the zatoshi (at most `maxZat`) and the cUSDC floor.
    function lockSell(
        Order storage o,
        externalEuint64 zat,
        externalEuint64 floorUsd,
        bytes calldata inputProof,
        uint64 maxZat
    ) external {
        _startBest(o);
        o.size = FHE.min(FHE.fromExternal(zat, inputProof), maxZat);
        o.floor = FHE.fromExternal(floorUsd, inputProof);
        _keep(o.size, msg.sender);
        _keep(o.floor, msg.sender);
    }

    /// @notice Copies up to `maxMakers` allowlisted makers into the order and lets them decrypt its size (they price
    ///         from it). A maker can't quote its own order.
    function snapshot(
        Order storage o,
        address[] storage makers,
        mapping(uint8 => address) storage makerAt,
        mapping(address => uint8) storage slotPlusOne,
        uint8 maxMakers
    ) external {
        uint256 n = makers.length;
        uint8 k;
        for (uint256 i; i < n && k < maxMakers; ++i) {
            address mk = makers[i];
            if (mk == o.user) continue;
            makerAt[k] = mk;
            slotPlusOne[mk] = k + 1;
            FHE.allow(o.size, mk);
            ++k;
        }
        if (k == 0) revert IZecDeskEvents.NoMakers();
        o.makerCount = k;
    }

    function _startBest(Order storage o) private {
        o.best = FHE.asEuint64(0);
        o.bestSlot = FHE.asEuint8(NO_WINNER);
        FHE.allowThis(o.best);
        FHE.allowThis(o.bestSlot);
    }

    function _keep(euint64 h, address party) private {
        FHE.allowThis(h);
        FHE.allow(h, party);
    }

    // ───────────────────────────── quoting and resolution ─────────────────────────────

    /// @notice A snapshotted maker's encrypted quote: zatoshi it pays (Buy) or cUSDC it pays (Sell). Once per order.
    ///         The running best is updated here, in the maker's own transaction, so resolution costs the same whatever
    ///         the number of makers. Ties keep the earlier quote.
    function quote(
        Order storage o,
        mapping(address => uint8) storage slotPlusOneOf,
        mapping(address => bool) storage quoted,
        bytes32 orderId,
        externalEuint64 value,
        bytes calldata inputProof
    ) external {
        if (o.status != Status.Open) revert IZecDeskEvents.BadStatus();
        if (block.number > o.quoteEndBlock) revert IZecDeskEvents.QuoteWindowClosed();
        uint8 slotPlusOne = slotPlusOneOf[msg.sender];
        if (slotPlusOne == 0) revert IZecDeskEvents.NotAMaker();
        if (quoted[msg.sender]) revert IZecDeskEvents.AlreadyQuoted();
        quoted[msg.sender] = true;
        o.quoteCount += 1;

        euint64 q = FHE.fromExternal(value, inputProof);
        ebool better = FHE.gt(q, o.best);
        o.best = FHE.select(better, q, o.best);
        o.bestSlot = FHE.select(better, FHE.asEuint8(slotPlusOne - 1), o.bestSlot);
        FHE.allowThis(o.best);
        FHE.allowThis(o.bestSlot);
        emit IZecDeskEvents.Quoted(orderId, msg.sender);
    }

    /// @notice After the quote window, anyone: compares the best quote with the floor under FHE and requests the
    ///         publication of the winner's slot (NONE if no quote meets the floor) and, on a Buy, of M = best + R.
    function resolve(Order storage o, bytes32 orderId) external {
        if (o.status != Status.Open) revert IZecDeskEvents.BadStatus();
        if (block.number <= o.quoteEndBlock) revert IZecDeskEvents.QuoteWindowOpen();
        if (o.quoteCount == 0) {
            o.status = Status.NoMatch;
            emit IZecDeskEvents.NoMatch(orderId);
            return;
        }
        ebool ok = FHE.ge(o.best, o.floor);
        euint8 w = FHE.select(ok, o.bestSlot, FHE.asEuint8(NO_WINNER));
        FHE.allowThis(w);
        FHE.makePubliclyDecryptable(w);
        o.winnerHandle = w;
        if (o.side == Side.Buy) {
            euint64 m = FHE.add(o.best, o.mask);
            FHE.allowThis(m);
            FHE.makePubliclyDecryptable(m);
            o.maskedHandle = m;
        }
        FHE.allow(o.best, o.user); // the user sees the best quote
        o.status = Status.Resolving;
        o.stepAt = uint64(block.timestamp);
        emit IZecDeskEvents.ResolutionRequested(orderId);
    }

    // ───────────────────────────── resolution ─────────────────────────────

    /// @notice A Buy's resolution: `cleartexts` = abi.encode(uint8 winnerSlot, uint64 maskedAmount), with the KMS
    ///         decryption proof. Runs once per order (the status guards replays).
    function publishBuyResolution(
        Order storage o,
        mapping(uint8 => address) storage makerAt,
        bytes32 orderId,
        bytes calldata cleartexts,
        bytes calldata decryptionProof,
        uint32 payWindow
    ) external {
        if (o.side != Side.Buy) revert IZecDeskEvents.WrongSide();
        if (o.status != Status.Resolving) revert IZecDeskEvents.BadStatus();
        bytes32[] memory hs = new bytes32[](2);
        hs[0] = euint8.unwrap(o.winnerHandle);
        hs[1] = euint64.unwrap(o.maskedHandle);
        FHE.checkSignatures(hs, cleartexts, decryptionProof);
        (uint8 w, uint64 m) = abi.decode(cleartexts, (uint8, uint64));
        if (w == NO_WINNER || w >= o.makerCount) {
            o.status = Status.NoMatch;
            emit IZecDeskEvents.NoMatch(orderId);
            return;
        }
        o.winnerSlot = w;
        o.winner = makerAt[w];
        o.maskedAmount = m;
        o.payDeadline = uint64(block.timestamp) + payWindow;
        o.status = Status.Matched;
        emit IZecDeskEvents.Matched(orderId, o.winner, m, o.payDeadline);
    }

    /// @notice A Sell's resolution: `cleartexts` = abi.encode(uint8 winnerSlot). Its M comes later, with the funding.
    function publishSellResolution(
        Order storage o,
        mapping(uint8 => address) storage makerAt,
        bytes32 orderId,
        bytes calldata cleartexts,
        bytes calldata decryptionProof,
        uint32 fundWindow
    ) external {
        if (o.side != Side.Sell) revert IZecDeskEvents.WrongSide();
        if (o.status != Status.Resolving) revert IZecDeskEvents.BadStatus();
        bytes32[] memory hs = new bytes32[](1);
        hs[0] = euint8.unwrap(o.winnerHandle);
        FHE.checkSignatures(hs, cleartexts, decryptionProof);
        uint8 w = abi.decode(cleartexts, (uint8));
        if (w == NO_WINNER || w >= o.makerCount) {
            o.status = Status.NoMatch;
            emit IZecDeskEvents.NoMatch(orderId);
            return;
        }
        o.winnerSlot = w;
        o.winner = makerAt[w];
        o.fundDeadline = uint64(block.timestamp) + fundWindow;
        o.status = Status.Matched;
        emit IZecDeskEvents.Matched(orderId, o.winner, 0, o.fundDeadline);
    }

}
