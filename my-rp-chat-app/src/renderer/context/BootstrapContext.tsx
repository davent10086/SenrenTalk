import { createContext, useContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { CharacterProfile, PublicSettings } from "../../common/types";
import * as apiClient from "../api/client";

interface BootstrapContextValue {
  characters: CharacterProfile[];
  settings: PublicSettings | null;
  bootstrapError: string | null;
  settingsError: string | null;
  reload: () => Promise<void>;
}

const BootstrapContext = createContext<BootstrapContextValue | null>(null);

export function BootstrapProvider({ children }: { children: ReactNode }) {
  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const bootstrap = await apiClient.bootstrap();
      setCharacters(bootstrap.characters);
      setBootstrapError(null);
    } catch (error) {
      setBootstrapError(error instanceof Error ? error.message : "角色数据加载失败");
    }

    try {
      setSettings(await apiClient.getSettings());
      setSettingsError(null);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "设置加载失败");
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const value = useMemo<BootstrapContextValue>(() => ({
    characters, settings, bootstrapError, settingsError, reload,
  }), [characters, settings, bootstrapError, settingsError, reload]);

  return <BootstrapContext.Provider value={value}>{children}</BootstrapContext.Provider>;
}

export function useBootstrapContext(): BootstrapContextValue {
  const ctx = useContext(BootstrapContext);
  if (!ctx) throw new Error("useBootstrapContext must be used within a BootstrapProvider");
  return ctx;
}
