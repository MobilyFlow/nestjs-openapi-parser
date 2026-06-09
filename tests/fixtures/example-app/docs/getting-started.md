# Getting Started

Welcome to the **Example API**. This page is a standalone Markdown document
rendered ahead of the API reference via `pages` in `nestparser.config.ts`.

## Authentication

Most endpoints require a bearer token:

```http
Authorization: Bearer <your-token>
```

Endpoints marked public (e.g. login, health) need no token.

## Conventions

- Every response is wrapped in a `{ success, message, data }` envelope.
- List endpoints return a `pagination` object alongside `data`.
