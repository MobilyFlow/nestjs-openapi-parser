import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';
import { PostStatus } from '../../enums/post-status';

export class CreatePostDto {
  @IsString()
  @MinLength(3)
  title!: string;

  @IsString()
  body!: string;

  @IsUUID()
  authorId!: string;

  @IsOptional()
  @IsEnum(PostStatus)
  status?: PostStatus;

  /** Up to 20 tag ids to attach. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  tagIds?: string[];
}
