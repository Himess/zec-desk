// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IZcashHeaderRelayReader} from "../interfaces/IZcashHeaderRelayReader.sol";

/// @title MockRelay — MOCK, local chain only
/// @notice Stands in for Seam's relay in the desk's unit tests: headers, best-chain membership, the tip and work are
///         set by the test. The real relay is used on Sepolia.
contract MockRelay is IZcashHeaderRelayReader {
    struct H {
        bool known;
        bool best;
        uint256 height;
        uint256 time;
        uint256 chainWork;
    }

    mapping(bytes32 => H) public headers;
    uint256 public tipHeight;
    uint256 public tipWork;

    constructor() {
        require(block.chainid == 31337, "MOCK: local chain only");
    }

    function setHeader(bytes32 hash, uint256 height, uint256 time, uint256 chainWork, bool best) external {
        headers[hash] = H(true, best, height, time, chainWork);
    }

    function setBest(bytes32 hash, bool best) external {
        headers[hash].best = best;
    }

    function setTip(uint256 height, uint256 chainWork) external {
        tipHeight = height;
        tipWork = chainWork;
    }

    function networkId() external pure returns (bytes32) {
        return keccak256("zcash-testnet");
    }

    function isInBestChain(bytes32 blockHash) external view returns (bool) {
        return headers[blockHash].best;
    }

    function confirmations(bytes32 blockHash) external view returns (uint256) {
        H storage h = headers[blockHash];
        return h.best && tipHeight >= h.height ? tipHeight - h.height + 1 : 0;
    }

    function confirmationWork(bytes32 blockHash) external view returns (uint256) {
        H storage h = headers[blockHash];
        return h.best && tipWork >= h.chainWork ? tipWork - h.chainWork : 0;
    }

    function headerOf(bytes32 blockHash) external view returns (HeaderInfo memory info) {
        H storage h = headers[blockHash];
        info.known = h.known;
        info.height = h.height;
        info.time = h.time;
        info.chainWork = h.chainWork;
    }

    function bestChainTip() external view returns (bytes32, uint256, uint256) {
        return (bytes32(0), tipHeight, tipWork);
    }

    function bestBlockHashAt(uint256) external pure returns (bytes32) {
        return bytes32(0);
    }
}
