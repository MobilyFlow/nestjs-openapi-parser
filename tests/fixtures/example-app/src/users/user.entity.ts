import { Exclude } from 'class-transformer';
import { AdminMeta } from '../admin/admin-meta';
import { UserRole } from '../enums/user-role';

/**
 * A registered user.
 *
 * <internal>
 * Internal: lookup is by `id` (UUID). The email is unique but mutable, so
 * never use it as a join key.
 * </internal>
 *
 * <admin>Admin: rows with `role=ADMIN` cannot be deleted via the public API.</admin>
 */
export class User {
  id!: string;

  /**
   * The user's contact email.
   *
   * <internal>
   * Also used as the OTP delivery target.
   * </internal>
   */
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
