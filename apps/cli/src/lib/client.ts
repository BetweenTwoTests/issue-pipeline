import { Connection, Client } from "@temporalio/client";
import { loadTemporalConnectionConfig } from "../env";

export interface ConnectedClient {
  client: Client;
  namespace: string;
}

/**
 * Reusable connection helper for every `pipe` subcommand. Fails fast via
 * loadTemporalConnectionConfig() -- never silently talks to localhost:7233.
 * Returns the namespace alongside the client so callers never have to guess
 * at Client's internal option-storage shape.
 */
export async function connectClient(): Promise<ConnectedClient> {
  const { address, namespace } = loadTemporalConnectionConfig();
  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });
  return { client, namespace };
}
