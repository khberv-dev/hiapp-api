import { BadGatewayException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { GoogleTokenVerifier } from './google-token.verifier.js';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';

const tokenInfo = (overrides: Record<string, string | undefined> = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: '106274080635347231925',
  email: 'Nexus@Gmail.com',
  email_verified: 'true',
  name: 'Nexus Pro',
  given_name: 'Nexus',
  family_name: 'Pro',
  exp: String(Math.floor(Date.now() / 1000) + 3600),
  ...overrides,
});

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('GoogleTokenVerifier', () => {
  const config = {
    getOrThrow: () => `other-client, ${CLIENT_ID}`,
  } as unknown as ConfigService;
  const verifier = new GoogleTokenVerifier(config);

  afterEach(() => vi.unstubAllGlobals());

  it('returns the profile for a valid token', async () => {
    const fetchMock = mockFetch(200, tokenInfo());
    await expect(verifier.verify('a.b.c')).resolves.toEqual({
      googleId: '106274080635347231925',
      firstName: 'Nexus',
      lastName: 'Pro',
      email: 'nexus@gmail.com',
    });
    const url = new URL(String(fetchMock.mock.calls[0]?.[0 as never]));
    expect(url.origin + url.pathname).toBe(
      'https://oauth2.googleapis.com/tokeninfo',
    );
    expect(url.searchParams.get('id_token')).toBe('a.b.c');
  });

  it('rejects tokens issued to another app', async () => {
    mockFetch(200, tokenInfo({ aud: 'someone-elses-app' }));
    await expect(verifier.verify('a.b.c')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a wrong issuer or an expired token', async () => {
    mockFetch(200, tokenInfo({ iss: 'https://evil.example' }));
    await expect(verifier.verify('a.b.c')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    mockFetch(200, tokenInfo({ exp: '1000' }));
    await expect(verifier.verify('a.b.c')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('maps a 400 from Google to 401 and a 5xx to 502', async () => {
    mockFetch(400, { error: 'invalid_token' });
    await expect(verifier.verify('a.b.c')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    mockFetch(503, {});
    await expect(verifier.verify('a.b.c')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('drops unverified emails and falls back for missing names', async () => {
    mockFetch(
      200,
      tokenInfo({
        email_verified: 'false',
        given_name: undefined,
        family_name: undefined,
      }),
    );
    await expect(verifier.verify('a.b.c')).resolves.toMatchObject({
      firstName: 'Nexus Pro',
      lastName: null,
      email: null,
    });
  });
});
