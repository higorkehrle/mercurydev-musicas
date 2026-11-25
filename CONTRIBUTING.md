# Contributing

Thanks for your interest in MercuryDev Músicas. Issues and pull requests are welcome.

## Before you start

- Check the open issues first. For larger changes, open an issue to discuss the idea before writing code.
- **Never commit secrets.** That includes `.env` files, API keys, Spotify tokens, client secrets and database files (`data/`, `*.db`). Use `.env.example` for new variables, with an empty or obviously fake value and a short comment on where to get it.
- **Never commit lyrics, album art or audio.** Tests and demos must use original, fictional content.

## Development

```bash
npm install
cp .env.example .env     # fill in SPOTIFY_CLIENT_ID and TOKEN_ENCRYPTION_KEY
npm run dev
```

Before opening a pull request, run:

```bash
npm run typecheck
npm test
npm run build
```

## Guidelines

- **Code, comments, test names and commit messages are in English.** Keep commits small and focused, with a short imperative title (for example `Add Dutch dictionary`).
- **UI text goes through i18n.** Add the key to `apps/web/src/locales/pt-BR.json` (the source of truth) and to every other dictionary. `npm test` fails if keys or `{placeholders}` diverge.
- **Accessibility.** Keep visible keyboard focus, ARIA labels and AA contrast, and respect `prefers-reduced-motion`.
- **No fake data or claims.** If something depends on Spotify Premium or an API limit, say so in the UI.

## Translations

Native-speaker reviews of the **ja**, **ko**, **zh-CN** and **ru** dictionaries are especially welcome. To add a language, follow [Adding a language](README.md#adding-a-language).
