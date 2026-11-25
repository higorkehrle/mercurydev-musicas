# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report them privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. You can also reach MercuryDev through the contact options at https://www.mercurydev.com.br/.

Please include:

- what is affected and the impact;
- steps to reproduce, or a minimal proof of concept;
- the version or commit you tested.

You will get an acknowledgement as soon as possible. Please give the maintainers reasonable time to release a fix before any public disclosure.

## Secrets

- **No secrets in the repository.** Configuration comes from environment variables (`.env`, git-ignored). Only `.env.example`, with empty or placeholder values, is tracked.
- **Spotify login** uses Authorization Code with **PKCE**. There is no client secret, and the public Client ID is read from the environment.
- **Tokens** are stored encrypted on the server (AES-256-GCM, key from `TOKEN_ENCRYPTION_KEY`) and are redacted from logs.
- **If you committed a secret by mistake**, rotate or revoke it at the provider right away. Removing it from the code is not enough, because it stays in git history and forks.

## Supported versions

Only the latest commit on `main` is supported.
