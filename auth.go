package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
)

type cred struct {
	Access  string `json:"access,omitempty"`
	Refresh string `json:"refresh,omitempty"`
	Expires int64  `json:"expires,omitempty"` // unix seconds
	Scope   string `json:"scope,omitempty"`
	Key     string `json:"key,omitempty"` // API-key providers
	// ChatGPT registration (kept across sign-outs so re-auth reuses the same app identity)
	ClientID string `json:"clientId,omitempty"`
	HostID   string `json:"hostId,omitempty"`
}

type authStore struct {
	path string
	mu   sync.Mutex
	m    map[string]cred

	pendingMu sync.Mutex
	pending   map[string]pendingLogin // OAuth state (or OpenRouter challenge) → attempt
	login1455 *http.Server
}

type pendingLogin struct{ verifier, nonce, clientID string }

func loadAuth(path string) *authStore {
	a := &authStore{path: path, m: map[string]cred{}, pending: map[string]pendingLogin{}}
	if b, err := os.ReadFile(path); err == nil {
		json.Unmarshal(b, &a.m)
	}
	return a
}

func (a *authStore) get(p string) (cred, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	c, ok := a.m[p]
	return c, ok
}

func (a *authStore) set(p string, c *cred) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if c == nil {
		delete(a.m, p)
	} else {
		a.m[p] = *c
	}
	b, _ := json.MarshalIndent(a.m, "", "  ")
	return writeAtomic(a.path, b, 0o600)
}

func (s *server) authStatus(w http.ResponseWriter, r *http.Request) {
	out := map[string]bool{}
	for _, p := range []string{"chatgpt", "opencode-go", "openrouter"} {
		_, out[p] = s.auth.get(p)
	}
	writeJSON(w, out)
}

func (s *server) putKey(w http.ResponseWriter, r *http.Request) {
	var body struct{ Provider, Key string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Key) == "" {
		http.Error(w, "provider and key required", http.StatusBadRequest)
		return
	}
	if body.Provider != "opencode-go" && body.Provider != "openrouter" {
		http.Error(w, "unknown provider", http.StatusBadRequest)
		return
	}
	if err := s.auth.set(body.Provider, &cred{Key: strings.TrimSpace(body.Key)}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) logout(w http.ResponseWriter, r *http.Request) {
	p := r.PathValue("provider")
	if p == "chatgpt" {
		s.chatgptRevoke()
	}
	s.auth.set(p, nil)
	w.WriteHeader(http.StatusNoContent)
}

func pkce() (verifier, challenge string) {
	verifier = randToken() + randToken() // 64 chars
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

func randToken() string {
	b := make([]byte, 24)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// OpenRouter: official OAuth PKCE that mints a user-controlled API key.
func (s *server) openrouterStart(w http.ResponseWriter, r *http.Request) {
	verifier, challenge := pkce()
	s.auth.pendingMu.Lock()
	s.auth.pending["or:"+challenge] = pendingLogin{verifier: verifier}
	s.auth.pendingMu.Unlock()
	cb := "http://" + r.Host + "/api/auth/openrouter/callback?c=" + url.QueryEscape(challenge)
	q := url.Values{"callback_url": {cb}, "code_challenge": {challenge}, "code_challenge_method": {"S256"}}
	writeJSON(w, map[string]string{"url": "https://openrouter.ai/auth?" + q.Encode()})
}

func (s *server) openrouterCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	s.auth.pendingMu.Lock()
	p, ok := s.auth.pending["or:"+q.Get("c")]
	delete(s.auth.pending, "or:"+q.Get("c"))
	s.auth.pendingMu.Unlock()
	if !ok || q.Get("code") == "" {
		http.Error(w, "OpenRouter sign-in failed: unknown request. Start again from Canon.", http.StatusBadRequest)
		return
	}
	body, _ := json.Marshal(map[string]string{"code": q.Get("code"), "code_verifier": p.verifier, "code_challenge_method": "S256"})
	resp, err := http.Post("https://openrouter.ai/api/v1/auth/keys", "application/json", strings.NewReader(string(body)))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	var out struct{ Key string }
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&out) != nil || out.Key == "" {
		http.Error(w, "OpenRouter key exchange failed: "+resp.Status, http.StatusBadGateway)
		return
	}
	if err := s.auth.set("openrouter", &cred{Key: out.Key}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/#settings", http.StatusFound)
}
