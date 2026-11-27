import "./polyfill";
import React from "react";
import { createRoot } from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import App from "./App";
import { BASE_RPC } from "./chain";
import "./styles.css";

const SolanaConnectionProvider = ConnectionProvider as unknown as React.ComponentType<any>;

createRoot(document.getElementById("root")!).render(
  <SolanaConnectionProvider endpoint={BASE_RPC}>
    <WalletProvider wallets={[]} autoConnect>
      <WalletModalProvider>
        <App />
      </WalletModalProvider>
    </WalletProvider>
  </SolanaConnectionProvider>,
);
