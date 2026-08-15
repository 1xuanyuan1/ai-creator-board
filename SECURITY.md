# Security Policy

Please report vulnerabilities privately to the repository owner before opening a public issue.

AI Creator Board never needs API keys in its public repository or private data repository. Keep Codex authentication, Git credentials and Bitto login state in their normal local credential stores. Do not attach `.env`, cookies, keychain exports, `~/.codex/sessions` or raw browser profiles to bug reports.

The data synchronizer permits fast-forward updates only. On divergence, network failure or an unexpected dirty data repository, it enters read-only mode and stops claiming work.
