# dsh-humanizer pattern reference

Source: [liuwenji007/dsh-humanizer](https://github.com/liuwenji007/dsh-humanizer)

Pinned revision: `a1f221630403496c00bbbbaa5814dd1b48c78438` (2026-09-03).

Copyright (c) 2026 liuwenji007. Distributed under the accompanying MIT LICENSE.

`patterns.js` preserves the upstream PATTERNS table for provenance; the original
scoring/detection function and Harness entry point are not included or executed.
The upstream table cites [blader/humanizer](https://github.com/blader/humanizer)
for its English pattern taxonomy. That upstream is also MIT-licensed, copyright
(c) 2025 Siqi Chen; its copyright and the shared MIT permission notice are
preserved in LICENSE. No upstream skill instructions or rewrite workflow are
installed.

The companion's `speech.mjs` uses a separately implemented chat-oriented checker
and short generation guidance informed by the source's positive style/fact
preservation principles. It does not import this reference, classify authors,
compute an AI or human probability, rewrite text, penalize ordinary emoji, or
change facts/personas. Code, quotations, links, media markers and numeric data
are protected before any optional wording hints are produced.
