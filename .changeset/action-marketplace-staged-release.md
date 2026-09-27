---
'supabase-grants-lint': patch
---

The GitHub Action's description is now short enough for the GitHub Marketplace (under 125 characters), and the actions it uses (`actions/setup-node`, `github/codeql-action/upload-sarif`) are pinned to full commit SHAs. Releases are now staged on npm by CI through trusted publishing, with provenance, and go live only after a maintainer approves them with 2FA.
