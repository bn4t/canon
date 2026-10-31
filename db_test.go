package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRecordsUndoRedo(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	s := &server{db: db}
	save := func(body string) {
		w := httptest.NewRecorder()
		s.saveRecords(w, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body)))
		if w.Code != http.StatusNoContent {
			t.Fatalf("save: %d %s", w.Code, w.Body)
		}
	}
	get := func() map[string]string {
		w := httptest.NewRecorder()
		s.listRecords(w, httptest.NewRequest(http.MethodGet, "/", nil))
		var recs []record
		json.Unmarshal(w.Body.Bytes(), &recs)
		m := map[string]string{}
		for _, r := range recs {
			m[r.ID] = string(r.Data)
		}
		return m
	}
	step := func(undo bool) {
		w := httptest.NewRecorder()
		s.step(w, undo)
		if w.Code != http.StatusOK {
			t.Fatalf("step: %d %s", w.Code, w.Body)
		}
	}

	save(`{"group":"g1","changes":[{"id":"a","kind":"scene","data":{"t":1}}]}`)
	save(`{"group":"g2","changes":[{"id":"a","data":{"t":2}}]}`)
	save(`{"group":"g2","changes":[{"id":"a","data":{"t":3}}]}`) // coalesces into g2
	save(`{"group":"g3","changes":[{"id":"a","data":null},{"id":"b","kind":"scene","data":{"t":9}}]}`)
	if m := get(); m["a"] != "" || m["b"] != `{"t":9}` {
		t.Fatalf("after g3: %v", m)
	}
	step(true) // undo g3: a back, b gone
	if m := get(); m["a"] != `{"t":3}` || m["b"] != "" {
		t.Fatalf("undo g3: %v", m)
	}
	step(true) // undo g2 (both coalesced edits at once)
	if m := get(); m["a"] != `{"t":1}` {
		t.Fatalf("undo g2: %v", m)
	}
	step(false) // redo g2
	if m := get(); m["a"] != `{"t":3}` {
		t.Fatalf("redo g2: %v", m)
	}
	save(`{"group":"g4","changes":[{"id":"a","data":{"t":4}}]}`) // new edit clears redo (g3)
	step(false)
	if m := get(); m["a"] != `{"t":4}` || m["b"] != "" {
		t.Fatalf("redo after new edit should do nothing: %v", m)
	}

	// Chat transcripts are outside undo: undo skips them and they don't clear redo.
	save(`{"group":"g4","changes":[{"id":"q","kind":"question","data":{"answer":"x"}}]}`)
	save(`{"group":"g5","changes":[{"id":"c","kind":"chat","data":{"n":1}}]}`)
	step(true)
	if m := get(); m["q"] != "" || m["c"] != `{"n":1}` {
		t.Fatalf("undo past chat: %v", m)
	}
	save(`{"group":"g6","changes":[{"id":"c","kind":"chat","data":{"n":2}}]}`)
	step(false)
	if m := get(); m["q"] != `{"answer":"x"}` || m["c"] != `{"n":2}` {
		t.Fatalf("redo after chat: %v", m)
	}

	// Baseline writes (import) are invisible to undo.
	save(`{"group":"g7","baseline":true,"changes":[{"id":"base","kind":"series","data":{"t":0}}]}`)
	step(true)
	if m := get(); m["base"] != `{"t":0}` || m["q"] != "" {
		t.Fatalf("undo crossed baseline: %v", m)
	}
}

func TestBackupKeepsTen(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "c.db"))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	for i := 0; i < 12; i++ {
		os.WriteFile(filepath.Join(dir, fmt.Sprintf("canon-2000-01-01-0000%02d.db", i)), nil, 0o600)
	}
	if err := backup(db, dir); err != nil {
		t.Fatal(err)
	}
	got, _ := filepath.Glob(filepath.Join(dir, "canon-*.db"))
	if len(got) != 10 {
		t.Fatalf("want 10 backups, got %d", len(got))
	}
}
