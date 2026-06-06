/**
 * Wrapper class used as a method return type to signal a paginated response.
 * The parser's response-envelope hook detects this by class name.
 */
export class PaginatedResponse<T> {
  data!: T[];
  pagination!: {
    total: number;
    limit: number;
    offset: number;
  };
}
