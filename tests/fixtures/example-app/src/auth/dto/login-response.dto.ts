export class LoginResponseDto {
  accessToken!: string;

  expiresIn!: number;

  /**
   * The user ID
   */
  userId!: string;
}
