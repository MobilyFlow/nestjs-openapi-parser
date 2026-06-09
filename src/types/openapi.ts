export type OpenApiSchema = Record<string, unknown>;

export interface OpenApiServer {
  url: string;
  description?: string;
  variables?: Record<string, { default: string; enum?: string[]; description?: string }>;
}

export interface OpenApiInfo {
  title: string;
  version: string;
  description?: string;
  termsOfService?: string;
  contact?: { name?: string; url?: string; email?: string };
  license?: { name: string; url?: string };
}

export type OpenApiSecurityScheme = Record<string, unknown>;
export type OpenApiSecurityRequirement = Record<string, string[]>;

/** A Redoc/Scalar tag group — top-level navigation grouping a set of tag names. */
export interface OpenApiTagGroup {
  name: string;
  tags: string[];
}

export interface OpenApiDocument {
  openapi: string;
  info: OpenApiInfo;
  servers?: OpenApiServer[];
  paths: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
    securitySchemes?: Record<string, OpenApiSecurityScheme>;
  };
  security?: OpenApiSecurityRequirement[];
  tags?: { name: string; description?: string }[];
  /**
   * Redoc/Scalar navigation groups. When present, tags not listed in any group
   * are hidden — so the API's own tags must be grouped too, not just doc pages.
   */
  'x-tagGroups'?: OpenApiTagGroup[];
}
