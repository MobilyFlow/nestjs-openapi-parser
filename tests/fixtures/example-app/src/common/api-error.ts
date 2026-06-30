/**
 * Shape of an error response body. No endpoint returns it directly — it's
 * force-included via `additionalModels` and referenced by the `buildResponses`
 * hook for error status codes.
 */
export class ApiError {
  statusCode!: number;
  message!: string;
  error!: string;
}
