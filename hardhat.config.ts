import "@fhevm/hardhat-plugin";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-ethers";
import type { HardhatUserConfig } from "hardhat/config";
import { isKey, readEnvSepolia, rpcUrl } from "./scripts/lib/env";

// Local tests run on the FHEVM mock. `--network sepolia` takes the deployer's key from the gitignored `.env.sepolia`
// (scripts/lib/env.ts), never from a command line.
const ENV = readEnvSepolia();
const SEPOLIA_ACCOUNTS = isKey(ENV.ZEC_DESK_DEPLOYER_KEY) ? [ENV.ZEC_DESK_DEPLOYER_KEY] : [];
const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          // FHEVM uses transient storage (EIP-1153), so at least "cancun".
          evmVersion: "cancun",
          viaIR: true,
          optimizer: { enabled: true, runs: 200 },
        },
      },
    ],
  },
  networks: {
    hardhat: {
      chainId: 31337,
      hardfork: "prague",
      allowUnlimitedContractSize: false,
    },
    sepolia: {
      chainId: 11155111,
      url: rpcUrl(ENV),
      accounts: SEPOLIA_ACCOUNTS,
    },
  },
  mocha: {
    timeout: 600_000,
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
  },
};

export default config;
