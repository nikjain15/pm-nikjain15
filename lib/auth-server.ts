import { adminAuth } from './broker-admin';

/**
 * Verify the Firebase ID token on a request and return the caller's uid, or null.
 *
 * Every bus-touching route gates on this: the client sends its ID token as a Bearer header, the
 * Admin SDK verifies it, and the verified uid — never a uid from the request body — is what the
 * handle (and thus the shared-context identity) is derived from. The bus writes with the Admin SDK,
 * which bypasses client rules, so a body-supplied identity would let anyone read or write someone
 * else's shared context. This is the one gate that closes that hole.
 */
export async function verifyUid(req: Request): Promise<string | null> {
  const header = req.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const auth = adminAuth();
  if (!auth) return null;
  try {
    const decoded = await auth.verifyIdToken(match[1]);
    return decoded.uid;
  } catch {
    return null;
  }
}

/** Resolve the caller's stable GitHub handle from their VERIFIED uid — the cross-app key. Never
 *  accept a handle from the request body; it must come from the member doc the uid owns. */
export async function getHandle(
  db: import('firebase-admin/firestore').Firestore,
  uid: string
): Promise<string | null> {
  const snap = await db.collection('members').doc(uid).get();
  const handle = snap.exists ? (snap.data()?.handle as string | null | undefined) : null;
  return handle && handle.trim() ? handle.trim().toLowerCase() : null;
}
