import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { ENC_PREFIX, decryptSecret, encryptSecret } from "./cipher";

const key = Buffer.alloc(32, 7);

describe("secret envelopes", () => {
  test.each(["", "value", "a'b\"c#d\\e", "first\nsecond"])(
    "round-trips %p without embedding plaintext",
    (value) => {
      const token = encryptSecret(value, key);
      expect(token.startsWith(ENC_PREFIX)).toBe(true);
      expect(decryptSecret(token, [key])).toBe(value);
      if (value) expect(token).not.toContain(value);
    },
  );

  test("reads main's v1 IV/tag/ciphertext layout", () => {
    const token = "enc:v1:AwMDAwMDAwMDAwMDm3fu1rDYozsvSS26dA+Stkifym13SzEvCiE3NYk+k2WZRc2Z1fnhFQ==";
    expect(decryptSecret(token, [key])).toBe("main-compatibility-value");
  });

  test("uses a fresh IV for each encryption", () => {
    expect(encryptSecret("value", key)).not.toBe(encryptSecret("value", key));
  });

  test.each([0, 12, 28])("rejects tampering at byte %i", (offset) => {
    const raw = Buffer.from(encryptSecret("private-value", key).slice(ENC_PREFIX.length), "base64");
    raw[offset] = raw[offset]! ^ 1;
    const token = ENC_PREFIX + raw.toString("base64");
    expect(() => decryptSecret(token, [key])).toThrow(/Restore the original encryption key/);
  });

  test("tries candidate keys and fails closed when none authenticate", () => {
    const token = encryptSecret("private-value", key);
    expect(decryptSecret(token, [randomBytes(32), key])).toBe("private-value");
    expect(() => decryptSecret(token, [randomBytes(32)])).toThrow(/Could not decrypt/);
    expect(() => decryptSecret(token, [])).toThrow(/Could not decrypt/);
    expect(() => decryptSecret("enc:v1:broken", [key])).toThrow(/Could not decrypt/);
  });
});
