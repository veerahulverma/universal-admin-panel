# Themes and white-labelling

Everything visual is driven by **design tokens**, so the console, the hosted checkout and invoice
pages, emails and your own pages can share one brand without code changes.

## Tokens

| Group | Tokens |
| --- | --- |
| Colours (light) | `primary`, `primaryForeground`, `background`, `foreground`, `surface`, `muted`, `mutedForeground`, `border`, `accent`, `success`, `warning`, `danger`, `info` |
| Colours (dark) | Any of the above, overriding the light values in dark mode |
| Typography | Font family, heading family, mono family, base size (12–18 px) |
| Shape | Corner radius (0–24 px), shadow (`none`, `sm`, `md`), density (`compact`, `comfortable`) |
| Appearance | Default `light`, `dark` or `system` |
| Branding | Application name, login title and subtitle, checkout title, email footer |
| Assets | Logo, dark-mode logo, favicon, login background: https URLs, or uploaded images (up to 1 MB, checked by content rather than declared type, served with a sandboxing content-security policy so an SVG cannot run script) |

Tokens are validated (hex colours, safe font names, https or same-site asset URLs). Optional
custom CSS is sanitized: `<style>` breakouts, script URLs, `expression()`, `behavior`,
`-moz-binding`, `@import` and `url()` values other than https, same-site paths and inline images
are stripped.

## Editing and publishing

**Integrations → Themes & branding** lists presets and your themes. Editing creates a new draft revision; the
preview applies the draft to a preview area without affecting other administrators. Publishing
makes that revision live; every revision is kept, so an earlier one can be published again.
Themes export and import as JSON for moving between environments.

## Scopes: global, per organization, per domain

A theme can be activated globally or for one organization. Organizations with a custom domain
get their theme automatically when their pages are requested on that domain, which is how
resellers and agencies get fully white-labelled experiences.

## Using the theme outside the console

| Endpoint | Returns |
| --- | --- |
| `GET /api/public/theme.css?org=<id or slug>` or `?domain=<host>` | CSS custom properties (`--color-primary`, `--color-primary-foreground`, …, `--radius`, `--font-sans`) with an ETag for caching |
| `GET /api/public/branding?org=…` | Application name, assets, colours, dark colours, appearance, branding texts and the CSS URL |
| `GET /api/client/branding` | Branding for the signed-in customer's organization (browser SDK) |

The CSS variables are the same ones the console uses, so styling your own pages with
`var(--color-primary)` keeps them in sync with the brand. Dark-mode values apply under
`:root.dark` / `[data-theme="dark"]`, or automatically through `prefers-color-scheme` when the
theme's appearance is `system`.
