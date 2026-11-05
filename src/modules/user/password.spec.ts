import { hashPassword, verifyPassword } from './password.js';

describe('password', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse');
    expect(stored).toMatch(/^scrypt\$[^$]+\$[^$]+$/);
    expect(stored).not.toContain('correct horse');
    await expect(verifyPassword('correct horse', stored)).resolves.toBe(true);
    await expect(verifyPassword('wrong horse', stored)).resolves.toBe(false);
  });

  it('salts each hash', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('rejects a malformed stored value', async () => {
    await expect(verifyPassword('x', 'plain')).resolves.toBe(false);
  });
});
