import { describe, test, expect } from 'vitest';
import {
    buildTextBatch,
    extractText,
    renderMarkdownSafe,
    escapeHtml,
    textFileName,
} from '../transfer/TextPayload.js';
import { TEXT_FORMAT } from '@shared/constants.js';

describe('TextPayload — build & extract (Feature 7)', () => {
    test('builds a single-file batch from text and round-trips the content', async () => {
        const batch = buildTextBatch('hello\nworld', TEXT_FORMAT.PLAIN);
        expect(batch.totalFiles).toBe(1);
        expect(batch.files[0].relativePath).toBe('shared-text.txt');
        const text = await extractText(batch.files[0].file);
        expect(text).toBe('hello\nworld');
    });

    test('markdown format uses a .md filename', () => {
        const batch = buildTextBatch('# hi', TEXT_FORMAT.MARKDOWN);
        expect(batch.files[0].relativePath).toBe('shared-text.md');
        expect(textFileName(TEXT_FORMAT.MARKDOWN)).toBe('shared-text.md');
    });

    test('rejects empty text', () => {
        expect(() => buildTextBatch('', TEXT_FORMAT.PLAIN)).toThrow(/empty/i);
    });
});

describe('TextPayload — safe Markdown rendering (XSS defence)', () => {
    test('escapes raw HTML so script/markup can never reach the DOM', () => {
        const html = renderMarkdownSafe('<script>alert(1)</script> & "quotes"');
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('&amp;');
    });

    test('renders headings, bold, italic, inline code and lists', () => {
        const html = renderMarkdownSafe('# Title\n\n**bold** and *italic* and `code`\n\n- a\n- b');
        expect(html).toContain('<h1>Title</h1>');
        expect(html).toContain('<strong>bold</strong>');
        expect(html).toContain('<em>italic</em>');
        expect(html).toContain('<code>code</code>');
        expect(html).toContain('<li>a</li>');
    });

    test('fenced code blocks are escaped, not interpreted', () => {
        const html = renderMarkdownSafe('```\n<b>not bold</b>\n```');
        expect(html).toContain('<pre><code>');
        expect(html).toContain('&lt;b&gt;not bold&lt;/b&gt;');
    });

    test('allows http/https/mailto links but neutralises javascript: links', () => {
        const ok = renderMarkdownSafe('[site](https://example.com)');
        expect(ok).toContain('href="https://example.com"');
        expect(ok).toContain('rel="noopener noreferrer nofollow"');

        const evil = renderMarkdownSafe('[x](javascript:alert(1))');
        expect(evil).not.toContain('javascript:');
        expect(evil).not.toContain('<a ');
        expect(evil).toContain('x'); // link text preserved, link dropped
    });

    test('escapeHtml covers the five significant characters', () => {
        expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
    });
});
