// Canon: a local studio for building a story cycle from its parameters.
// Serves the embedded web UI, reads/writes the story folder, and proxies AI calls.
package main

import (
	"database/sql"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

//go:embed all:web/dist
var dist embed.FS

type server struct {
	root   string // story folder for import/export ("" disables the file API)
	cfgDir string // ~/Library/Application Support/Canon
	auth   *authStore
	db     *sql.DB
}

func main() {
	cfg, err := os.UserConfigDir()
	if err != nil {
		log.Fatal(err)
	}
	cfgDir := filepath.Join(cfg, "Canon")
	root := flag.String("root", "", "story folder to import from / export to (optional)")
	dbPath := flag.String("db", filepath.Join(cfgDir, "canon.db"), "SQLite database")
	addr := flag.String("addr", "127.0.0.1:4317", "listen address")
	flag.Parse()

	if err := os.MkdirAll(cfgDir, 0o700); err != nil {
		log.Fatal(err)
	}
	s := &server{cfgDir: cfgDir, auth: loadAuth(filepath.Join(cfgDir, "auth.json"))}
	if *root != "" {
		if s.root, err = filepath.Abs(*root); err != nil {
			log.Fatal(err)
		}
		if _, err := os.Stat(s.root); err != nil {
			log.Fatalf("story folder: %v", err)
		}
	}
	if s.db, err = openDB(*dbPath); err != nil {
		log.Fatalf("database: %v", err)
	}
	if err := backup(s.db, filepath.Join(filepath.Dir(*dbPath), "backups")); err != nil {
		log.Printf("backup: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/records", s.listRecords)
	mux.HandleFunc("POST /api/records", s.saveRecords)
	mux.HandleFunc("POST /api/undo", s.undo)
	mux.HandleFunc("POST /api/redo", s.redo)
	mux.HandleFunc("GET /api/history", s.history)
	mux.HandleFunc("POST /api/compile/epub", s.compileEPUB)
	mux.HandleFunc("GET /api/info", s.info)
	mux.HandleFunc("GET /api/tree", s.tree)
	mux.HandleFunc("GET /api/file", s.readFile)
	mux.HandleFunc("PUT /api/file", s.writeFile)
	mux.HandleFunc("GET /api/settings", s.readSettings)
	mux.HandleFunc("PUT /api/settings", s.writeSettings)
	mux.HandleFunc("GET /api/auth/status", s.authStatus)
	mux.HandleFunc("POST /api/auth/chatgpt", s.chatgptStart)
	mux.HandleFunc("POST /api/auth/openrouter", s.openrouterStart)
	mux.HandleFunc("GET /api/auth/openrouter/callback", s.openrouterCallback)
	mux.HandleFunc("PUT /api/auth/key", s.putKey)
	mux.HandleFunc("DELETE /api/auth/{provider}", s.logout)
	mux.HandleFunc("GET /api/models", s.models)
	mux.HandleFunc("POST /api/ai", s.ai)
	sub, _ := fs.Sub(dist, "web/dist")
	mux.Handle("/", http.FileServerFS(sub))

	log.Printf("Canon: db %s, folder %q  →  http://%s", *dbPath, s.root, *addr)
	log.Fatal(http.ListenAndServe(*addr, localOnly(mux)))
}

// localOnly blocks DNS rebinding (Host must be loopback) and cross-site writes (Origin must be loopback).
func localOnly(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isLoopback(r.Host) {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if o := r.Header.Get("Origin"); o != "" && r.Method != http.MethodGet {
			u, err := url.Parse(o)
			if err != nil || !isLoopback(u.Host) {
				http.Error(w, "forbidden origin", http.StatusForbidden)
				return
			}
		}
		h.ServeHTTP(w, r)
	})
}

func isLoopback(hostport string) bool {
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		host = hostport
	}
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func (s *server) info(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]string{"root": s.root})
}

// safePath resolves a slash path inside the story root, rejecting escapes.
func (s *server) safePath(p string) (string, error) {
	if s.root == "" {
		return "", fmt.Errorf("no story folder (start Canon with -root)")
	}
	full := filepath.Join(s.root, filepath.FromSlash(p))
	rel, err := filepath.Rel(s.root, full)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path outside story folder: %q", p)
	}
	return full, nil
}

// tree lists editable text files, skipping dot-dirs (style guides there are read by explicit path).
func (s *server) tree(w http.ResponseWriter, r *http.Request) {
	files := []string{}
	if s.root == "" {
		writeJSON(w, files)
		return
	}
	err := filepath.WalkDir(s.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name := d.Name()
		if d.IsDir() {
			if p != s.root && (strings.HasPrefix(name, ".") || name == "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}
		switch filepath.Ext(name) {
		case ".txt", ".md", ".json":
			rel, _ := filepath.Rel(s.root, p)
			files = append(files, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, files)
}

func (s *server) readFile(w http.ResponseWriter, r *http.Request) {
	p, err := s.safePath(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	b, err := os.ReadFile(p)
	if os.IsNotExist(err) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	} else if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(b)
}

func (s *server) writeFile(w http.ResponseWriter, r *http.Request) {
	p, err := s.safePath(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := writeAtomic(p, b, 0o644); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Settings (model per job) are machine-local and owned by the frontend; stored as an opaque blob.
func (s *server) readSettings(w http.ResponseWriter, r *http.Request) {
	b, err := os.ReadFile(filepath.Join(s.cfgDir, "settings.json"))
	if err != nil {
		b = []byte("{}")
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(b)
}

func (s *server) writeSettings(w http.ResponseWriter, r *http.Request) {
	b, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil || !json.Valid(b) {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if err := writeAtomic(filepath.Join(s.cfgDir, "settings.json"), b, 0o600); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeAtomic(path string, b []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".canon-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), mode); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
