import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../src/main/database";
import { SettingsRepository } from "../src/main/repositories";
import {
  ENCRYPTED_SETTING_PREFIX,
  ElectronSafeStorageCodec,
  SECRET_SETTING_MASK,
  SecureSettingsError,
  SecureSettingsService,
  type SecretCodec,
} from "../src/main/secure-settings";

class TestCodec implements SecretCodec {
  constructor(private readonly available = true) {}

  isAvailable(): boolean {
    return this.available;
  }

  encrypt(value: string): string {
    return Buffer.from(`test:${value}`, "utf8").toString("base64");
  }

  decrypt(value: string): string {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    if (!decoded.startsWith("test:")) throw new Error("invalid ciphertext");
    return decoded.slice(5);
  }
}

describe("secure settings", () => {
  let database: AppDatabase;
  let storage: SettingsRepository;

  beforeEach(() => {
    database = new AppDatabase(":memory:");
    storage = new SettingsRepository(database.connection);
  });

  afterEach(() => database.close());

  it("encrypts API keys at rest and returns them only through trusted reads", () => {
    const settings = new SecureSettingsService(storage, new TestCodec());
    settings.set("infer_api_key", "sk-private-value");
    settings.set("infer_model", "local-model");

    expect(settings.get("infer_api_key")).toBe("sk-private-value");
    expect(settings.get("infer_model")).toBe("local-model");
    expect(storage.get("infer_api_key")).toMatch(new RegExp(`^${ENCRYPTED_SETTING_PREFIX}`));
    expect(JSON.stringify(storage.list())).not.toContain("sk-private-value");
    expect(settings.listPublic()).toEqual({ infer_api_key: SECRET_SETTING_MASK, infer_model: "local-model" });
  });

  it("migrates a legacy plaintext secret on first read", () => {
    storage.set("imagegen_api_key", "legacy-key");
    const settings = new SecureSettingsService(storage, new TestCodec());

    expect(settings.get("imagegen_api_key")).toBe("legacy-key");
    expect(storage.get("imagegen_api_key")).toMatch(new RegExp(`^${ENCRYPTED_SETTING_PREFIX}`));
    expect(storage.get("imagegen_api_key")).not.toContain("legacy-key");
  });

  it("preserves a masked secret and supports explicitly clearing it", () => {
    const settings = new SecureSettingsService(storage, new TestCodec());
    settings.set("text_polish_api_key", "keep-this");
    const encrypted = storage.get("text_polish_api_key");

    settings.set("text_polish_api_key", SECRET_SETTING_MASK);
    expect(storage.get("text_polish_api_key")).toBe(encrypted);
    expect(settings.hasSecret("text_polish_api_key")).toBe(true);

    settings.set("text_polish_api_key", "");
    expect(settings.get("text_polish_api_key")).toBe("");
    expect(settings.listPublic().text_polish_api_key).toBe("");
  });

  it("reports unreadable secrets for re-entry without throwing or exposing ciphertext", () => {
    storage.set("infer_api_key", `${ENCRYPTED_SETTING_PREFIX}invalid-ciphertext`);
    storage.set("infer_model", "local-model");
    const settings = new SecureSettingsService(storage, new TestCodec());

    expect(settings.get("infer_api_key")).toBeNull();
    expect(settings.hasSecret("infer_api_key")).toBe(false);
    expect(settings.listPublic()).toEqual({ infer_api_key: "", infer_model: "local-model" });
    expect(settings.status()).toEqual({ needsReentry: ["infer_api_key"] });
    expect(JSON.stringify(settings.listPublic())).not.toContain("invalid-ciphertext");

    settings.set("infer_api_key", "replacement-key");
    expect(settings.get("infer_api_key")).toBe("replacement-key");
    expect(settings.status()).toEqual({ needsReentry: [] });
  });

  it("fails closed without leaking plaintext in codec errors", () => {
    const settings = new SecureSettingsService(storage, new TestCodec(false));
    const secret = "do-not-print-this-key";
    const error = (() => {
      try {
        settings.set("infer_api_key", secret);
      } catch (reason) {
        return reason;
      }
      return null;
    })();

    expect(error).toBeInstanceOf(SecureSettingsError);
    expect(error).toMatchObject({ code: "encryption_unavailable" });
    expect(String(error)).not.toContain(secret);
    expect(storage.get("infer_api_key")).toBeNull();
  });

  it("adapts Electron safeStorage buffers without importing the runtime", () => {
    const safeStorage = {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((value: string) => Buffer.from(`dpapi:${value}`, "utf8")),
      decryptString: vi.fn((value: Buffer) => value.toString("utf8").slice(6)),
    };
    const codec = new ElectronSafeStorageCodec(safeStorage);

    const encrypted = codec.encrypt("desktop-key");
    expect(encrypted).not.toContain("desktop-key");
    expect(codec.decrypt(encrypted)).toBe("desktop-key");
    expect(codec.isAvailable()).toBe(true);
  });
});
