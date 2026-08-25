import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from "react";

export type Locale = "ko" | "en";

type LanguageContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  text: (korean: string, english: string) => string;
};

const LanguageContext = createContext<LanguageContextValue | undefined>(undefined);
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>("ko");

  useEffect(() => {
    document.documentElement.lang = locale === "ko" ? "ko" : "en";
  }, [locale]);

  const value = useMemo(() => ({
    locale,
    setLocale,
    text: (korean: string, english: string) => locale === "ko" ? korean : english,
  }), [locale]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useLanguage must be used within LanguageProvider");
  return context;
}
