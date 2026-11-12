// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "../vendor/openzeppelin-confidential/token/ERC7984/ERC7984.sol";

/// @title TestConfidentialUSD — TEST TOKEN, worthless: OpenZeppelin's ERC-7984 with a public mint
/// @notice For the desk's unit tests. On Sepolia the desk uses Zama's cUSDCMock instead.
contract TestConfidentialUSD is ZamaEthereumConfig, ERC7984 {
    uint64 public constant MAX_MINT = 1_000_000 * 1e6;

    error MintTooLarge();

    constructor() ERC7984("Test Confidential USD", "tcUSD", "") {}

    function mint(address to, uint64 amount) external {
        if (amount > MAX_MINT) revert MintTooLarge();
        _mint(to, FHE.asEuint64(amount));
    }
}
