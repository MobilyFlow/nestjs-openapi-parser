import { Exclude } from 'class-transformer';
import { UserRole } from '../enums/user-role';

/**
 * A registered user.
 */
export class User {
  id!: string;

  email!: string;

  name!: string;

  role!: UserRole;

  bio?: string;

  @Exclude()
  passwordHash!: string;

  createdAt!: Date;

  updatedAt!: Date;
}
