// ─── Parent password hashing ────────────────────────────────────────────────
// We use PBKDF2-SHA256 (WebCrypto, no dependencies) instead of a single
// SHA-256 round. A single round of SHA-256 is brute-forceable offline at
// billions of guesses/second; PBKDF2 with a high iteration count makes an
// attacker's cost realistic.
const PBKDF2_ITERATIONS = 310000;
const PBKDF2_KEY_BITS = 256;

const bytesToHex = (buffer) =>
  Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const hexToBytes = (hex) => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
};

// Constant-time comparison so response timing cannot leak how many
// characters of the stored hash an attacker got right.
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function pbkdf2Hash(password, saltHex, iterations) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: hexToBytes(saltHex),
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    PBKDF2_KEY_BITS,
  );
  return bytesToHex(bits);
}

// Legacy format kept ONLY so old installs can still verify once, after which
// the spec is transparently upgraded to pbkdf2$ (see needsRehash()).
export async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + salt);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(hashBuffer);
}

export function generateSalt() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return bytesToHex(array);
}

export async function createPasswordSpec(password) {
  const salt = generateSalt();
  const hash = await pbkdf2Hash(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${hash}$${salt}`;
}

/** True when the stored spec uses an outdated scheme and must be upgraded. */
export function needsRehash(storedPasswordSpec) {
  return typeof storedPasswordSpec === "string" && !storedPasswordSpec.startsWith("pbkdf2$");
}

export async function verifyPasswordInput(inputPassword, storedPasswordSpec) {
  if (!storedPasswordSpec) return false;
  if (typeof inputPassword !== "string" || inputPassword.length === 0) return false;

  if (storedPasswordSpec.startsWith("pbkdf2$")) {
    const parts = storedPasswordSpec.split("$");
    if (parts.length !== 4) return false;
    const iterations = parseInt(parts[1], 10);
    const hash = parts[2];
    const salt = parts[3];
    if (!hash || !salt || !Number.isFinite(iterations) || iterations < 1000) return false;
    const candidate = await pbkdf2Hash(inputPassword, salt, iterations);
    return timingSafeEqual(candidate, hash);
  }

  if (storedPasswordSpec.startsWith("sha256$")) {
    const parts = storedPasswordSpec.split("$");
    if (parts.length === 3) {
      const inputHash = await hashPassword(inputPassword, parts[2]);
      return timingSafeEqual(inputHash, parts[1]);
    }
    return false;
  }

  // Legacy plaintext (pre-v1.0 installs) — verified then upgraded immediately.
  return timingSafeEqual(inputPassword, storedPasswordSpec);
}

export function generateSecureId() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return bytesToHex(array);
}

/** Session tokens must come from a CSPRNG, never Date.now()/Math.random(). */
export function generateSessionToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return bytesToHex(array);
}
