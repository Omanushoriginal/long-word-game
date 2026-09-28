# Longword

A small, real-time multiplayer word game. Players race to find a dictionary word in each shuffled 8+ letter rack. It runs on Node.js 20 or later and has no npm dependencies.

## Start it

```sh
npm start
```

Open [http://localhost:4173](http://localhost:4173). No `npm install` is necessary because the game has no third-party Node dependencies.

To let friends join from other devices, deploy the Node server where all players can reach it. Room lists, clocks, scoring, and submissions live on that server; room state is held in memory and resets when the server restarts. Public rooms appear in the open-room list. Private rooms stay out of the list and can be entered using their invite link or code.

## Oxford dictionary

To use Oxford Dictionaries for round-word and answer verification, set an Oxford Dictionaries API app ID and key in the server environment, then restart the server. Keep these credentials in your local environment or your hosting provider's secret settings. **Never commit API credentials to GitHub.**

PowerShell:

```powershell
$env:OXFORD_APP_ID = "your-app-id"
$env:OXFORD_APP_KEY = "your-app-key"
npm start
```

macOS/Linux:

```sh
OXFORD_APP_ID="your-app-id" OXFORD_APP_KEY="your-app-key" npm start
```

The server checks prospective round words against Oxford before displaying them, and checks each answer against Oxford before awarding points. The credentials stay on the server. Oxford's developer API requires account credentials and access to the English dataset; its sandbox has limited coverage. If the Oxford API is not configured, the game clearly reports sample-word mode and checks answers against the bundled demonstration word list instead. Do not use this small sample list as a production dictionary. Oxford Dictionaries API data is a different product from the Oxford English Dictionary.

## Game settings

- Solo play or rooms for up to 12 players.
- Public room listing or private invite link.
- 1–20 rounds and 15 seconds–5 minutes per round.
- One point per letter, or 3/2/1 points for the longest three submissions.
- Server-side clocks, letter rack validation, word verification, and scoring.

## Put it on GitHub

Create an empty repository on GitHub, then run these commands in this folder (replace the remote URL with your own):

```sh
git init
git add .
git commit -m "Add Longword game"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git
git push -u origin main
```

The `.gitignore` file excludes local environment secrets and generated files. This project does not include a license; add one if you want to grant others permission to reuse or modify the code.
