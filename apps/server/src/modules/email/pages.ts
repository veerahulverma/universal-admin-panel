import type { FastifyReply } from 'fastify';
import type { App } from '../../core/types.js';
import { escapeHtml } from '../../core/template.js';

/**
 * Minimal hosted page for links people open from emails (unsubscribe, list
 * confirmation). `body` is trusted markup built by the caller with escaped values.
 */
/** Where people can ask for help, shown on hosted pages: Settings → Email → technical address, else the admin address. */
export function helpAddress(app: App): string | null {
  try {
    const s = app.settings.get<{ technicalEmail?: string; adminEmail?: string }>('email');
    return s.technicalEmail || s.adminEmail || null;
  } catch {
    return null;
  }
}

/** Footer line for hosted pages: the help address, when one is set. */
export function helpLine(app: App): string {
  const address = helpAddress(app);
  return address ? `<p class="muted" style="font-size:12px;margin-top:8px">Need help? <a href="mailto:${escapeHtml(address)}">${escapeHtml(address)}</a></p>` : '';
}

export function hostedPage(app: App, title: string, body: string): string {
  const name = escapeHtml(app.settings.get<{ appName: string }>('general').appName);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · ${name}</title>
<style>:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#14161a;--muted:#5d6470;--border:#e3e6eb;--accent:#4f46e5}
@media (prefers-color-scheme:dark){:root{--bg:#0e1013;--card:#171a1f;--fg:#eceef2;--muted:#9aa1ad;--border:#2a2f37}}
body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--fg);display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px;max-width:420px;width:100%}h1{font-size:20px;margin:0 0 8px}.muted{color:var(--muted)}
button{display:block;width:100%;padding:11px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer;margin-top:16px}
button.secondary{background:transparent;color:var(--fg);border-color:var(--border);margin-top:8px}</style>
</head><body><main class="card">${body}<p class="muted" style="font-size:12px;margin-top:24px">${name}</p>${helpLine(app)}</main></body></html>`;
}

export function sendHtml(reply: FastifyReply, content: string, status = 200) {
  return reply.status(status).type('text/html; charset=utf-8').send(content);
}
