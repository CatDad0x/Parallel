"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig } from "wagmi";
import { injected, coinbaseWallet, mock } from "wagmi/connectors";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider as PrivyWagmiProvider, createConfig as createPrivyConfig } from "@privy-io/wagmi";
import { chain, transports, PRIVY_APP_ID, USE_MOCK_WALLET } from "@/lib/config";
import { CurrencyProvider } from "@/lib/currency";

// Anvil's first funded test accounts. Local development only.
const LOCAL_ACCOUNTS = [
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
] as const;

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchInterval: 8_000 } } }));

  if (PRIVY_APP_ID) {
    const config = createPrivyConfig({ chains: [chain], transports });
    return (
      <PrivyProvider
        appId={PRIVY_APP_ID}
        config={{
          loginMethods: ["email", "wallet"],
          embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
          defaultChain: chain,
          supportedChains: [chain],
          appearance: { theme: "light", accentColor: "#142034" },
        }}
      >
        <QueryClientProvider client={queryClient}>
          <PrivyWagmiProvider config={config}>
            <CurrencyProvider>{children}</CurrencyProvider>
          </PrivyWagmiProvider>
        </QueryClientProvider>
      </PrivyProvider>
    );
  }

  return <PlainWagmi queryClient={queryClient}>{children}</PlainWagmi>;
}

function PlainWagmi({ children, queryClient }: { children: ReactNode; queryClient: QueryClient }) {
  const [config] = useState(() =>
    createConfig({
      chains: [chain],
      transports,
      ssr: true,
      connectors: [
        injected(),
        coinbaseWallet({ appName: "Parallel Markets (testnet demo)", preference: "smartWalletOnly" }),
        ...(USE_MOCK_WALLET ? [mock({ accounts: LOCAL_ACCOUNTS, features: { reconnect: true } })] : []),
      ],
    }),
  );
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <CurrencyProvider>{children}</CurrencyProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
