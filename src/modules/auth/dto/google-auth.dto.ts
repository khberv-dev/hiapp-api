import { IsJWT, MaxLength } from 'class-validator';

export class GoogleAuthDto {
  /** Google ID token from the client's Google Sign-In. */
  @IsJWT()
  @MaxLength(4096)
  idToken: string;
}
