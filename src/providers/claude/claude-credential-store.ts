import * as fs from "fs";
import { replaceFile } from "../../core/fs-utils";
import * as path from "path";
import { ClaudeOAuth } from "../../core/types";
import { ClaudeSlot, CRED_FILE, keychainAccount } from "./claude-paths";
import { deleteGenericPassword, readGenericPassword, writeGenericPassword } from "./keychain";

/**
 * Claude Code's credential document. It holds more than the account's login (MCP server
 * tokens in `mcpOAuth`), so a switch replaces `claudeAiOauth` only and keeps the rest.
 */
export interface CredentialDoc {
  claudeAiOauth?: ClaudeOAuth;
  [key: string]: unknown;
}

export interface LiveRead {
  doc: CredentialDoc | undefined;
  /** Where the document came from. */
  source: "keychain" | "file" | "none";
  /** macOS only: a plaintext `.credentials.json` sits behind the Keychain. */
  fallbackFile?: string;
}

const useKeychain = (): boolean => process.platform === "darwin";

export function credentialFile(slot: ClaudeSlot): string {
  return path.join(slot.dir, CRED_FILE);
}

/** Recent reads per slot, so lookups do not spawn `security` every few seconds. */
const recent = new Map<string, { at: number; read: LiveRead }>();

/**
 * Reads the login the slot's Claude Code would use (Keychain first on macOS). `maxAgeMs` > 0
 * accepts a read that recent; anything that writes a slot reads it fresh (the default).
 */
export async function readLive(slot: ClaudeSlot, maxAgeMs = 0): Promise<LiveRead> {
  const hit = recent.get(slot.service);
  if (maxAgeMs > 0 && hit && Date.now() - hit.at < maxAgeMs) {
    return hit.read;
  }
  const read = await readLiveUncached(slot);
  recent.set(slot.service, { at: Date.now(), read });
  return read;
}

async function readLiveUncached(slot: ClaudeSlot): Promise<LiveRead> {
  const file = credentialFile(slot);
  const fileExists = fs.existsSync(file);
  if (useKeychain()) {
    const text = await readGenericPassword(keychainAccount(), slot.service);
    const doc = text ? parseDoc(text) : undefined;
    if (doc) {
      return { doc, source: "keychain", fallbackFile: fileExists ? file : undefined };
    }
  }
  if (fileExists) {
    return { doc: parseDoc(fs.readFileSync(file, "utf8")), source: "file" };
  }
  return { doc: undefined, source: "none" };
}

/**
 * Writes the document where Claude Code reads it and reads it back. Callers hold Claude
 * Code's write lock (and the refresh lock for a switch) around read-modify-write.
 */
export async function writeLive(slot: ClaudeSlot, doc: CredentialDoc): Promise<void> {
  recent.delete(slot.service);
  const text = JSON.stringify(doc);
  if (useKeychain()) {
    await writeGenericPassword(keychainAccount(), slot.service, text);
    const back = await readGenericPassword(keychainAccount(), slot.service);
    if (back !== text) {
      throw new Error("Keychain write did not stick (read-back differs).");
    }
    return;
  }
  fs.mkdirSync(slot.dir, { recursive: true });
  const file = credentialFile(slot);
  const tmp = `${file}.agent-pool.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  replaceFile(tmp, file);
  fs.chmodSync(file, 0o600);
}

/** Removes the slot's login entirely (used when a slot is retired). */
export async function clearLive(slot: ClaudeSlot): Promise<void> {
  recent.delete(slot.service);
  if (useKeychain()) {
    await deleteGenericPassword(keychainAccount(), slot.service);
  }
  fs.rmSync(credentialFile(slot), { force: true });
}

/**
 * A plaintext file behind the Keychain keeps a running session on its old login after a
 * switch. Moving it aside (not deleting) lets the session follow, and stays reversible.
 */
export function stowFallbackFile(file: string): string {
  const target = `${file}.agent-pool-${Date.now()}.bak`;
  fs.renameSync(file, target);
  return target;
}

function parseDoc(text: string): CredentialDoc | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as CredentialDoc) : undefined;
  } catch {
    return undefined;
  }
}
