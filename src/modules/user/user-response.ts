import type { User } from './entities/user.entity.js';

/** The public profile, as returned by `POST /auth/google` and `GET /user/me`. */
export interface UserResponse {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
}

/** `GET /user/me`: the profile plus account state the app needs. */
export interface MeResponse extends UserResponse {
  /** Whether a password is set (`PUT /user/password`). Never the hash. */
  hasPassword: boolean;
}

export function toUserResponse(user: User): UserResponse {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
  };
}
