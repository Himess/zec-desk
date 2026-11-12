# OpenZeppelin Confidential Contracts (vendored)

These five files are copied **unchanged** from
[`@openzeppelin/confidential-contracts`](https://github.com/OpenZeppelin/openzeppelin-confidential-contracts) 0.5.3
(MIT), keeping their paths:

| File | SHA-256 |
|---|---|
| `interfaces/IERC7984.sol` | `2251186a997071a2b5a79ca20760ff51d169c234d67ad6261818f58e1f5438e9` |
| `interfaces/IERC7984Receiver.sol` | `562aced7399eba2269f20ddd3a9652e8b30f3e802ace134e3ff0d2686d132fde` |
| `token/ERC7984/ERC7984.sol` | `aaa46bee690458c5bcf6729038f943e21ff86e62dd6fbfdf7a55a78edd60f361` |
| `token/ERC7984/utils/ERC7984Utils.sol` | `2903ed4f58c874454a541389fa2a68cb6ffceefa6281bc5362ff7b5c98969472` |
| `utils/FHESafeMath.sol` | `49f12cca19e05993a91a2f76cd0deb3e7b667993039e969383f86821a82ca7e9` |

**Why vendored:** the npm package pins its peer dependency to `@fhevm/solidity` 0.11.1, while this repository uses
0.13.4, so a plain `npm install` refuses it. The files compile unchanged against 0.13.4; `test/Will.test.ts` runs them
on Zama's mock stack through `contracts/test/TestConfidentialToken.sol`.

**License:** MIT, © OpenZeppelin. See the upstream repository's `LICENSE`.
