import * as readline from 'node:readline';

export interface KeyChoice<T> {
  key: string;   // single character, e.g. 'k'
  label: string; // display label, e.g. 'Keep'
  value: T;
}

/**
 * Single-keypress prompt. Displays choices inline and returns immediately
 * when a matching key is pressed (no Enter required in TTY mode).
 *
 * Falls back to readline.question (type letter + Enter) when stdin is not a TTY.
 */
export function keypress<T>(
  message: string,
  choices: KeyChoice<T>[],
): Promise<T> {
  const legend = choices.map(c => `${c.key}) ${c.label}`).join('  ');
  const validKeys = new Set(choices.map(c => c.key));

  // Non-TTY fallback: simple line-based input
  if (!process.stdin.isTTY) {
    return new Promise<T>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      const ask = () => {
        rl.question(`${message}  ${legend}\n> `, (answer) => {
          const key = answer.trim().toLowerCase();
          const match = choices.find(c => c.key === key);
          if (match) {
            rl.close();
            resolve(match.value);
          } else {
            ask(); // ignore unrecognised input, re-prompt
          }
        });
      };
      ask();
    });
  }

  // TTY mode: raw keypress, instant response
  return new Promise<T>((resolve) => {
    process.stdout.write(`${message}  ${legend}  `);

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onKeypress = (_str: string | undefined, key: readline.Key) => {
      // Ctrl+C → exit cleanly
      if (key.ctrl && key.name === 'c') {
        cleanup();
        process.stdout.write('\n');
        process.exit(0);
      }

      const pressed = key.name ?? _str ?? '';
      if (!validKeys.has(pressed)) return; // ignore unrecognised keys

      cleanup();
      const match = choices.find(c => c.key === pressed)!;
      process.stdout.write(`${match.label}\n`);
      resolve(match.value);
    };

    function cleanup() {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    process.stdin.on('keypress', onKeypress);
  });
}
