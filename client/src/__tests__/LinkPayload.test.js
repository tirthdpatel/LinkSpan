import { describe, test, expect } from 'vitest';
import {
    validateUrl,
    buildLinkBatch,
    parseLinkPayload,
    extractLinkText,
    linkDomain,
} from '../transfer/LinkPayload.js';
import { TRANSFER_TYPE } from '@shared/constants.js';

describe('LinkPayload — URL validation (Feature 9)', () => {
    test('accepts http/https and upgrades a bare host to https', () => {
        expect(validateUrl('https://example.com/a').ok).toBe(true);
        expect(validateUrl('http://example.com').ok).toBe(true);
        const up = validateUrl('example.com/path');
        expect(up.ok).toBe(true);
        expect(up.url.startsWith('https://example.com')).toBe(true);
    });

    test('rejects dangerous and unsupported schemes', () => {
        for (const bad of [
            'javascript:alert(1)',
            'data:text/html,<script>alert(1)</script>',
            'file:///etc/passwd',
            'vbscript:msgbox(1)',
            'blob:https://x/abc',
            'ftp://example.com',
        ]) {
            const r = validateUrl(bad);
            expect(r.ok, bad).toBe(false);
        }
    });

    test('rejects empty, whitespace-laced and over-long URLs', () => {
        expect(validateUrl('').reason).toBe('empty');
        expect(validateUrl('https://e xample.com').ok).toBe(false);
        expect(validateUrl('javascript:\talert(1)').ok).toBe(false);
        expect(validateUrl('https://e.com/' + 'a'.repeat(5000)).ok).toBe(false);
    });

    test('linkDomain strips www', () => {
        expect(linkDomain('https://www.example.com/x')).toBe('example.com');
    });
});

describe('LinkPayload — batch build & parse round-trip', () => {
    test('builds a one-file LINK batch carrying the canonical URL + metadata', async () => {
        const batch = buildLinkBatch('example.com', { title: 'Hello', description: 'A site' });
        expect(batch.totalFiles).toBe(1);
        expect(batch.files[0].relativePath).toBe('shared-link.json');

        const payloadText = await extractLinkText(batch.files[0].file);
        const link = parseLinkPayload(payloadText);
        expect(link).not.toBeNull();
        expect(link.url).toBe('https://example.com/');
        expect(link.domain).toBe('example.com');
        expect(link.title).toBe('Hello');
        expect(link.safeHref).toBe('https://example.com/');
    });

    test('throws a friendly error on an unsafe scheme', () => {
        expect(() => buildLinkBatch('javascript:alert(1)')).toThrow(/http and https/i);
        expect(() => buildLinkBatch('')).toThrow(/enter a URL/i);
    });

    test('parse re-validates the URL and rejects a tampered payload', () => {
        // A malicious sender hand-crafts a payload with a javascript: URL.
        const evil = JSON.stringify({ v: 1, url: 'javascript:alert(1)', title: 'x' });
        expect(parseLinkPayload(evil)).toBeNull();
        expect(parseLinkPayload('not json')).toBeNull();
    });

    test('display fields are HTML-escaped (XSS defence)', () => {
        const payload = JSON.stringify({
            v: 1,
            url: 'https://example.com',
            title: '<img src=x onerror=alert(1)>',
            description: '"</a><script>bad</script>',
        });
        const link = parseLinkPayload(payload);
        expect(link.titleHtml).not.toContain('<img');
        expect(link.titleHtml).toContain('&lt;img');
        expect(link.descriptionHtml).not.toContain('<script>');
    });

    test('TRANSFER_TYPE.LINK is defined', () => {
        expect(TRANSFER_TYPE.LINK).toBe('link');
    });
});
