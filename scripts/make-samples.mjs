// Writes the sample files for the tests and the real VS Code gate: 12 languages and edge cases, 2 large files and
// 3 hostile ones. Usage: node scripts/make-samples.mjs <dir> [--no-large]
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('usage: make-samples.mjs <dir> [--no-large]'); process.exit(2); }
const noLarge = process.argv.includes('--no-large');
fs.mkdirSync(dir, { recursive: true });
const w = (name, text) => fs.writeFileSync(path.join(dir, name), text);

w('app.ts', `import { readFile } from 'node:fs/promises';

/** A tiny cache with a time limit per entry. */
export class TtlCache<K, V> {
  private readonly items = new Map<K, { value: V; until: number }>();

  constructor(private readonly ttlMs = 60_000) {}

  get(key: K): V | undefined {
    const hit = this.items.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.until) {
      this.items.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: K, value: V): this {
    this.items.set(key, { value, until: Date.now() + this.ttlMs });
    return this;
  }
}

export async function loadConfig(path: string): Promise<Record<string, unknown>> {
  const text = await readFile(path, 'utf8');
  const data = JSON.parse(text) as Record<string, unknown>;
  console.log(\`loaded \${Object.keys(data).length} keys from \${path}\`);
  return data;
}

const cache = new TtlCache<string, number>(5_000);
cache.set('answer', 42);
if (cache.get('answer') !== 42) throw new Error('cache is broken');
`);

w('server.py', `from dataclasses import dataclass
from http import HTTPStatus


@dataclass
class Reply:
    status: int
    body: str


def handle(path: str, *, debug: bool = False) -> Reply:
    """Answer one request. Unknown paths get 404."""
    routes = {"/": "home", "/health": "ok"}
    if path not in routes:
        return Reply(HTTPStatus.NOT_FOUND, f"no route for {path!r}")
    if debug:
        print(f"[debug] {path=} -> {routes[path]}")
    return Reply(HTTPStatus.OK, routes[path])


if __name__ == "__main__":
    for p in ["/", "/health", "/missing"]:
        print(handle(p, debug=True))
`);

w('main.rs', `use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
enum Token<'a> {
    Word(&'a str),
    Number(f64),
}

fn tokenize(input: &str) -> Vec<Token<'_>> {
    input
        .split_whitespace()
        .map(|w| w.parse::<f64>().map(Token::Number).unwrap_or(Token::Word(w)))
        .collect()
}

fn main() {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for t in tokenize("a 1 b 2 a 3.5") {
        if let Token::Word(w) = t {
            *counts.entry(w).or_insert(0) += 1;
        }
    }
    println!("{:?}", counts);
}
`);

w('handler.go', `package main

import (
\t"encoding/json"
\t"net/http"
)

type item struct {
\tID   int    \`json:"id"\`
\tName string \`json:"name"\`
}

func list(w http.ResponseWriter, r *http.Request) {
\titems := []item{{1, "one"}, {2, "two"}}
\tif r.URL.Query().Get("empty") == "1" {
\t\titems = nil
\t}
\tw.Header().Set("Content-Type", "application/json")
\t_ = json.NewEncoder(w).Encode(items)
}

func main() {
\thttp.HandleFunc("/items", list)
\t_ = http.ListenAndServe("127.0.0.1:8080", nil)
}
`);

w('config.json', JSON.stringify({ name: 'demo', version: '1.2.3', features: { search: true, export: ['png', 'svg'], limits: { lines: 1000, columns: 400 } }, owners: [{ name: 'A', admin: true }, { name: 'B', admin: false }] }, null, 2) + '\n');

w('README.md', `# Demo project

Some **bold** text, a [link](https://example.com) and \`inline code\`.

\`\`\`ts
export function add(a: number, b: number): number {
  return a + b;
}
\`\`\`

- one
- two
`);

w('wide.js', `// One line with 400 columns:\nconst wide = [${Array.from({ length: 80 }, (_, i) => `"k${String(i).padStart(2, '0')}"`).join(', ')}];\nconsole.log(wide.length);\n`);

w('rtl.js', `// Right-to-left text inside strings
const greetings = {
  ar: "مرحبا بالعالم",
  he: "שלום עולם",
  mixed: "Price: 42 ₪ (שקל)",
};
for (const [k, v] of Object.entries(greetings)) console.log(k, v);
`);

w('emoji.py', `# Emoji and wide characters
STATUS = {"ok": "✅ done", "fail": "❌ broken", "party": "🎉🎉🎉"}
CJK = "日本語のテキスト と 中文 和 한국어"


def show() -> None:
    for key, label in STATUS.items():
        print(f"{key:>6}: {label}")
    print(CJK)
`);

w('nested.tsx', `export function Page({ items }: { items: string[] }) {
  return (
    <main>
      {items.map((item) => (
        <section key={item}>
          <h2 className="title">{item}</h2>
          <p>
            Deep block: the common indent of these lines is removed in the picture.
          </p>
        </section>
      ))}
    </main>
  );
}

function folded() {
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  return a + b + c + d;
}

export const after = folded();
`);

w('mixed-tabs.c', `#include <stdio.h>

int main(void) {
\tint total = 0;            /* tab indent */
    for (int i = 0; i < 4; i++) {   /* space indent */
\t\ttotal += i;\t\t/* tabs inside */
    }
\tprintf("%d\\n", total);
\treturn 0;
}
`);

// hostile: markup in code must be drawn as text, never run
w('hostile-script.html', `<!-- hostile sample: every line must be drawn as text -->
<script>alert("xss")</script>
<svg onload="alert(1)"></svg></svg></text></g>
<a href="javascript:alert(document.cookie)">click</a>
<p>&lt;script&gt; &amp; &#x3C;img src=x onerror=alert(1)&#x3E;</p>
<img src="https://example.com/beacon.png">
<style>@import url("https://example.com/x.css"); body { background: url(https://example.com/bg.png) }</style>
<script>const s = "</script><script>alert(2)</script>";</script>
`);

// hostile file name: the title in the frame comes from it
w('<img src=x onerror=alert(1)>.js', `// the window title is this file name; it must show as text\nconst title = "<b>not bold</b>";\n`);

if (!noLarge) {
  // large: 2,000 lines of TypeScript
  const big = [];
  for (let i = 0; i < 2000; i++) {
    if (i % 20 === 0) big.push(`// section ${i / 20}`);
    else if (i % 20 === 1) big.push(`export function f${i}(x: number): number {`);
    else if (i % 20 === 19) big.push('}');
    else big.push(`  const v${i} = x * ${i} + Math.sqrt(${i}); // line ${i + 1}`);
  }
  w('big.ts', big.join('\n') + '\n');
  // hostile + large: 10 MB of minified JavaScript on one line
  const parts = [];
  let size = 0;
  let k = 0;
  while (size < 10 * 1024 * 1024) {
    const s = `function a${k}(b,c){return b+c*${k}||"x${k}"}var v${k}=a${k}(${k},${k + 1});`;
    parts.push(s); size += s.length; k++;
  }
  w('hostile-min.js', parts.join(''));
}
console.log('samples written to', dir, fs.readdirSync(dir).length, 'files');
