# Canon

A local studio for building a story cycle from its parameters (events, knowledge, scene cards).
The AI renders prose and documents from them; checks run against the canon.

```sh
cd web && npm install && npm run build && cd ..   # build the UI (embedded into the binary)
go build -o canon .
./canon                                           # → http://127.0.0.1:4317
```

Flags: `-db` (default `~/Library/Application Support/Canon/canon.db`), `-addr`, and `-root <story folder>`,
which is only needed for the one-time import on first run (Welcome → Import story folder). The folder is read, never written.

UI development: run `./canon` and `cd web && npm run dev` (Vite proxies /api).
Tests: `go test ./...` and `cd web && npm test`.

All canon lives in SQLite as typed records (project, entity, fact, question, story, scene, guide, note, chat, day).
A fact with a time is an event; questions hold open questions, plot holes and contradictions until you decide them.
Every change is kept: ⌘Z/⌘⇧Z undo and redo across the whole canon (chats, daily word counts and the import are outside undo).
On every start Canon copies the database into a `backups` folder next to it and keeps the newest 10.
ChatGPT uses the official Sign in with ChatGPT flow for open-source apps (plan usage only, no conversation or account access; see developers.openai.com/siwc).
Credentials and model choices live in `~/Library/Application Support/Canon/`.
