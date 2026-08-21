import type { SafeStorage } from "electron";

export const ENCRYPTED_SETTING_PREFIX = "secure:v1:";
export const SECRET_SETTING_MASK = "********";

export type SecureSettingsStatus = {
  needsReentry: string[];
};

export interface SecretCodec {
  isAvailable(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export interface SettingsStorage {
  list(): Record<string, string>;
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export type SafeStorageApi = Pick<SafeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString">;

export class SecureSettingsError extends Error {
  readonly code: "encryption_unavailable" | "encrypt_failed" | "decrypt_failed";

  constructor(code: SecureSettingsError["code"], key?: string) {
    const action = code === "encrypt_failed" ? "encrypt" : code === "decrypt_failed" ? "decrypt" : "protect";
    super(key ? `Unable to ${action} secure setting: ${key}` : `Unable to ${action} secure setting`);
    this.name = "SecureSettingsError";
    this.code = code;
  }
}

export class ElectronSafeStorageCodec implements SecretCodec {
  constructor(private readonly safeStorage: SafeStorageApi) {}

  isAvailable(): boolean {
    return this.safeStorage.isEncryptionAvailable();
  }

  encrypt(value: string): string {
    return this.safeStorage.encryptString(value).toString("base64");
  }

  decrypt(value: string): string {
    return this.safeStorage.decryptString(Buffer.from(value, "base64"));
  }
}

export function isSecretSettingKey(key: string): boolean {
  return key === "webhook_url" || /(?:^|_)(?:api_keys?|password|secret|tokens?)$/i.test(key);
}

export class SecureSettingsService {
  private readonly unreadableSecrets = new Set<string>();

  constructor(
    private readonly storage: SettingsStorage,
    private readonly codec: SecretCodec,
    private readonly isSecret: (key: string) => boolean = isSecretSettingKey,
  ) {}

  get(key: string): string | null {
    const stored = this.storage.get(key);
    if (stored === null || !this.isSecret(key) || stored === "") {
      this.unreadableSecrets.delete(key);
      return stored;
    }

    if (!stored.startsWith(ENCRYPTED_SETTING_PREFIX)) {
      this.storage.set(key, this.encrypt(key, stored));
      this.unreadableSecrets.delete(key);
      return stored;
    }

    if (!this.codec.isAvailable()) {
      this.unreadableSecrets.add(key);
      return null;
    }
    try {
      const value = this.codec.decrypt(stored.slice(ENCRYPTED_SETTING_PREFIX.length));
      this.unreadableSecrets.delete(key);
      return value;
    } catch {
      this.unreadableSecrets.add(key);
      return null;
    }
  }

  set(key: string, value: string): void {
    if (!this.isSecret(key)) {
      this.storage.set(key, value);
      return;
    }

    if (value === SECRET_SETTING_MASK && this.storage.get(key)) return;
    this.storage.set(key, value === "" ? "" : this.encrypt(key, value));
    this.unreadableSecrets.delete(key);
  }

  listPublic(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(this.storage.list()).map(([key, value]) => [
        key,
        this.isSecret(key) && value !== ""
          ? this.secretIsReadable(key, value) ? SECRET_SETTING_MASK : ""
          : value,
      ]),
    );
  }

  hasSecret(key: string): boolean {
    const stored = this.storage.get(key);
    return this.isSecret(key) && Boolean(stored) && this.secretIsReadable(key, stored!);
  }

  status(): SecureSettingsStatus {
    for (const [key, value] of Object.entries(this.storage.list())) {
      if (this.isSecret(key) && value !== "") this.secretIsReadable(key, value);
      else this.unreadableSecrets.delete(key);
    }
    return { needsReentry: [...this.unreadableSecrets].sort() };
  }

  private encrypt(key: string, value: string): string {
    if (!this.codec.isAvailable()) throw new SecureSettingsError("encryption_unavailable", key);
    try {
      return `${ENCRYPTED_SETTING_PREFIX}${this.codec.encrypt(value)}`;
    } catch {
      throw new SecureSettingsError("encrypt_failed", key);
    }
  }

  private secretIsReadable(key: string, stored: string): boolean {
    if (!stored.startsWith(ENCRYPTED_SETTING_PREFIX)) {
      this.unreadableSecrets.delete(key);
      return true;
    }
    if (!this.codec.isAvailable()) {
      this.unreadableSecrets.add(key);
      return false;
    }
    try {
      this.codec.decrypt(stored.slice(ENCRYPTED_SETTING_PREFIX.length));
      this.unreadableSecrets.delete(key);
      return true;
    } catch {
      this.unreadableSecrets.add(key);
      return false;
    }
  }
}
