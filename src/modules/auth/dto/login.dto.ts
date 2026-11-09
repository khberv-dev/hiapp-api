import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email: string;

  // No minimum beyond 1: the 8-char rule applies when setting a password,
  // and a stricter check here would only hint at the rules.
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password: string;
}
