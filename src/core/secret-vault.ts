import * as crypto from "crypto";
import { AccountSecret } from "./types";

/** Where parked logins live. Backed by VS Code's encrypted SecretStorage. */
export interface SecretVault {
  get(id: string): Promise<AccountSecret | undefined>;
  set(id: string, secret: AccountSecret): Promise<void>;
  delete(id: string): Promise<void>;
}

interface SecretStorageLike {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export class VsSecretVault implements SecretVault {
  constructor(private readonly storage: SecretStorageLike) {}

  async get(id: string): Promise<AccountSecret | undefined> {
    const text = await this.storage.get(key(id));
    if (!text) {
      return undefined;
    }
    try {
      return JSON.parse(text) as AccountSecret;
    } catch {
      return undefined;
    }
  }

  async set(id: string, secret: AccountSecret): Promise<void> {
    await this.storage.store(key(id), JSON.stringify(secret));
  }

  async delete(id: string): Promise<void> {
    await this.storage.delete(key(id));
  }
}

function key(id: string): string {
  return `agentPool.account.${id}`;
}

/** Short fingerprint of a token, safe to compare and log. */
export function fingerprint(token: string | undefined): string {
  return token ? crypto.createHash("sha256").update(token).digest("hex").slice(0, 16) : "";
}

export function newAccountId(): string {
  return crypto.randomBytes(6).toString("hex");
}
