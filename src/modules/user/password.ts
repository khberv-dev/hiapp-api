import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** Hashes a password with scrypt and a random salt: `scrypt$<salt>$<hash>` (base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Checks a password against a `hashPassword` result, in constant time. */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(
    password,
    Buffer.from(saltB64, 'base64'),
    expected.length,
  );
  return timingSafeEqual(actual, expected);
}
