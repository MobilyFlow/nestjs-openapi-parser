import { Exclude } from 'class-transformer';
import { AdminMeta } from '../admin/admin-meta';
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

  /**
   * Last IP address used to sign in.
   *
   * @Scope internal
   */
  lastLoginIp?: string;

  /**
   * Admin-only overlay attached to the user.
   *
   * @Scope admin
   */
  adminMeta?: AdminMeta;

  createdAt!: Date;

  updatedAt!: Date;
}
