# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do **not** open a public issue.

- Preferred: open a private [GitHub Security Advisory](https://github.com/Shalom-Karr/SK-Music/security/advisories/new)
  on this repository.
- Or contact the maintainer (Shalom Karr) directly.

Include what you found, how to reproduce it, and the impact. You'll get an acknowledgment as soon as
possible, and please give a reasonable window to fix the issue before any public disclosure.

## Scope

In scope: the web client, the Cloudflare Worker, the build, and the Supabase backend (analytics, parental
controls, artist tags). Out of scope: issues in third-party services the app depends on (YouTube, Cloudflare,
Supabase, the upstream catalog) — report those to the respective provider.

## Notes for reviewers / scanners

- **The Supabase key in the client is the anon / publishable key** — it is **not** a secret. Every table is
  protected by Row-Level Security, and privileged writes go through `SECURITY DEFINER` `pc_*` functions.
  Please do not file it as a leaked credential.
- No other secrets are committed. The Cloudflare API token, any Supabase `service_role` key, and any
  `*.token` file are gitignored and must never be committed.
- The parental-controls "hard lock" is enforced server-side (RLS + `pc_*` RPCs), not just in the client — see
  [`supabase/schema.sql`](supabase/schema.sql) and [`docs/filters-and-parental-controls.md`](docs/filters-and-parental-controls.md).

## Handling

Confirmed vulnerabilities are fixed as a priority; where relevant, credentials are rotated and the fix is
deployed to the live site.
