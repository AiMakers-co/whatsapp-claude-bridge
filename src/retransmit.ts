import type { proto } from "@whiskeysockets/baileys";

/**
 * Sent-message retransmit cache backing the socket's getMessage callback.
 *
 * When a recipient's device fails to decrypt one of our messages it sends a
 * retry receipt; Baileys answers it by calling getMessage(key) to re-encrypt
 * and resend the original plaintext. Without this cache getMessage returns
 * undefined, the retry is answered with nothing, and the recipient is stuck
 * on "Waiting for this message. This may take a while." forever.
 *
 * In-memory only: retry receipts arrive within seconds-to-minutes of the
 * original send, so surviving a process restart is not worth a disk format.
 */

const MAX_ENTRIES = 2000;
const TTL_MS = 6 * 60 * 60 * 1000; // 6h — far beyond any real retry window

const cache = new Map<string, { message: proto.IMessage; ts: number }>();

/** Record the proto of a message we just sent (call with sendMessage's return). */
export function rememberOutgoing(sent: { key?: { id?: string | null }; message?: proto.IMessage | null } | undefined): void {
  const id = sent?.key?.id;
  const message = sent?.message;
  if (!id || !message) return;
  cache.set(id, { message, ts: Date.now() });
  if (cache.size > MAX_ENTRIES) {
    // Map preserves insertion order — evict oldest.
    for (const key of cache.keys()) {
      if (cache.size <= MAX_ENTRIES) break;
      cache.delete(key);
    }
  }
}

/** Look up a sent message for a retry receipt. */
export function getForRetry(id: string | null | undefined): proto.IMessage | undefined {
  if (!id) return undefined;
  const hit = cache.get(id);
  if (!hit) return undefined;
  if (Date.now() - hit.ts > TTL_MS) {
    cache.delete(id);
    return undefined;
  }
  return hit.message;
}

/**
 * Minimal CacheStore for Baileys' msgRetryCounterCache (caps how many times a
 * single message is retried, so a broken peer session can't loop forever).
 */
export function makeRetryCounterCache() {
  const store = new Map<string, { value: unknown; ts: number }>();
  const RETRY_TTL_MS = 60 * 60 * 1000;
  const prune = () => {
    const cutoff = Date.now() - RETRY_TTL_MS;
    for (const [k, v] of store) if (v.ts < cutoff) store.delete(k);
  };
  return {
    get<T>(key: string): T | undefined {
      const hit = store.get(key);
      if (!hit || Date.now() - hit.ts > RETRY_TTL_MS) {
        store.delete(key);
        return undefined;
      }
      return hit.value as T;
    },
    set<T>(key: string, value: T): void {
      if (store.size > 5000) prune();
      store.set(key, { value, ts: Date.now() });
    },
    del(key: string): void {
      store.delete(key);
    },
    flushAll(): void {
      store.clear();
    },
  };
}
