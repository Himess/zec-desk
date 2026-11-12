/** Browser wallet (EIP-1193, e.g. MetaMask), on Sepolia. From Encrypted Account's app. */
import { ethers } from "ethers";
import { CHAIN_ID_HEX, EXPLORER, RPC_URL } from "./config";

export type Wallet = { eip1193: any; provider: ethers.BrowserProvider; signer: ethers.JsonRpcSigner; address: string };

export const hasWallet = () => typeof (window as any).ethereum !== "undefined";

export async function connectWallet(): Promise<Wallet> {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("No browser wallet found. Install MetaMask (or another wallet extension) and reload.");
  await eth.request({ method: "eth_requestAccounts" });
  const chainId = String(await eth.request({ method: "eth_chainId" })).toLowerCase();
  if (chainId !== CHAIN_ID_HEX) {
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
    } catch (e: any) {
      if (e?.code !== 4902) throw e;
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: CHAIN_ID_HEX,
            chainName: "Sepolia",
            nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
            rpcUrls: [RPC_URL],
            blockExplorerUrls: [EXPLORER],
          },
        ],
      });
    }
  }
  const provider = new ethers.BrowserProvider(eth, "any");
  const signer = await provider.getSigner();
  return { eip1193: eth, provider, signer, address: await signer.getAddress() };
}

/** Reload on account or network change: the page state belongs to one key on one chain. */
export function watchWallet() {
  const eth = (window as any).ethereum;
  if (!eth?.on) return;
  eth.on("accountsChanged", () => location.reload());
  eth.on("chainChanged", () => location.reload());
}
