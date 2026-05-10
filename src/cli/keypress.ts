import {
  createPrompt,
  useState,
  useKeypress,
  usePrefix,
  makeTheme,
  isUpKey,
  isDownKey,
  isEnterKey,
} from '@inquirer/core';
import { cursorHide } from '@inquirer/ansi';
import figures from '@inquirer/figures';
import { styleText } from 'node:util';

export interface KeyChoice<T> {
  key: string;
  alias?: string;
  label: string;
  value: T;
}

interface HybridConfig<T> {
  message: string;
  choices: KeyChoice<T>[];
}

function formatHotkey(choice: KeyChoice<unknown>): string {
  if (!choice.alias) return choice.key;
  const display = choice.alias === 'escape' ? 'esc' : choice.alias;
  return `${choice.key}/${display}`;
}

const hybridSelect = createPrompt(
  <T>(config: HybridConfig<T>, done: (value: T) => void) => {
    const { choices } = config;
    const theme = makeTheme({});
    const [active, setActive] = useState(0);
    const [status, setStatus] = useState<'idle' | 'done'>('idle');
    const [answeredLabel, setAnsweredLabel] = useState('');
    const prefix = usePrefix({ status, theme });

    useKeypress((key) => {
      if (isEnterKey(key)) {
        setAnsweredLabel(choices[active]!.label);
        setStatus('done');
        done(choices[active]!.value);
        return;
      }

      if (isUpKey(key)) {
        setActive((active - 1 + choices.length) % choices.length);
        return;
      }

      if (isDownKey(key)) {
        setActive((active + 1) % choices.length);
        return;
      }

      const pressed = key.name;
      const match = choices.find(
        (c) => c.key === pressed || c.alias === pressed,
      );
      if (match) {
        setAnsweredLabel(match.label);
        setStatus('done');
        done(match.value);
      }
    });

    const message = theme.style.message(config.message, status);

    if (status === 'done') {
      return `${prefix} ${message} ${theme.style.answer(answeredLabel)}`;
    }

    const lines = choices.map((c, i) => {
      const cursor = i === active ? figures.pointer : ' ';
      const hotkey = styleText('dim', `(${formatHotkey(c)})`);
      const text = `${c.label} ${hotkey}`;
      return i === active
        ? `${cursor} ${styleText('bold', c.label)} ${hotkey}`
        : `${cursor} ${text}`;
    });

    return `${prefix} ${message}\n${lines.join('\n')}${cursorHide}`;
  },
);

async function readlineFallback<T>(
  message: string,
  choices: KeyChoice<T>[],
): Promise<T> {
  const { createInterface } = await import('node:readline');
  const legend = choices.map(c => `${c.key}) ${c.label}`).join('  ');
  return new Promise<T>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    const ask = () => {
      rl.question(`${message}  ${legend}\n> `, (answer) => {
        const key = answer.trim().toLowerCase();
        const match = choices.find(c => c.key === key || c.alias === key);
        if (match) { rl.close(); resolve(match.value); }
        else { ask(); }
      });
    };
    ask();
  });
}

export function keypress<T>(
  message: string,
  choices: KeyChoice<T>[],
): Promise<T> {
  if (!process.stdin.isTTY) return readlineFallback(message, choices);
  return hybridSelect({ message, choices });
}
