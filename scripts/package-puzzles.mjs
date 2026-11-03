import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// The puzzle library ships as one readable JSON file in the source tree, and as an index plus
// ~4 MB parts in the browser packages: extension validators refuse (or time out on) a single
// 27 MB JSON file, while a composed library still loads through the same lib/learning code path
// (see loadPuzzleData, which follows `puzzleFiles` when it is present).
export async function packagePuzzles(sourceDir, maxBytes = 4 * 1024 * 1024) {
  const directory = path.join(sourceDir, 'data/learning');
  const original = await readFile(path.join(directory, 'puzzles.json'));
  const { puzzles, ...metadata } = JSON.parse(original);
  if (metadata.schema !== 1 || !Array.isArray(puzzles) || !puzzles.length) throw Error('Invalid puzzle source');
  const files = {}, puzzleFiles = [];
  const hash = value => createHash('sha256').update(value).digest('hex');
  const write = async (name, content) => {
    if (Buffer.byteLength(content) > maxBytes) throw Error('Puzzle package file exceeds parser limit: ' + name);
    await writeFile(path.join(directory, name), content);
    files['data/learning/' + name] = hash(content);
  };
  let lines = [], bytes = 5;
  const flush = async () => {
    if (!lines.length) return;
    const name = `puzzles-${String(puzzleFiles.length + 1).padStart(3, '0')}.json`;
    await write(name, '[\n' + lines.join(',\n') + '\n]\n');
    puzzleFiles.push(name); lines = []; bytes = 5;
  };
  for (const puzzle of puzzles) {
    const line = JSON.stringify(puzzle), size = Buffer.byteLength(line) + 2;
    if (size + 5 > maxBytes) throw Error('A puzzle exceeds the package parser limit');
    if (bytes + size > maxBytes) await flush();
    lines.push(line); bytes += size;
  }
  await flush();
  await write('puzzles.json', JSON.stringify({ ...metadata, puzzleCount: puzzles.length, puzzleFiles }, null, 2) + '\n');
  return { count: puzzles.length, parts: puzzleFiles.length, sourceSha256: hash(original), files };
}
