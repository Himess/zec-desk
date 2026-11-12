/**
 * The Sepolia deployment the app talks to. DESK is filled in by the deployment (contracts/deployments/*.json); until
 * then the app shows that no desk is configured.
 */
export const CHAIN_ID = 11155111n;
export const CHAIN_ID_HEX = "0xaa36a7";
export const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
/** Log queries go here first: publicnode keeps only recent logs. Both allow browser requests. */
export const LOG_RPC_URLS = ["https://sepolia.gateway.tenderly.co", "https://rpc.sepolia.ethpandaops.io"];
export const EXPLORER = "https://sepolia.etherscan.io";

/** The desk of deployments/zec-desk-sepolia-1.json: Seam's relay and amount-hidden verifier on Sepolia. */
export const DESK: string = "0xBD24DDCa2d509efA2dBabC0d092bd07b2bD8415E";
export const DESK_DEPLOY_BLOCK = 12_118_119;

/**
 * MOCK: the worthless test ERC-7984 token anyone may mint (tcUSD, 6 decimals), standing in for confidential USDC on
 * testnet. The same token Encrypted Account's demo uses.
 */
export const TOKEN = "0xE552Beed2265a8666d25307079fad9eDA2D70172";
export const TOKEN_DECIMALS = 6;
export const TOKEN_SYMBOL = "cUSDC";

/** Each allowlisted maker's off-chain hand-off API. */
/** Keys in lower case. The test maker runs on a server; its API is reached through an SSH tunnel on this machine. */
export const MAKER_APIS: Record<string, string> = {
  "0xd708a71310ab8c2e5f4d8880fcea246daf5b80df": "http://localhost:18797",
};

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addrUrl = (a: string) => `${EXPLORER}/address/${a}`;
