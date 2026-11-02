Self-update payload for 我的眼睛 (My Eyes) {{version}}.

Install or upgrade from inside a DeepSeek Harness session:

```text
eyes { action: "update", source: "github:{{repo}}", ref: "{{tag}}" }
```

Or leave `ref` out to follow the default branch. The asset is the `dist/latest`
layout: `index.js`, `eyes.ps1`, `tools/`, `scripts/`, locale files and a
`MANIFEST.json` with a SHA-256 for every packaged file.

Changes since the previous release are in the commit history below.
