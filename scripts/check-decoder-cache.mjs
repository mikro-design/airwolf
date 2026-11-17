// SPDX-License-Identifier: GPL-2.0-or-later
import { verifyDecoderCache } from './decoder-recipe.mjs';
try {
  if (!process.argv[2]) throw new Error('Expected decoder install prefix');
  verifyDecoderCache(process.argv[2], undefined, process.argv[3]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
