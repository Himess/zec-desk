// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

/// @notice A shielded Ironwood payment, as a Seam amount-hidden payment proof (journal version 2) states it. Same as
///         Seam's `ZcashPayment`, with the amount replaced by a masked value: the guest proved `value >= M - R`
///         (mod 2^64), where R = first 8 bytes of keccak256("seam/amount-mask/v1" || salt32 || paymentRef), and the
///         salt is the one `receiverCommitment` binds.
/// @dev Mirrors the interface planned for Seam (docs/PHASE0-DESIGN.md § 3.3); kept here until Seam ships it.
struct ZcashMaskedPayment {
    uint32 branchId;
    bytes32 anchor;
    bytes32 paymentRef;
    bytes32 receiverCommitment;
    uint64 maskedAmount;
}

/// @title IZcashMaskedPaymentVerifier
/// @notice Checks a Seam amount-hidden payment proof: journal version 2, an allowed branch, the pinned selector and
///         image id through RISC Zero's router, and the anchor on the relay's best chain. Stateless; finality and
///         deadlines are the caller's.
interface IZcashMaskedPaymentVerifier {
    function relay() external view returns (address);

    function verify(bytes calldata journal, bytes calldata seal)
        external
        view
        returns (ZcashMaskedPayment memory payment, uint256 anchorWork);
}
