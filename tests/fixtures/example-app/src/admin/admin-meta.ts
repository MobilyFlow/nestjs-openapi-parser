/**
 * Per-user admin overlay — only visible under the `admin` scope.
 *
 * @Scope admin
 */
export class AdminMeta {
  note!: string;

  /** @Scope admin */
  internalKey!: string;

  publicKey!: string;
}
