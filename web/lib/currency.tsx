"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { CURRENCIES, type Currency } from "@parallel/shared";

const Ctx = createContext<{ currency: Currency; setCurrency: (c: Currency) => void }>({
  currency: "AUD",
  setCurrency: () => {},
});

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setState] = useState<Currency>("AUD");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("parallel.currency") as Currency | null;
      if (saved && CURRENCIES.some((c) => c.code === saved)) setState(saved);
    } catch {}
  }, []);
  const setCurrency = (c: Currency) => {
    setState(c);
    try {
      localStorage.setItem("parallel.currency", c);
    } catch {}
  };
  return <Ctx.Provider value={{ currency, setCurrency }}>{children}</Ctx.Provider>;
}

export function useCurrency() {
  const { currency, setCurrency } = useContext(Ctx);
  const meta = CURRENCIES.find((c) => c.code === currency)!;
  return { currency, setCurrency, meta };
}
