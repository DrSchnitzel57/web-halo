import { DurableObject } from "cloudflare:workers";

const PRESENCE_LEASE_MILLISECONDS = 150_000;
const PRESENCE_KEY_PATTERN = /^[A-Za-z0-9_-]{4,128}:[A-Za-z0-9_-]{4,96}$/u;

interface PresenceCountRow extends Record<string, SqlStorageValue> {
  count: number;
}

/**
 * A small, anonymous lease table for the public "players online" count.
 *
 * Only SignalingRoom Durable Objects can write these leases. The public API
 * can read the aggregate, but browsers cannot claim arbitrary players. A
 * lease also expires on its own so an interrupted Worker or missed close
 * event cannot leave the counter permanently inflated.
 */
export class PlayerPresence extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS players (
        connection_key TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS players_expiry ON players(expires_at);
    `);
  }

  async connected(connectionKey: string, now: number): Promise<void> {
    if (!PRESENCE_KEY_PATTERN.test(connectionKey) || !Number.isFinite(now)) {
      throw new Error("Invalid presence lease.");
    }
    this.removeExpired(now);
    this.ctx.storage.sql.exec(
      `INSERT INTO players (connection_key, expires_at) VALUES (?, ?)
       ON CONFLICT(connection_key) DO UPDATE SET expires_at = excluded.expires_at`,
      connectionKey,
      now + PRESENCE_LEASE_MILLISECONDS,
    );
  }

  async disconnected(connectionKey: string): Promise<void> {
    if (!PRESENCE_KEY_PATTERN.test(connectionKey)) {
      return;
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM players WHERE connection_key = ?",
      connectionKey,
    );
  }

  async count(now: number): Promise<number> {
    if (!Number.isFinite(now)) {
      throw new Error("Invalid presence time.");
    }
    this.removeExpired(now);
    return this.ctx.storage.sql
      .exec<PresenceCountRow>("SELECT COUNT(*) AS count FROM players")
      .one().count;
  }

  private removeExpired(now: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM players WHERE expires_at <= ?",
      now,
    );
  }
}
