import { describe, expect, it } from 'vitest';
import { safeUrl, sanitizeHtml } from './html.js';

describe('sanitizeHtml', () => {
  it('keeps ordinary content and formatting', () => {
    const html = '<h2>Welcome</h2><p>Read the <a href="/guide">guide</a> &amp; <strong>enjoy</strong>.</p><ul><li>One</li><li>Two</li></ul>';
    expect(sanitizeHtml(html)).toBe(html);
    expect(sanitizeHtml('<P CLASS="lead intro">Hi</P>')).toBe('<p class="lead intro">Hi</p>');
    expect(sanitizeHtml('<img src="https://cdn.example.com/a.png" alt="A" width="40">')).toBe('<img src="https://cdn.example.com/a.png" alt="A" width="40">');
    expect(sanitizeHtml('<img src="data:image/png;base64,iVBORw0KGgo=">')).toBe('<img src="data:image/png;base64,iVBORw0KGgo=">');
  });

  it('removes script, styles, frames, forms and their raw content', () => {
    expect(sanitizeHtml('<p>a</p><script>alert(1)</script><p>b</p>')).toBe('<p>a</p><p>b</p>');
    expect(sanitizeHtml('<SCRIPT type="text/javascript">document.cookie</SCRIPT >x')).toBe('x');
    expect(sanitizeHtml('<style>body{display:none}</style>ok')).toBe('ok');
    expect(sanitizeHtml('<iframe src="https://evil.example"></iframe>ok')).toBe('ok');
    expect(sanitizeHtml('<svg><script>alert(1)</script><a href="javascript:x">y</a></svg>after')).toBe('after');
    expect(sanitizeHtml('<svg/>after')).toBe('after');
    expect(sanitizeHtml('<form action="https://evil.example"><input name="password"><button>Go</button></form>')).toBe('Go');
    expect(sanitizeHtml('<embed src="x.swf">kept<object data="x"><p>fallback</p></object>')).toBe('kept');
    expect(sanitizeHtml('<textarea><script>alert(1)</script></textarea>done')).toBe('done');
    expect(sanitizeHtml('<!-- secret --><!DOCTYPE html><?xml x?>text')).toBe('text');
  });

  it('strips event handlers, inline styles and unsafe URLs', () => {
    expect(sanitizeHtml('<img src=x onerror="alert(1)">')).toBe('<img src="x">');
    expect(sanitizeHtml('<p style="position:fixed" onclick="x()">t</p>')).toBe('<p>t</p>');
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="JaVaScRiPt:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="java&#x09;script&#58;alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="&#106;avascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href=" \u0001javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="javascript&colon;alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<img src="data:image/svg+xml;base64,PHN2Zz4=">')).toBe('<img>');
    expect(sanitizeHtml('<a href="vbscript:msgbox">x</a>')).toBe('<a>x</a>');
    // Undecoded references stay literal, so the browser sees a harmless relative path.
    expect(sanitizeHtml('<a href="javascript&unknown;alert(1)">x</a>')).toBe('<a href="javascript&amp;unknown;alert(1)">x</a>');
    expect(sanitizeHtml('<a href="mailto:help@example.com">mail</a>')).toBe('<a href="mailto:help@example.com">mail</a>');
  });

  it('adds rel to links that open a new tab and drops other targets', () => {
    expect(sanitizeHtml('<a href="https://example.com" target="_blank">x</a>')).toBe('<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>');
    expect(sanitizeHtml('<a href="https://example.com" target="_top" rel="opener">x</a>')).toBe('<a href="https://example.com">x</a>');
  });

  it('produces balanced markup that cannot break out of its container', () => {
    expect(sanitizeHtml('<div><p>open')).toBe('<div><p>open</p></div>');
    expect(sanitizeHtml('</div></div>text<b>bold')).toBe('text<b>bold</b>');
    expect(sanitizeHtml('<p>one<p>two')).toBe('<p>one</p><p>two</p>');
    expect(sanitizeHtml('<ul><li>a<li>b</ul>')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(sanitizeHtml('<em><strong>x</em>y')).toBe('<em><strong>x</strong></em>y');
    expect(sanitizeHtml('<br/><hr>')).toBe('<br><hr>');
  });

  it('does not mistake Object.prototype names for allowed elements or entities', () => {
    expect(sanitizeHtml('<constructor title="x">a</constructor><p title="&constructor;">b</p>')).toBe('a<p title="&amp;constructor;">b</p>');
  });

  it('escapes stray markup characters and quotes inside attributes', () => {
    expect(sanitizeHtml('1 < 2 > 0 & done')).toBe('1 &lt; 2 &gt; 0 &amp; done');
    expect(sanitizeHtml('<a title="a>b &quot;c&quot;" href="/x?a=1&amp;b=2">t</a>')).toBe('<a title="a&gt;b &quot;c&quot;" href="/x?a=1&amp;b=2">t</a>');
    expect(sanitizeHtml('<a title=\'x" onmouseover="alert(1)\'>t</a>')).toBe('<a title="x&quot; onmouseover=&quot;alert(1)">t</a>');
    expect(sanitizeHtml('text <b class="x')).toBe('text ');
    expect(sanitizeHtml('<custom-element data-x="1">inner</custom-element>')).toBe('inner');
  });
});

describe('safeUrl', () => {
  it('accepts web and relative URLs only', () => {
    expect(safeUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeUrl('/members/guide#top')).toBe('/members/guide#top');
    expect(safeUrl('ftp://example.com')).toBeNull();
    expect(safeUrl('  javascript:alert(1)')).toBeNull();
    expect(safeUrl('mailto:a@b.co')).toBeNull();
    expect(safeUrl('mailto:a@b.co', { mailto: true })).toBe('mailto:a@b.co');
  });
});
