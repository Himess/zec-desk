// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IZcashHeaderRelayReader} from "../interfaces/IZcashHeaderRelayReader.sol";
import {ZcashMaskedPayment} from "../interfaces/IZcashMaskedPaymentVerifier.sol";

/// @title NoProofRelay — MOCK, a relay that knows no header
/// @notice For a throwaway desk on a public testnet that exercises everything but proofs (quotes, resolution, funding,
///         publications, refunds). It holds no header and has no owner, so nothing can be made to look proven: every
///         proof against it fails and every order ends in a refund. Never use it for anything else.
contract NoProofRelay is IZcashHeaderRelayReader {
    /// @dev keccak256("zcash-testnet"), Seam's ZCASH_TESTNET.
    bytes32 private constant ZCASH_TESTNET = keccak256("zcash-testnet");

    constructor() {
        require(block.chainid != 1, "MOCK: not on Ethereum mainnet");
    }

    function networkId() external pure returns (bytes32) {
        return ZCASH_TESTNET;
    }

    function isInBestChain(bytes32) external pure returns (bool) {
        return false;
    }

    function confirmations(bytes32) external pure returns (uint256) {
        return 0;
    }

    function confirmationWork(bytes32) external pure returns (uint256) {
        return 0;
    }

    function headerOf(bytes32) external pure returns (HeaderInfo memory info) {
        return info;
    }

    function bestChainTip() external pure returns (bytes32, uint256, uint256) {
        return (bytes32(0), 0, 0);
    }

    function bestBlockHashAt(uint256) external pure returns (bytes32) {
        return bytes32(0);
    }
}

/// @title NoProofVerifier — MOCK, a verifier that refuses every proof
/// @notice Pairs with NoProofRelay for the same throwaway deployments: the desk's constructor needs a verifier bound to
///         its relay, and every `verify` reverts.
contract NoProofVerifier {
    uint256 public constant JOURNAL_VERSION = 2;
    address public immutable relay;

    constructor(address relay_) {
        require(block.chainid != 1, "MOCK: not on Ethereum mainnet");
        relay = relay_;
    }

    function imageId() external pure returns (bytes32) {
        return bytes32(0);
    }

    function selector() external pure returns (bytes4) {
        return bytes4(0);
    }

    function verify(bytes calldata, bytes calldata) external pure returns (ZcashMaskedPayment memory, uint256) {
        revert("MOCK: this test deployment takes no proofs");
    }
}
