import { BACKUP_SALT } from "./constants.js";

async function digestHex(contentStr) {
  const encoder = new TextEncoder();
  const rawData = encoder.encode(contentStr + BACKUP_SALT);
  const hashBuffer = await crypto.subtle.digest("SHA-256", rawData);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export const signPayload = (payload) => digestHex(JSON.stringify(payload));

export const verifySignature = async (payload, signature) => {
  const expectedSignature = await digestHex(JSON.stringify(payload));
  return signature === expectedSignature;
};