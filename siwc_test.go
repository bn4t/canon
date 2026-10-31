package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"testing"
	"time"
)

func TestVerifyIDToken(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	b64 := base64.RawURLEncoding.EncodeToString
	keys := []jwk{{Kid: "k1", Kty: "RSA", N: b64(key.N.Bytes()), E: b64(big.NewInt(int64(key.E)).Bytes())}}
	sign := func(claims map[string]any) string {
		h, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": "k1"})
		c, _ := json.Marshal(claims)
		in := b64(h) + "." + b64(c)
		d := sha256.Sum256([]byte(in))
		sig, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, d[:])
		return in + "." + b64(sig)
	}
	good := map[string]any{"iss": siwcIssuer, "aud": []string{"oaiapp_x"}, "exp": time.Now().Add(time.Hour).Unix(), "nonce": "n1"}
	if err := verifyIDTokenWith(keys, sign(good), "oaiapp_x", "n1"); err != nil {
		t.Fatalf("valid token rejected: %v", err)
	}
	bad := map[string]map[string]any{
		"issuer":   {"iss": "https://evil", "aud": "oaiapp_x", "exp": good["exp"], "nonce": "n1"},
		"audience": {"iss": siwcIssuer, "aud": "oaiapp_other", "exp": good["exp"], "nonce": "n1"},
		"expired":  {"iss": siwcIssuer, "aud": "oaiapp_x", "exp": time.Now().Add(-time.Hour).Unix(), "nonce": "n1"},
		"nonce":    {"iss": siwcIssuer, "aud": "oaiapp_x", "exp": good["exp"], "nonce": "other"},
	}
	for name, c := range bad {
		if verifyIDTokenWith(keys, sign(c), "oaiapp_x", "n1") == nil {
			t.Errorf("%s: invalid token accepted", name)
		}
	}
	tampered := sign(good)
	tampered = tampered[:len(tampered)-4] + "AAAA"
	if verifyIDTokenWith(keys, tampered, "oaiapp_x", "n1") == nil {
		t.Error("tampered signature accepted")
	}
}
