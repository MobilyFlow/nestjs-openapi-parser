import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { PaginatedResponse } from '../common/paginated-response';
import { CreatePostDto } from './dto/create-post.dto';
import { ListPostsQueryDto } from './dto/list-posts.query';
import { BlogPost } from './post.entity';

@Controller('posts')
export class PostsController {
  /**
   * Paginated list of posts, optionally filtered.
   */
  @Get()
  list(@Query() _query: ListPostsQueryDto): Promise<PaginatedResponse<BlogPost>> {
    return Promise.resolve(new PaginatedResponse<BlogPost>());
  }

  /**
   * Create a post and return the created `<BlogPost>` with its generated `<id>`.
   *
   * @Name Publish a post
   */
  @Post()
  create(@Body() _dto: CreatePostDto): Promise<BlogPost> {
    return Promise.resolve(new BlogPost());
  }
}
