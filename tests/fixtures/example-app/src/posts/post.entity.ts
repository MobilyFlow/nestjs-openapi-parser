import { PostStatus } from '../enums/post-status';

/**
 * A blog post authored by a user.
 */
export class BlogPost {
  id!: string;

  title!: string;

  body!: string;

  authorId!: string;

  status!: PostStatus;

  publishedAt?: Date;

  createdAt!: Date;

  updatedAt!: Date;
}
