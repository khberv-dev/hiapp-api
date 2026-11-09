import { LoginRateLimiter } from './login-rate-limiter.js';

describe('LoginRateLimiter', () => {
  let now = 0;
  let limiter: LoginRateLimiter;
  beforeEach(() => {
    now = 1_000_000;
    limiter = new LoginRateLimiter(
      { maxPerEmail: 3, maxPerIp: 5, windowMs: 60_000 },
      () => now,
    );
  });
  afterEach(() => limiter.onModuleDestroy());

  it('blocks an email after maxPerEmail attempts until the window ends', () => {
    for (let i = 0; i < 3; i++) expect(limiter.consume('ip1', 'a@x')).toBe(0);
    expect(limiter.consume('ip2', 'a@x')).toBe(60);
    now += 30_000;
    expect(limiter.consume('ip3', 'a@x')).toBe(30);
    now += 30_000;
    expect(limiter.consume('ip3', 'a@x')).toBe(0);
  });

  it('blocks an IP after maxPerIp attempts across different emails', () => {
    for (let i = 0; i < 5; i++)
      expect(limiter.consume('ip1', `u${i}@x`)).toBe(0);
    expect(limiter.consume('ip1', 'other@x')).toBe(60);
    expect(limiter.consume('ip2', 'other@x')).toBe(0);
  });

  it('does not count blocked attempts', () => {
    for (let i = 0; i < 3; i++) limiter.consume('ip1', 'a@x');
    for (let i = 0; i < 10; i++) limiter.consume('ip1', 'a@x');
    // Only the 3 allowed attempts used the IP budget.
    expect(limiter.consume('ip1', 'b@x')).toBe(0);
    expect(limiter.consume('ip1', 'c@x')).toBe(0);
    expect(limiter.consume('ip1', 'd@x')).toBe(60);
  });

  it('a success resets the email counter but not the IP counter', () => {
    limiter.consume('ip1', 'a@x');
    limiter.consume('ip1', 'a@x');
    limiter.succeeded('a@x');
    for (let i = 0; i < 3; i++) expect(limiter.consume('ip1', 'a@x')).toBe(0);
    expect(limiter.consume('ip1', 'z@x')).toBe(60); // 5 IP attempts used
  });
});
