/* Stockfish.js Web Worker Wrapper
 * Loads the Stockfish chess engine and handles UCI protocol communication.
 * Main thread sends UCI commands as strings via postMessage.
 * Stockfish responds with UCI output strings.
 */
try {
    importScripts('https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js');
} catch (e) {
    postMessage('info string Failed to load Stockfish engine: ' + e.message);
}
