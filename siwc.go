package main

// Official "Sign in with ChatGPT" for open-source/local apps (developers.openai.com/siwc).
// Canon registers itself as a user-defined agent and requests plan usage only:
// the token can make eligible Responses API requests on the user's plan and does not
// grant access to ChatGPT conversations or other account context.

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	siwcIssuer    = "https://auth.openai.com"
	siwcAuthorize = siwcIssuer + "/api/accounts/authorize"
	siwcToken     = siwcIssuer + "/api/accounts/oauth/token"
	siwcResource  = "https://api.openai.com/v1"
	siwcRedirect  = "http://127.0.0.1:1455/auth/callback" // docs: loopback IP, not "localhost"
	siwcScope     = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
	siwcPlanScope = "chatgpt.tokens.use.direct"
	siwcRegKey    = "chatgpt-registration"
)

// chatgptStart opens a one-shot callback listener on 127.0.0.1:1455 and returns the authorize URL.
func (s *server) chatgptStart(w http.ResponseWriter, r *http.Request) {
	reg, _ := s.auth.get(siwcRegKey)
	if reg.HostID == "" { // stable per install
		reg.HostID = "urn:uuid:" + uuid4()
		s.auth.set(siwcRegKey, &reg)
	}
	clientID := reg.ClientID
	if clientID == "" {
		clientID = "dynamic_agent_client" // first-time registration entrypoint
	}
	verifier, challenge := pkce()
	state, nonce := randToken(), randToken()

	a := s.auth
	a.pendingMu.Lock()
	a.pending[state] = pendingLogin{verifier: verifier, nonce: nonce, clientID: clientID}
	if a.login1455 == nil {
		ln, err := net.Listen("tcp", "127.0.0.1:1455")
		if err != nil {
			a.pendingMu.Unlock()
			http.Error(w, "port 1455 is busy (is another ChatGPT sign-in running, e.g. Codex?): "+err.Error(), http.StatusConflict)
			return
		}
		mux := http.NewServeMux()
		mux.HandleFunc("GET /auth/callback", s.chatgptCallback)
		srv := &http.Server{Handler: mux}
		go srv.Serve(ln)
		a.login1455 = srv
		time.AfterFunc(10*time.Minute, a.stopLoginServer)
	}
	a.pendingMu.Unlock()

	q := url.Values{
		"client_id":             {clientID},
		"ext_agent_host_id":     {reg.HostID},
		"response_type":         {"code"},
		"redirect_uri":          {siwcRedirect},
		"scope":                 {siwcScope},
		"resource":              {siwcResource},
		"state":                 {state},
		"nonce":                 {nonce},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
	}
	if reg.ClientID == "" {
		q.Set("agent_name_hint", "Canon")
	}
	writeJSON(w, map[string]string{"url": siwcAuthorize + "?" + q.Encode()})
}

func (a *authStore) stopLoginServer() {
	a.pendingMu.Lock()
	defer a.pendingMu.Unlock()
	if a.login1455 != nil {
		srv := a.login1455
		a.login1455 = nil
		go srv.Shutdown(context.Background())
	}
}

func (s *server) chatgptCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	s.auth.pendingMu.Lock()
	p, ok := s.auth.pending[q.Get("state")]
	delete(s.auth.pending, q.Get("state"))
	s.auth.pendingMu.Unlock()
	page := func(status int, msg string) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(status)
		fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>Canon</title><body style="font:16px system-ui;padding:40px;max-width:560px">%s`, msg)
	}
	switch {
	case !ok:
		page(http.StatusBadRequest, "Sign-in failed: this request is unknown or expired. Start again from Canon.")
		return
	case q.Get("error") != "":
		page(http.StatusOK, "Sign-in was cancelled ("+htmlEscape(q.Get("error"))+"). You can close this tab.")
		return
	case q.Get("code") == "":
		page(http.StatusBadRequest, "Sign-in failed: no authorization code. Start again from Canon.")
		return
	}

	clientID := p.clientID
	if clientID == "dynamic_agent_client" {
		clientID = q.Get("client_id")
		if clientID == "" {
			page(http.StatusBadGateway, "Sign-in failed: OpenAI did not return a client ID for Canon.")
			return
		}
		reg, _ := s.auth.get(siwcRegKey)
		reg.ClientID = clientID
		s.auth.set(siwcRegKey, &reg) // keep the registration even if the exchange below fails
	}

	tok, err := siwcTokenRequest(url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {clientID},
		"code":          {q.Get("code")},
		"code_verifier": {p.verifier},
		"redirect_uri":  {siwcRedirect},
		"resource":      {siwcResource},
	})
	if err == nil {
		err = verifyIDToken(tok.IDToken, clientID, p.nonce)
	}
	if err == nil && !hasScope(tok.Scope, siwcPlanScope) {
		err = errors.New("ChatGPT plan usage was not granted. Plan usage needs ChatGPT Plus or Pro and approval on the consent screen")
	}
	if err == nil {
		err = s.auth.set("chatgpt", tok.cred(""))
	}
	if err != nil {
		page(http.StatusBadGateway, "Sign-in failed: "+htmlEscape(err.Error()))
		return
	}
	page(http.StatusOK, `<b>You're using your ChatGPT plan in Canon.</b><p>Canon can make model requests on your plan. It can't see your ChatGPT conversations or account. Usage counts toward your plan's limits; set a cap for Canon at <a href="https://chatgpt.com/settings/usage">ChatGPT Settings → Usage</a>.</p><p>You can close this tab.</p>`)
	go s.auth.stopLoginServer()
}

type siwcTokens struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	ExpiresIn    int64  `json:"expires_in"`
	Scope        string `json:"scope"`
}

func (t siwcTokens) cred(prevRefresh string) *cred {
	c := &cred{Access: t.AccessToken, Refresh: t.RefreshToken, Scope: t.Scope, Expires: time.Now().Unix() + t.ExpiresIn}
	if c.Refresh == "" {
		c.Refresh = prevRefresh
	}
	if t.ExpiresIn == 0 {
		c.Expires = time.Now().Unix() + 3600
	}
	return c
}

func siwcTokenRequest(form url.Values) (siwcTokens, error) {
	var t siwcTokens
	resp, err := http.PostForm(siwcToken, form)
	if err != nil {
		return t, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error            string `json:"error"`
			ErrorDescription string `json:"error_description"`
		}
		json.NewDecoder(resp.Body).Decode(&e)
		return t, fmt.Errorf("token endpoint %s: %s %s", resp.Status, e.Error, e.ErrorDescription)
	}
	return t, json.NewDecoder(resp.Body).Decode(&t)
}

var refreshMu sync.Mutex // refresh tokens rotate; never refresh concurrently

// chatgptCred returns a fresh credential, refreshing when near expiry or when forced.
func (s *server) chatgptCred(force bool) (cred, error) {
	refreshMu.Lock()
	defer refreshMu.Unlock()
	c, ok := s.auth.get("chatgpt")
	if !ok {
		return c, errors.New("not signed in to ChatGPT (Settings → Sign in with ChatGPT)")
	}
	if !hasScope(c.Scope, siwcPlanScope) {
		return c, errors.New("ChatGPT plan usage was not granted; sign in again and approve it")
	}
	if !force && c.Expires > time.Now().Unix()+60 {
		return c, nil
	}
	reg, _ := s.auth.get(siwcRegKey)
	t, err := siwcTokenRequest(url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {reg.ClientID},
		"refresh_token": {c.Refresh},
		"resource":      {siwcResource},
	})
	if err != nil {
		s.auth.set("chatgpt", nil) // docs: on refresh failure, clear tokens and sign in again
		return c, fmt.Errorf("ChatGPT session ended, sign in again: %w", err)
	}
	n := t.cred(c.Refresh)
	if n.Scope == "" {
		n.Scope = c.Scope
	}
	return *n, s.auth.set("chatgpt", n)
}

// chatgptRevoke revokes the refresh token (best effort). The app registration itself stays.
func (s *server) chatgptRevoke() {
	c, ok := s.auth.get("chatgpt")
	reg, _ := s.auth.get(siwcRegKey)
	if !ok || c.Refresh == "" {
		return
	}
	var disc struct {
		RevocationEndpoint string `json:"revocation_endpoint"`
	}
	if err := getJSON(siwcIssuer+"/.well-known/openid-configuration", &disc); err != nil || disc.RevocationEndpoint == "" {
		return
	}
	resp, err := http.PostForm(disc.RevocationEndpoint, url.Values{"token": {c.Refresh}, "token_type_hint": {"refresh_token"}, "client_id": {reg.ClientID}})
	if err == nil {
		resp.Body.Close()
	}
}

type jwk struct{ Kid, Kty, N, E, Crv, X, Y string }

// verifyIDToken checks signature (OpenAI's JWKS), issuer, audience, expiry and nonce.
func verifyIDToken(tok, clientID, nonce string) error {
	var jwks struct{ Keys []jwk }
	if err := getJSON(siwcIssuer+"/.well-known/jwks.json", &jwks); err != nil {
		return fmt.Errorf("fetching JWKS: %w", err)
	}
	return verifyIDTokenWith(jwks.Keys, tok, clientID, nonce)
}

func verifyIDTokenWith(keys []jwk, tok, clientID, nonce string) error {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return errors.New("malformed ID token")
	}
	var hdr struct{ Alg, Kid string }
	if err := decodeSegment(parts[0], &hdr); err != nil {
		return err
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return err
	}
	i := slices.IndexFunc(keys, func(k jwk) bool { return k.Kid == hdr.Kid })
	if i < 0 {
		return errors.New("ID token signed with an unknown key")
	}
	k := keys[i]
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	switch {
	case hdr.Alg == "RS256" && k.Kty == "RSA":
		n, e := b64int(k.N), b64int(k.E)
		if n == nil || e == nil {
			return errors.New("bad RSA key in JWKS")
		}
		if err := rsa.VerifyPKCS1v15(&rsa.PublicKey{N: n, E: int(e.Int64())}, crypto.SHA256, digest[:], sig); err != nil {
			return errors.New("ID token signature is invalid")
		}
	case hdr.Alg == "ES256" && k.Kty == "EC" && k.Crv == "P-256":
		x, _ := base64.RawURLEncoding.DecodeString(k.X)
		y, _ := base64.RawURLEncoding.DecodeString(k.Y)
		pub, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), append(append([]byte{4}, x...), y...))
		if err != nil || len(sig) != 64 {
			return errors.New("bad EC key or signature")
		}
		if !ecdsa.Verify(pub, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
			return errors.New("ID token signature is invalid")
		}
	default:
		return fmt.Errorf("unsupported ID token algorithm %q", hdr.Alg)
	}

	var c struct {
		Iss   string          `json:"iss"`
		Aud   json.RawMessage `json:"aud"`
		Exp   float64         `json:"exp"`
		Nonce string          `json:"nonce"`
	}
	if err := decodeSegment(parts[1], &c); err != nil {
		return err
	}
	var auds []string
	if json.Unmarshal(c.Aud, &auds) != nil {
		var one string
		json.Unmarshal(c.Aud, &one)
		auds = []string{one}
	}
	switch {
	case c.Iss != siwcIssuer:
		return errors.New("ID token issuer mismatch")
	case !slices.Contains(auds, clientID):
		return errors.New("ID token audience mismatch")
	case float64(time.Now().Unix()-5) > c.Exp:
		return errors.New("ID token expired")
	case c.Nonce != nonce:
		return errors.New("ID token nonce mismatch")
	}
	return nil
}

func decodeSegment(seg string, v any) error {
	b, err := base64.RawURLEncoding.DecodeString(seg)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func b64int(s string) *big.Int {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || len(b) == 0 {
		return nil
	}
	return new(big.Int).SetBytes(b)
}

func getJSON(u string, v any) error {
	resp, err := http.Get(u)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return errors.New(resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

func hasScope(scopes, want string) bool { return slices.Contains(strings.Fields(scopes), want) }

func uuid4() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func htmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}
