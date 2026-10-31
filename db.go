package main

// Canon's store: typed records (JSON per record) in SQLite, with a change history that
// backs undo/redo and per-record version lists.
// ponytail: JSON-per-record, the frontend owns the schemas; normalize tables if we ever need SQL queries over fields.

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS records (
  id      TEXT PRIMARY KEY,
  kind    TEXT NOT NULL,
  data    TEXT NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  grp    TEXT NOT NULL,
  label  TEXT NOT NULL DEFAULT '',
  record TEXT NOT NULL,
  kind   TEXT NOT NULL,
  prev   TEXT,              -- NULL: record did not exist before
  next   TEXT,              -- NULL: record was deleted
  at     INTEGER NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS history_record ON history(record, seq);
CREATE INDEX IF NOT EXISTS history_grp ON history(grp);
`

func openDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // one writer; keeps transactions simple
	_, err = db.Exec(schema)
	return db, err
}

type record struct {
	ID      string          `json:"id"`
	Kind    string          `json:"kind"`
	Data    json.RawMessage `json:"data"`
	Updated int64           `json:"updated,omitempty"`
}

func (s *server) listRecords(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(`SELECT id, kind, data, updated FROM records`)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	out := []record{}
	for rows.Next() {
		var rec record
		var data string
		if err := rows.Scan(&rec.ID, &rec.Kind, &data, &rec.Updated); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		rec.Data = json.RawMessage(data)
		out = append(out, rec)
	}
	writeJSON(w, out)
}

type changeSet struct {
	Group string `json:"group"` // edits with the same group undo together; repeated edits to a record in one group coalesce
	Label string `json:"label"`
	// Baseline writes (import, first-run setup) aren't recorded, so undo can never go back past them.
	Baseline bool `json:"baseline"`
	Changes  []struct {
		ID   string          `json:"id"`
		Kind string          `json:"kind"`
		Data json.RawMessage `json:"data"` // null deletes
	} `json:"changes"`
}

// saveRecords applies a change set in one transaction and records history.
func (s *server) saveRecords(w http.ResponseWriter, r *http.Request) {
	var cs changeSet
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<20)).Decode(&cs); err != nil || cs.Group == "" {
		http.Error(w, "group and changes required", http.StatusBadRequest)
		return
	}
	err := s.tx(func(tx *sql.Tx) error {
		// A new edit invalidates the redo stack. Chats and writing history aren't part of undo, so they don't.
		for _, c := range cs.Changes {
			if c.Kind != "chat" && c.Kind != "day" {
				if _, err := tx.Exec(`DELETE FROM history WHERE undone = 1`); err != nil {
					return err
				}
				break
			}
		}
		now := time.Now().UnixMilli()
		for _, c := range cs.Changes {
			if c.ID == "" {
				return errors.New("change without id")
			}
			deleting := len(c.Data) == 0 || string(c.Data) == "null"
			if !deleting && !json.Valid(c.Data) {
				return errors.New("invalid json for " + c.ID)
			}
			var prev sql.NullString
			var kind string
			err := tx.QueryRow(`SELECT data, kind FROM records WHERE id = ?`, c.ID).Scan(&prev, &kind)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if c.Kind != "" {
				kind = c.Kind
			}
			if kind == "" {
				return errors.New("kind required for new record " + c.ID)
			}
			next := sql.NullString{String: string(c.Data), Valid: !deleting}
			if deleting {
				if _, err := tx.Exec(`DELETE FROM records WHERE id = ?`, c.ID); err != nil {
					return err
				}
			} else if _, err := tx.Exec(`INSERT INTO records (id, kind, data, updated) VALUES (?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, data = excluded.data, updated = excluded.updated`,
				c.ID, kind, next.String, now); err != nil {
				return err
			}
			if cs.Baseline {
				continue
			}
			// Coalesce: if this record's latest history row is from the same group, just move its "next".
			var seq int64
			var grp string
			err = tx.QueryRow(`SELECT seq, grp FROM history WHERE record = ? ORDER BY seq DESC LIMIT 1`, c.ID).Scan(&seq, &grp)
			if err == nil && grp == cs.Group {
				_, err = tx.Exec(`UPDATE history SET next = ?, at = ? WHERE seq = ?`, next, now, seq)
			} else {
				_, err = tx.Exec(`INSERT INTO history (grp, label, record, kind, prev, next, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
					cs.Group, cs.Label, c.ID, kind, prev, next, now)
			}
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// undo reverts the latest group that isn't undone; redo re-applies the earliest undone group.
// Chat records (interview and assistant transcripts) are never undone.
func (s *server) undo(w http.ResponseWriter, r *http.Request) { s.step(w, true) }
func (s *server) redo(w http.ResponseWriter, r *http.Request) { s.step(w, false) }

func (s *server) step(w http.ResponseWriter, undo bool) {
	var label string
	var ids []string
	err := s.tx(func(tx *sql.Tx) error {
		q := `SELECT grp, label FROM history WHERE undone = 0 AND kind NOT IN ('chat', 'day') ORDER BY seq DESC LIMIT 1`
		if !undo {
			q = `SELECT grp, label FROM history WHERE undone = 1 AND kind NOT IN ('chat', 'day') ORDER BY seq ASC LIMIT 1`
		}
		var grp string
		if err := tx.QueryRow(q).Scan(&grp, &label); err != nil {
			return err
		}
		order := "DESC"
		if !undo {
			order = "ASC"
		}
		rows, err := tx.Query(`SELECT seq, record, kind, prev, next FROM history WHERE grp = ? AND kind NOT IN ('chat', 'day') ORDER BY seq `+order, grp)
		if err != nil {
			return err
		}
		type row struct {
			seq        int64
			id, kind   string
			prev, next sql.NullString
		}
		var all []row
		for rows.Next() {
			var x row
			if err := rows.Scan(&x.seq, &x.id, &x.kind, &x.prev, &x.next); err != nil {
				rows.Close()
				return err
			}
			all = append(all, x)
		}
		rows.Close()
		now := time.Now().UnixMilli()
		for _, x := range all {
			target := x.next
			if undo {
				target = x.prev
			}
			if target.Valid {
				_, err = tx.Exec(`INSERT INTO records (id, kind, data, updated) VALUES (?, ?, ?, ?)
					ON CONFLICT(id) DO UPDATE SET data = excluded.data, kind = excluded.kind, updated = excluded.updated`, x.id, x.kind, target.String, now)
			} else {
				_, err = tx.Exec(`DELETE FROM records WHERE id = ?`, x.id)
			}
			if err != nil {
				return err
			}
			ids = append(ids, x.id)
		}
		flag := 0
		if undo {
			flag = 1
		}
		_, err = tx.Exec(`UPDATE history SET undone = ? WHERE grp = ?`, flag, grp)
		return err
	})
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, map[string]any{"label": "", "ids": []string{}})
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"label": label, "ids": ids})
}

// history lists recent versions of one record (newest first) for the "History" panel.
func (s *server) history(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.Query(`SELECT seq, label, at, prev FROM history WHERE record = ? AND undone = 0 ORDER BY seq DESC LIMIT ?`,
		r.URL.Query().Get("record"), limit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	type version struct {
		Seq   int64           `json:"seq"`
		Label string          `json:"label"`
		At    int64           `json:"at"`
		Prev  json.RawMessage `json:"prev"` // the record before this change
	}
	out := []version{}
	for rows.Next() {
		var v version
		var prev sql.NullString
		if err := rows.Scan(&v.Seq, &v.Label, &v.At, &prev); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if prev.Valid {
			v.Prev = json.RawMessage(prev.String)
		} else {
			v.Prev = json.RawMessage("null")
		}
		out = append(out, v)
	}
	writeJSON(w, out)
}

func (s *server) tx(fn func(*sql.Tx) error) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// backup copies the database into dir (one file per start) and keeps the newest 10.
func backup(db *sql.DB, dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	name := filepath.Join(dir, "canon-"+time.Now().Format("2006-01-02-150405")+".db")
	if _, err := db.Exec(`VACUUM INTO ?`, name); err != nil {
		return err
	}
	old, _ := filepath.Glob(filepath.Join(dir, "canon-*.db"))
	sort.Strings(old)
	for len(old) > 10 {
		os.Remove(old[0])
		old = old[1:]
	}
	return nil
}
