import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type {
  Connection,
  ConnectionFactory,
  ConnectionTarget,
} from "../components/connection-host";
import { BridgeProvider } from "../data";
import { LiveSettingsProjectionProvider } from "../settings/data";

interface HistoryConnections {
  readonly targets: readonly ConnectionTarget[];
  readonly activeId: string;
  readonly createConnection: ConnectionFactory;
  readonly activate: (id: string) => void;
}

const HistoryConnectionsContext = createContext<HistoryConnections | null>(null);
const HistoryActiveContext = createContext(true);
export const HistoryConnectionsProvider = HistoryConnectionsContext.Provider;

export function useHistoryIsActive() {
  return useContext(HistoryActiveContext);
}

export function useHistoryConnections() {
  return useContext(HistoryConnectionsContext);
}

export function HistoryConnection({
  target,
  createConnection,
  children,
}: {
  readonly target: ConnectionTarget;
  readonly createConnection: ConnectionFactory;
  readonly children: ReactNode;
}) {
  const [connection, setConnection] = useState<Connection | null>(null);
  useEffect(() => {
    const next = createConnection(target);
    setConnection(next);
    return () => next.close();
  }, [target, createConnection]);
  return connection ? (
    <BridgeProvider bridge={connection.bridge}>
      <HistoryActiveContext.Provider value={false}>
        <LiveSettingsProjectionProvider>{children}</LiveSettingsProjectionProvider>
      </HistoryActiveContext.Provider>
    </BridgeProvider>
  ) : null;
}
