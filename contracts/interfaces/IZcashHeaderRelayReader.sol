// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title ZcashNetworks
/// @notice `networkId()` of a relay that follows a public Zcash network. Equal to `ZCASH_TESTNET` and `ZCASH_MAINNET`
///         in src/relay/IZcashHeaderRelay.sol (test/examples/IZcashHeaderRelayReader.t.sol).
library ZcashNetworks {
    bytes32 internal constant TESTNET = keccak256("zcash-testnet");
    bytes32 internal constant MAINNET = keccak256("zcash-mainnet");
}

/// @title IZcashHeaderRelayReader
/// @notice The read side of a ZcashHeaderRelay, with a loose pragma so that contracts built with any 0.8 compiler can
///         read a relay. Same selectors and return encodings as IZcashHeaderRelay
///         (test/examples/IZcashHeaderRelayReader.t.sol).
/// @dev Block hashes are SHA256d of the 1487-byte header in internal byte order (the bytes32 in the next header's
///      hashPrevBlock). Block explorers display them byte-reversed.
interface IZcashHeaderRelayReader {
    /// @notice Stored data of a known header (`known` = false if unknown).
    struct HeaderInfo {
        bool known;
        bytes32 prevHash;
        uint256 height;
        uint256 time;
        uint256 bits;
        // Cumulative work from the relay's checkpoint (the checkpoint itself counts 0). Plain comments, not NatSpec:
        // solc 0.8.0 to 0.8.3 refuse a docstring on a struct member.
        uint256 chainWork;
        bytes32 merkleRoot;
        // hashBlockCommitments (ZIP 244). Stored as the proof of work commits to it, not checked against block data.
        bytes32 blockCommitments;
    }

    /// @notice The Zcash network whose rules the relay applies (`ZcashNetworks.TESTNET` or `ZcashNetworks.MAINNET`).
    function networkId() external view returns (bytes32);

    /// @notice True if the block is on the current best chain.
    function isInBestChain(bytes32 blockHash) external view returns (bool);

    /// @notice Best-chain blocks from this block to the tip, inclusive; 0 off the best chain. A block count: not a
    ///         security measure on Testnet, where minimum-difficulty blocks make counts cheap. Use `confirmationWork`.
    function confirmations(bytes32 blockHash) external view returns (uint256);

    /// @notice Work of the best-chain blocks on top of this block: 0 for the tip and for blocks off the best chain.
    function confirmationWork(bytes32 blockHash) external view returns (uint256);

    /// @notice Stored fields of a header.
    function headerOf(bytes32 blockHash) external view returns (HeaderInfo memory);

    /// @notice The best chain's tip.
    function bestChainTip() external view returns (bytes32 blockHash, uint256 height, uint256 chainWork);

    /// @notice Best-chain block hash at `height`; zero above the tip or below the checkpoint.
    function bestBlockHashAt(uint256 height) external view returns (bytes32);
}
