# Edge rules (Cloudflare WAF) — protecting the static catalog

The catalog files (`/data/dataset.json.gz`, `/data/artist/*.json`, `/data/album/*.json`, …) are served by
Cloudflare's asset layer and **never run the Worker**, so the Worker's rate limits, bans and datacenter
block (`engine/security.mjs`) cannot see them. These zone rules protect them at the edge, before anything
costs a Worker request. They are configured once in the dashboard (the deploy token has no WAF permission).

Dashboard: **skmusic.shalomkarr.com zone → Security → WAF**. All fields used here are available on the
Free plan (`ip.src.asnum` and `cf.client.bot` are all-plan fields).

## 1. Custom rule — block datacenters for anonymous traffic

**Custom rules → Create rule**

- Name: `Block datacenter and location-less networks (anonymous)`
- Expression (Edit expression → paste):

```txt
((ip.src.asnum in {16509 14618 8987 396982 19527 15169 8075 8068 14061 24940 213230 16276 63949 20473 31898 45102 37963 132203 45090 51167 40021 12876 60781 28753 9009 60068 40676 8100 47583 8560 36007 41436 203020 7979 199524})
  or ip.src.country in {"XX" "T1"})
and starts_with(http.request.uri.path, "/data/")
and not cf.client.bot
and not http.cookie contains "sk_at="
```

- Action: **Block**

Why each clause:
- `/data/` only: the app shell and its scripts stay reachable, so someone on a datacenter network can still
  open the site and **sign in** — that is how they get limited access. Without an account, nothing can load
  the catalog, and every Worker route answers `403 datacenter` too.
- The ASN set is hosting providers only (AWS, Google Cloud, Azure, DigitalOcean, Hetzner, OVH, Linode,
  Vultr, Oracle, Alibaba, Tencent, Contabo, Scaleway, Leaseweb, M247, DataCamp/CDN77, Psychz, QuadraNet,
  Hostinger, IONOS, Kamatera, HostRoyale, Servers.com, G-Core) — the same set as `engine/security.mjs`.
  Deliberately **excluded**: Cloudflare 13335 (WARP and iCloud Private Relay users), Akamai 20940/16625
  and Fastly 54113 (Private Relay egress) — those carry real people.
- `ip.src.country in {"XX" "T1"}`: `XX` = Cloudflare could not place the IP anywhere, `T1` = a Tor exit
  node. Neither is a normal home or phone connection; both get the datacenter treatment.
- `not cf.client.bot` lets verified search crawlers (Googlebot, Bingbot) through, so the site stays indexed.
  Googlebot crawls from ASN 15169.
- `not http.cookie contains "sk_at="` is the "make an account for limited access" door: a signed-in visitor
  carries the `sk_at` cookie (set by `assets/ui.html`). **The edge can only see that the cookie exists, not
  verify it.** A bot that fakes it gets past this rule for static files, but rule 2 still rate-limits it,
  and every Worker route verifies the token's signature properly and applies the strictest limit.

## 2. Rate limiting rule — catalog files

**Rate limiting rules → Create rule** (the Free plan allows one)

- Name: `Catalog files — per-IP rate limit`
- If incoming requests match: `starts_with(http.request.uri.path, "/data/")`
- Characteristics: **IP**
- When rate exceeds: **40 requests per 10 seconds**
- Action: **Block** for **10 seconds** (the Free plan's fixed duration)

A normal visit loads about 10 catalog files at start and one per page opened; 40 in 10 seconds leaves
headroom for fast browsing while stopping anything walking `/data/artist/*` or `/data/album/*`.

## 3. Custom rule — AI crawlers at the edge (optional, saves Worker requests)

The Worker already turns these away (`AI_CRAWLER_RX` in `engine/index.mjs`), but every one it turns away
still counts as a Worker request. Blocking them at the edge is free.

- Name: `Block AI crawlers`
- Expression:

```txt
lower(http.user_agent) contains "meta-externalagent" or lower(http.user_agent) contains "meta-externalfetcher"
or lower(http.user_agent) contains "facebookbot" or lower(http.user_agent) contains "gptbot"
or lower(http.user_agent) contains "oai-searchbot" or lower(http.user_agent) contains "chatgpt-user"
or lower(http.user_agent) contains "claudebot" or lower(http.user_agent) contains "anthropic-ai"
or lower(http.user_agent) contains "ccbot" or lower(http.user_agent) contains "bytespider"
or lower(http.user_agent) contains "amazonbot" or lower(http.user_agent) contains "perplexitybot"
or lower(http.user_agent) contains "diffbot" or lower(http.user_agent) contains "omgilibot"
```

- Action: **Block**

## 4. Custom rule — sitemaps for search engines only

The sitemaps (`/sitemap.xml`, `/sitemap-songs-*.xml`, `/sitemap-albums.xml`, …) list every song, album and
artist URL — ~6.4 MB that turns enumerating the whole catalog into one download. They exist for Google and
Bing, so only verified crawlers get them.

- Name: `Sitemaps: verified crawlers only`
- Expression:

```txt
starts_with(http.request.uri.path, "/sitemap") and not cf.client.bot
```

- Action: **Block**

`robots.txt` still advertises the sitemap; Googlebot and Bingbot are `cf.client.bot` and fetch it as before.
Search Console keeps working.

## Checking it works

- **Security → Events** shows each rule's matches. A burst of `Catalog files` blocks from one IP is a
  scraper; blocks on `Block datacenter networks` from a residential ISP would be a false positive — check
  the ASN, and remove it from the set if so.
- From a normal home connection the site must load and play exactly as before.
- Allowlisted IPs/emails on the analytics Security page are honoured by the **Worker**. At the edge, an
  allowlisted person on a datacenter network just needs to be signed in.
