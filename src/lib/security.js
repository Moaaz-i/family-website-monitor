export async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + salt);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function generateSalt() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyPasswordInput(inputPassword, storedPasswordSpec) {
  if (!storedPasswordSpec) return false;
  if (storedPasswordSpec.startsWith("sha256$")) {
    const parts = storedPasswordSpec.split("$");
    if (parts.length === 3) {
      const hash = parts[1];
      const salt = parts[2];
      const inputHash = await hashPassword(inputPassword, salt);
      return inputHash === hash;
    }
  }
  return inputPassword === storedPasswordSpec;
}

export async function createPasswordSpec(password) {
  const salt = generateSalt();
  const hash = await hashPassword(password, salt);
  return `sha256$${hash}$${salt}`;
}

export function generateSecureId() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => b.toString(36).padStart(2, '0')).join('');
}