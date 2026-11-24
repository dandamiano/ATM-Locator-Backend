# Architecture

Modular Fastify monolith. Layers:

| Layer | Path | Responsibility |
| --- | --- | --- |
| http | `*/routes.ts`, `http/`, `auth/guards` | Validate, authorize, map HTTP |
| service | `services/` | Business rules + transactions |
| query | `db/queries/` | Typed SQL |
| domain | `wait/`, `public/mapper` | Wait honesty + public allow-list |
| tenancy | `tenancy/` | Bank ownership asserts |
| infra | `db/pool`, `config`, `ratelimit` | Cross-cutting runtime |

Middleware: `request-id → rate-limit → auth → role/tenant → handler`.

File headers use `@module`, `@layer`, `@description`.
