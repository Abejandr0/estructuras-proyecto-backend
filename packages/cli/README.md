# AIVerse CLI

`aiverse-cli` provides the `aiverse` terminal command for importing local projects into AIVerse repositories and publishing updates.

## Install

Requires Node.js 20 or newer.

```sh
npm install --global aiverse-cli
aiverse --help
```

## Publish a local project

Create a repository in AIVerse first, then from the project directory run:

```sh
aiverse init
aiverse add src package.json
aiverse status
aiverse commit -m "Import project"
aiverse remote add origin https://aiverse.example/api/repositories/REPOSITORY_ID
aiverse auth login https://aiverse.example
aiverse push main
```

Create a CLI token in **Account → CLI access**. `aiverse auth login` prompts for it without echoing the token and stores it in the current user's configuration directory. Tokens can be revoked from the account page.

Review the files before committing. The CLI does not apply `.gitignore` rules yet, so add only paths you intend to publish. Never commit API keys, passwords, `.env` files, or other secrets.

## Clone a public repository

```sh
aiverse clone https://aiverse.example/api/repositories/REPOSITORY_ID ./project
```

Public repositories can be viewed and cloned without a token. Only the owner can push changes to a repository.
