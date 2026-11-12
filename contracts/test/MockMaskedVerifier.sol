// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IZcashHeaderRelayReader} from "../interfaces/IZcashHeaderRelayReader.sol";
import {IZcashMaskedPaymentVerifier, ZcashMaskedPayment} from "../interfaces/IZcashMaskedPaymentVerifier.sol";

/// @title MockMaskedVerifier — MOCK, local chain only
/// @notice Stands in for Seam's amount-hidden payment verifier in the desk's unit tests. It checks what the real one
///         checks on chain except the RISC Zero proof: the journal is 192 bytes, version 2, and its anchor is on the
///         relay's best chain. A seal must be the single byte 0x01 (anything else plays the part of a bad proof).
contract MockMaskedVerifier is IZcashMaskedPaymentVerifier {
    address public immutable relay;

    constructor(address relay_) {
        require(block.chainid == 31337, "MOCK: local chain only");
        relay = relay_;
    }

    function verify(bytes calldata journal, bytes calldata seal)
        external
        view
        returns (ZcashMaskedPayment memory p, uint256 anchorWork)
    {
        require(seal.length == 1 && seal[0] == 0x01, "MOCK: bad seal");
        require(journal.length == 192, "MOCK: journal length");
        (uint8 version, uint32 branchId, bytes32 anchor, bytes32 paymentRef, bytes32 receiverCommitment, uint64 masked) =
            abi.decode(journal, (uint8, uint32, bytes32, bytes32, bytes32, uint64));
        require(version == 2, "MOCK: journal version");
        require(IZcashHeaderRelayReader(relay).isInBestChain(anchor), "MOCK: anchor not in best chain");
        p = ZcashMaskedPayment(branchId, anchor, paymentRef, receiverCommitment, masked);
        anchorWork = IZcashHeaderRelayReader(relay).confirmationWork(anchor);
    }
}
