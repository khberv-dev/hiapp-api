import { createHash, timingSafeEqual } from 'node:crypto';
import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const REQUEST_TIMEOUT_MS = 15_000;
/** Refresh the token this long before Multicard says it expires. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** Fallback if `expiry` can't be parsed (tokens live 24h per the docs). */
const TOKEN_FALLBACK_TTL_MS = 23 * 60 * 60_000;

export interface CreateInvoiceParams {
  /** In tiyin. */
  amount: number;
  /** Our invoice id; Multicard echoes it back in the callback. */
  invoiceId: string;
}

export interface RhmtInvoice {
  /** Multicard transaction id. */
  uuid: string;
  checkoutUrl: string;
}

interface AuthResponse {
  token?: string;
  expiry?: string;
}

interface InvoiceResponse {
  success?: boolean;
  data?: { uuid?: string; checkout_url?: string };
  error?: { code?: string; details?: string };
}

class UnauthorizedError extends Error {}

/**
 * Client for the Multicard (RHMT) payment gateway, "payment on the Multicard
 * page" flow: https://docs.multicard.uz
 */
@Injectable()
export class RhmtService {
  private readonly logger = new Logger(RhmtService.name);
  private readonly apiUrl: string;
  private readonly applicationId: string;
  private readonly secret: string;
  private readonly storeId: string;
  private readonly callbackUrl: string;

  private token: { value: string; expiresAt: number } | null = null;
  private tokenRequest: Promise<string> | null = null;

  constructor(config: ConfigService) {
    const apiUrl = config.getOrThrow<string>('RHMT_API_URL');
    this.apiUrl = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
    this.applicationId = config.getOrThrow<string>('RHMT_APPLICATION_ID');
    this.secret = config.getOrThrow<string>('RHMT_SECRET');
    this.storeId = String(config.getOrThrow('RHMT_STORE_ID'));
    this.callbackUrl = config.getOrThrow<string>('RHMT_CALLBACK_URL');
  }

  /** `POST /payment/invoice`. Retries once with a fresh token on 401. */
  async createInvoice(params: CreateInvoiceParams): Promise<RhmtInvoice> {
    try {
      return await this.postInvoice(params, await this.getToken());
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      this.token = null;
      return this.postInvoice(params, await this.getToken());
    }
  }

  /** Our store id as configured, for comparing with callback payloads. */
  get configuredStoreId(): string {
    return this.storeId;
  }

  /** Checks a success-callback `sign`: md5(store_id + invoice_id + amount + secret). */
  verifyCallbackSign(
    storeId: string | number,
    invoiceId: string,
    amount: number,
    sign: string,
  ): boolean {
    const expected = createHash('md5')
      .update(`${storeId}${invoiceId}${amount}${this.secret}`)
      .digest('hex');
    const actual = Buffer.from(sign.toLowerCase());
    return (
      actual.length === expected.length &&
      timingSafeEqual(actual, Buffer.from(expected))
    );
  }

  private async postInvoice(
    { amount, invoiceId }: CreateInvoiceParams,
    token: string,
  ): Promise<RhmtInvoice> {
    const response = await this.request('payment/invoice', {
      token,
      body: {
        // Multicard accepts an integer id or a UUID string.
        store_id: /^\d+$/.test(this.storeId)
          ? Number(this.storeId)
          : this.storeId,
        amount,
        invoice_id: invoiceId,
        callback_url: this.callbackUrl,
      },
    });
    if (response.status === 401) throw new UnauthorizedError();

    const body = (await response.json().catch(() => null)) as InvoiceResponse;
    // Errors can arrive with HTTP 200 and `success: false`.
    if (!response.ok || !body?.success || !body.data) {
      this.logger.error(
        `Create invoice ${invoiceId} failed (${response.status}): ${JSON.stringify(body?.error ?? body)}`,
      );
      throw new BadGatewayException('Payment provider rejected the request');
    }

    const { uuid, checkout_url } = body.data;
    if (!uuid || !checkout_url) {
      this.logger.error(`Create invoice ${invoiceId}: unexpected response`);
      throw new BadGatewayException(
        'Payment provider returned an invalid response',
      );
    }
    return { uuid, checkoutUrl: checkout_url };
  }

  /** Cached token; concurrent callers share one `POST /auth`. */
  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) {
      return this.token.value;
    }
    this.tokenRequest ??= this.fetchToken().finally(() => {
      this.tokenRequest = null;
    });
    return this.tokenRequest;
  }

  private async fetchToken(): Promise<string> {
    const response = await this.request('auth', {
      body: { application_id: this.applicationId, secret: this.secret },
    });
    const body = (await response.json().catch(() => null)) as AuthResponse;

    if (!response.ok || !body?.token) {
      this.logger.error(
        `Auth failed (${response.status}): ${JSON.stringify(body)}`,
      );
      throw new BadGatewayException('Payment provider is unavailable');
    }

    // `expiry` is "YYYY-MM-DD HH:MM:SS" in GMT+5.
    const parsed = body.expiry
      ? Date.parse(`${body.expiry.replace(' ', 'T')}+05:00`)
      : NaN;
    const expiresAt = Number.isNaN(parsed)
      ? Date.now() + TOKEN_FALLBACK_TTL_MS
      : parsed - TOKEN_REFRESH_MARGIN_MS;

    this.token = { value: body.token, expiresAt };
    return body.token;
  }

  private async request(
    path: string,
    { body, token }: { body: unknown; token?: string },
  ): Promise<Response> {
    try {
      return await fetch(new URL(path, this.apiUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token && { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error(`POST /${path} failed: ${(error as Error).message}`);
      throw new BadGatewayException('Payment provider is unavailable');
    }
  }
}
