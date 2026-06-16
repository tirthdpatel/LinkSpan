import {
    MAX_BATCH_FILES,
    MAX_BATCH_DIRECTORIES,
    MAX_BATCH_BYTES,
} from '@shared/constants.js';
import {
    sanitizeRelativePath,
    sanitizeDirectoryPath,
    ancestorDirectories,
} from './PathSanitizer.js';

/**
 * FileTree — turns user input (a file <input>, a directory <input webkitdirectory>,
 * or a drag-and-drop DataTransfer that may contain files AND folders) into a single
 * normalized, validated batch descriptor that the sender can stream.
 *
 * Output shape (a "batch"):
 *   {
 *     files:       [{ file: File, relativePath: string, size: number }],
 *     directories: string[]   // every directory, incl. empty ones and ancestors
 *     totalFiles:  number,
 *     totalBytes:  number,
 *     name:        string     // human label ("photos" or "3 items")
 *   }
 *
 * All relative paths are sanitized (see PathSanitizer) before they enter the batch,
 * so a crafted folder name on the *sender* can never produce a traversal path that
 * the receiver would act on.
 */

/**
 * Build entries from a plain file <input> or a directory <input webkitdirectory>.
 * Directory inputs populate `file.webkitRelativePath`; plain file inputs don't, so
 * we fall back to the bare filename (a flat batch).
 * @param {FileList|File[]} fileList
 * @returns {{ files: {file: File, relativePath: string}[], directories: string[] }}
 */
export function entriesFromInput(fileList) {
    const files = [];
    const directories = new Set();
    for (const file of Array.from(fileList)) {
        const raw = file.webkitRelativePath && file.webkitRelativePath.length > 0
            ? file.webkitRelativePath
            : file.name;
        const relativePath = sanitizeRelativePath(raw);
        files.push({ file, relativePath });
        for (const dir of ancestorDirectories(relativePath, false)) directories.add(dir);
    }
    return { files, directories: [...directories] };
}

/**
 * Recursively read a DataTransfer's items (drag-and-drop), descending into any
 * dropped directories. Captures empty directories explicitly (they have no files
 * but must still be recreated on the receiver).
 *
 * Uses the webkit Entries API (`webkitGetAsEntry`), which every evergreen browser
 * supports for drops. Items must be read synchronously from the drop event before
 * the DataTransfer is neutralized, so callers should pass `e.dataTransfer.items`
 * captured inside the drop handler.
 *
 * @param {DataTransferItemList|DataTransferItem[]} itemList
 * @returns {Promise<{ files: {file: File, relativePath: string}[], directories: string[] }>}
 */
export async function entriesFromDataTransfer(itemList) {
    const entries = [];
    for (const item of Array.from(itemList)) {
        if (item.kind && item.kind !== 'file') continue;
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry) {
            entries.push(entry);
        } else if (item.getAsFile) {
            // Fallback for environments without the Entries API: flat file only.
            const file = item.getAsFile();
            if (file) entries.push({ isFile: true, _file: file, name: file.name, fullPath: file.name });
        }
    }

    const files = [];
    const directories = new Set();

    const walk = async (entry, prefix) => {
        if (entry.isFile) {
            const file = entry._file ? entry._file : await fileFromEntry(entry);
            const rawPath = prefix ? `${prefix}/${file.name}` : file.name;
            const relativePath = sanitizeRelativePath(rawPath);
            files.push({ file, relativePath });
            for (const dir of ancestorDirectories(relativePath, false)) directories.add(dir);
        } else if (entry.isDirectory) {
            const dirPath = prefix ? `${prefix}/${entry.name}` : entry.name;
            const safeDir = sanitizeDirectoryPath(dirPath);
            if (safeDir) {
                directories.add(safeDir);
                for (const anc of ancestorDirectories(safeDir, true)) directories.add(anc);
            }
            const children = await readAllDirectoryEntries(entry);
            for (const child of children) {
                await walk(child, safeDir);
            }
        }
    };

    for (const entry of entries) {
        await walk(entry, '');
    }

    return { files, directories: [...directories] };
}

/** Promisified FileSystemFileEntry.file(). */
function fileFromEntry(fileEntry) {
    return new Promise((resolve, reject) => {
        fileEntry.file(resolve, reject);
    });
}

/**
 * Read ALL children of a directory entry. The Entries API's readEntries() returns
 * results in batches and must be called repeatedly until it yields an empty array,
 * or large directories silently truncate.
 * @param {FileSystemDirectoryEntry} dirEntry
 * @returns {Promise<FileSystemEntry[]>}
 */
function readAllDirectoryEntries(dirEntry) {
    const reader = dirEntry.createReader();
    const all = [];
    return new Promise((resolve, reject) => {
        const readBatch = () => {
            reader.readEntries((batch) => {
                if (batch.length === 0) {
                    resolve(all);
                } else {
                    all.push(...batch);
                    readBatch();
                }
            }, reject);
        };
        readBatch();
    });
}

/**
 * Validate and finalize a batch from raw entries + directories. Enforces the
 * batch ceilings (DoS / disk-exhaustion guards) and computes totals.
 *
 * @param {{ files: {file: File, relativePath: string}[], directories: string[] }} raw
 * @returns {{ files, directories, totalFiles, totalBytes, name }}
 * @throws {Error} when a ceiling is exceeded
 */
export function buildBatch({ files, directories }) {
    // Deduplicate files by relativePath (last write wins — matches FS semantics).
    const byPath = new Map();
    for (const { file, relativePath } of files) {
        byPath.set(relativePath, { file, relativePath, size: file.size });
    }
    const finalFiles = [...byPath.values()];

    // Ensure every file's ancestor dirs are present, then dedupe directories.
    const dirSet = new Set(directories);
    for (const { relativePath } of finalFiles) {
        for (const dir of ancestorDirectories(relativePath, false)) dirSet.add(dir);
    }
    dirSet.delete('');
    const finalDirs = [...dirSet].sort();

    if (finalFiles.length > MAX_BATCH_FILES) {
        throw new Error(`Batch exceeds the ${MAX_BATCH_FILES.toLocaleString()}-file limit`);
    }
    if (finalDirs.length > MAX_BATCH_DIRECTORIES) {
        throw new Error(`Batch exceeds the ${MAX_BATCH_DIRECTORIES.toLocaleString()}-directory limit`);
    }
    const totalBytes = finalFiles.reduce((n, f) => n + f.size, 0);
    if (totalBytes > MAX_BATCH_BYTES) {
        throw new Error('Batch exceeds the 50 GB total-size limit');
    }

    return {
        files: finalFiles,
        directories: finalDirs,
        totalFiles: finalFiles.length,
        totalBytes,
        name: deriveBatchName(finalFiles, finalDirs),
    };
}

/** A human label for the batch ("photos", "report.pdf", or "12 items"). */
function deriveBatchName(files, directories) {
    // Single top-level directory → name it after that directory.
    const topDirs = new Set(directories.map((d) => d.split('/')[0]));
    if (files.length > 0) {
        const topFileDirs = new Set(
            files.map((f) => (f.relativePath.includes('/') ? f.relativePath.split('/')[0] : null))
        );
        topFileDirs.delete(null);
        if (topFileDirs.size === 0 && files.length === 1 && directories.length === 0) {
            return files[0].relativePath; // single loose file
        }
    }
    if (topDirs.size === 1 && files.length > 0) {
        return [...topDirs][0];
    }
    const itemCount = files.length;
    return `${itemCount} item${itemCount === 1 ? '' : 's'}`;
}
