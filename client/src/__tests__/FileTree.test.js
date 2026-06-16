import { describe, test, expect } from 'vitest';
import {
    entriesFromInput,
    entriesFromDataTransfer,
    buildBatch,
} from '../transfer/FileTree.js';
import { MAX_BATCH_FILES } from '@shared/constants.js';

const mockFile = (name, size, webkitRelativePath) => ({ name, size, webkitRelativePath });

describe('entriesFromInput', () => {
    test('derives relative paths and directories from a folder selection', () => {
        const raw = entriesFromInput([
            mockFile('a.txt', 5, 'root/a.txt'),
            mockFile('b.txt', 3, 'root/sub/b.txt'),
        ]);
        expect(raw.files.map((f) => f.relativePath).sort()).toEqual(['root/a.txt', 'root/sub/b.txt']);
        expect(raw.directories.sort()).toEqual(['root', 'root/sub']);
    });

    test('falls back to bare filename for loose files', () => {
        const raw = entriesFromInput([mockFile('loose.txt', 9, '')]);
        expect(raw.files[0].relativePath).toBe('loose.txt');
        expect(raw.directories).toEqual([]);
    });
});

describe('buildBatch', () => {
    test('computes totals, dedupes by path, and derives a name', () => {
        const batch = buildBatch({
            files: [
                { file: mockFile('a.txt', 5), relativePath: 'root/a.txt' },
                { file: mockFile('a.txt', 7), relativePath: 'root/a.txt' }, // dup → last wins
                { file: mockFile('b.txt', 3), relativePath: 'root/sub/b.txt' },
            ],
            directories: ['root', 'root/sub', 'root/empty'],
        });
        expect(batch.totalFiles).toBe(2);
        expect(batch.totalBytes).toBe(7 + 3);
        expect(batch.directories).toContain('root/empty'); // empty dir preserved
        expect(batch.name).toBe('root');
    });

    test('names a single loose file after the file', () => {
        const batch = buildBatch({
            files: [{ file: mockFile('report.pdf', 100), relativePath: 'report.pdf' }],
            directories: [],
        });
        expect(batch.name).toBe('report.pdf');
        expect(batch.totalFiles).toBe(1);
    });

    test('enforces the file-count ceiling', () => {
        const files = Array.from({ length: MAX_BATCH_FILES + 1 }, (_, i) => ({
            file: mockFile(`f${i}`, 1),
            relativePath: `dir/f${i}`,
        }));
        expect(() => buildBatch({ files, directories: [] })).toThrow();
    });
});

// ── Drag-and-drop tree walking (Entries API) ───────────────────────────────
function fileEntry(name, size) {
    return {
        isFile: true,
        isDirectory: false,
        name,
        file: (resolve) => resolve(mockFile(name, size)),
    };
}
function dirEntry(name, children) {
    return {
        isFile: false,
        isDirectory: true,
        name,
        createReader: () => {
            let done = false;
            return {
                readEntries: (resolve) => {
                    if (done) { resolve([]); return; }
                    done = true;
                    resolve(children);
                },
            };
        },
    };
}
function dataTransferItem(entry) {
    return { kind: 'file', webkitGetAsEntry: () => entry };
}

describe('entriesFromDataTransfer', () => {
    test('walks nested folders and captures empty directories', async () => {
        const tree = dirEntry('photos', [
            fileEntry('a.jpg', 10),
            dirEntry('2024', [fileEntry('b.jpg', 20)]),
            dirEntry('empty', []), // empty directory — no files but must be recorded
        ]);

        const raw = await entriesFromDataTransfer([dataTransferItem(tree)]);
        const batch = buildBatch(raw);

        expect(batch.files.map((f) => f.relativePath).sort()).toEqual([
            'photos/2024/b.jpg',
            'photos/a.jpg',
        ]);
        expect(batch.directories).toContain('photos/empty');
        expect(batch.directories).toContain('photos/2024');
        expect(batch.totalBytes).toBe(30);
        expect(batch.name).toBe('photos');
    });

    test('handles a mix of loose files and folders', async () => {
        const raw = await entriesFromDataTransfer([
            dataTransferItem(fileEntry('top.txt', 4)),
            dataTransferItem(dirEntry('docs', [fileEntry('readme.md', 8)])),
        ]);
        const batch = buildBatch(raw);
        expect(batch.files.map((f) => f.relativePath).sort()).toEqual(['docs/readme.md', 'top.txt']);
        expect(batch.directories).toEqual(['docs']);
    });
});
