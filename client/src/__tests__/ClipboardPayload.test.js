import { describe, test, expect } from 'vitest';
import { clipboardItemsToBatch, summarizeClipboard } from '../transfer/ClipboardPayload.js';
import { extractText } from '../transfer/TextPayload.js';
import { TEXT_FORMAT } from '@shared/constants.js';

describe('ClipboardPayload — items → batch (Feature 8)', () => {
    test('a single text item becomes a previewable TEXT transfer', async () => {
        const { batch, sendOptions } = clipboardItemsToBatch([{ kind: 'text', text: 'hello clip' }]);
        expect(sendOptions.transferType).toBe('text');
        expect(sendOptions.textFormat).toBe(TEXT_FORMAT.PLAIN);
        expect(batch.totalFiles).toBe(1);
        expect(await extractText(batch.files[0].file)).toBe('hello clip');
    });

    test('a pasted image becomes a named image file in a FILES batch', () => {
        const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
        const { batch, sendOptions } = clipboardItemsToBatch([{ kind: 'image', blob, type: 'image/png' }]);
        expect(sendOptions.transferType).toBe('files');
        expect(batch.totalFiles).toBe(1);
        expect(batch.files[0].relativePath).toMatch(/clipboard-image-1\.png$/);
        expect(batch.files[0].size).toBe(4);
    });

    test('mixed text + image + file produces a multi-file batch', () => {
        const img = new Blob([new Uint8Array([0])], { type: 'image/jpeg' });
        const file = new File([new Uint8Array([9, 9])], 'doc.bin', { type: 'application/octet-stream' });
        const { batch } = clipboardItemsToBatch([
            { kind: 'text', text: 'note' },
            { kind: 'image', blob: img, type: 'image/jpeg' },
            { kind: 'file', file },
        ]);
        expect(batch.totalFiles).toBe(3);
        const names = batch.files.map((f) => f.relativePath);
        expect(names).toContain('clipboard-text-1.txt');
        expect(names).toContain('clipboard-image-1.jpg');
        expect(names).toContain('doc.bin');
    });

    test('throws on empty clipboard', () => {
        expect(() => clipboardItemsToBatch([])).toThrow(/empty|could not be read/i);
    });

    test('summarizeClipboard describes the contents', () => {
        const s = summarizeClipboard([
            { kind: 'text', text: 'a' },
            { kind: 'image', blob: new Blob(['x']) },
            { kind: 'image', blob: new Blob(['y']) },
        ]);
        expect(s).toMatch(/1 text snippet/);
        expect(s).toMatch(/2 images/);
    });
});
