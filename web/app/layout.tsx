import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  title: "Parallel Markets",
  description: "Invest in US equities in your own currency, hedged or unhedged, and borrow against your position. Testnet demo.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700;800;900&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers>
          <div className="strip">Testnet demo with mock assets. Not a live financial product and not affiliated with any stablecoin issuer.</div>
          <Header />
          <main className="wrap">{children}</main>
          <footer className="footer">
            <div className="wrap">
              Parallel Markets runs on Base Sepolia testnet. Every token is a mock, prices may be simulated, and the FX hedge is a
              simulation of what an institutional counterparty would provide. Lending runs on unmodified Morpho Blue.
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
