package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const (
	opencodeGoBase = "https://opencode.ai/zen/go/v1"
	openrouterBase = "https://openrouter.ai/api/v1"
)

type aiRequest struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	System   string `json:"system"`
	Prompt   string `json:"prompt"`
	Effort   string `json:"effort,omitempty"` // ChatGPT reasoning effort
	// Messages, when set, is a multi-turn conversation (role "user"|"assistant") used instead of Prompt.
	Messages []struct{ Role, Content string } `json:"messages,omitempty"`
}

func (req aiRequest) turns() []struct{ Role, Content string } {
	if len(req.Messages) > 0 {
		return req.Messages
	}
	return []struct{ Role, Content string }{{"user", req.Prompt}}
}

// ai streams model output to the browser as NDJSON lines: {"t":"delta"} … or {"e":"error"}.
func (s *server) ai(w http.ResponseWriter, r *http.Request) {
	var req aiRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(&req); err != nil || req.Model == "" {
		http.Error(w, "provider, model and prompt required", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	flusher, _ := w.(http.Flusher)
	enc := json.NewEncoder(w)
	emit := func(text string) {
		enc.Encode(map[string]string{"t": text})
		if flusher != nil {
			flusher.Flush()
		}
	}

	resp, err := s.upstream(r, req, false)
	if err == nil && resp.StatusCode == http.StatusUnauthorized && req.Provider == "chatgpt" {
		resp.Body.Close()
		resp, err = s.upstream(r, req, true) // refresh once and retry
	}
	if err == nil && resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		var e struct {
			Error *struct{ Code, Message string } `json:"error"`
		}
		msg := strings.TrimSpace(string(b))
		if json.Unmarshal(b, &e) == nil && e.Error != nil {
			msg = explainPlanError(e.Error.Code, e.Error.Message)
		}
		err = fmt.Errorf("%s: %s", resp.Status, msg)
	}
	if err == nil {
		defer resp.Body.Close()
		err = readSSE(resp.Body, req.Provider == "chatgpt", emit)
	}
	if err != nil && r.Context().Err() == nil {
		enc.Encode(map[string]string{"e": err.Error()})
	}
}

func (s *server) upstream(r *http.Request, req aiRequest, forceRefresh bool) (*http.Response, error) {
	var url string
	var body any
	h := http.Header{"Content-Type": {"application/json"}, "Accept": {"text/event-stream"}}

	switch req.Provider {
	case "chatgpt":
		c, err := s.chatgptCred(forceRefresh)
		if err != nil {
			return nil, err
		}
		url = siwcResource + "/responses"
		h.Set("Authorization", "Bearer "+c.Access)
		// SIWC requires store:false + stream:true; system-role input items are rejected, so use instructions.
		b := map[string]any{
			"model":        req.Model,
			"instructions": req.System,
			"input":        responsesInput(req.turns()),
			"stream":       true,
			"store":        false,
		}
		if req.Effort != "" {
			b["reasoning"] = map[string]string{"effort": req.Effort}
		}
		body = b
	case "opencode-go", "openrouter":
		c, ok := s.auth.get(req.Provider)
		if !ok {
			return nil, fmt.Errorf("no key for %s (Settings)", req.Provider)
		}
		url = opencodeGoBase + "/chat/completions"
		if req.Provider == "openrouter" {
			url = openrouterBase + "/chat/completions"
			h.Set("X-Title", "Canon")
		}
		h.Set("Authorization", "Bearer "+c.Key)
		msgs := []map[string]string{}
		if req.System != "" {
			msgs = append(msgs, map[string]string{"role": "system", "content": req.System})
		}
		for _, m := range req.turns() {
			msgs = append(msgs, map[string]string{"role": m.Role, "content": m.Content})
		}
		body = map[string]any{"model": req.Model, "messages": msgs, "stream": true}
	default:
		return nil, fmt.Errorf("unknown provider %q", req.Provider)
	}

	b, _ := json.Marshal(body)
	up, err := http.NewRequestWithContext(r.Context(), http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	up.Header = h
	return http.DefaultClient.Do(up)
}

// responsesInput converts turns to Responses API input items (assistant turns are output_text).
func responsesInput(turns []struct{ Role, Content string }) []any {
	items := []any{}
	for _, t := range turns {
		typ := "input_text"
		if t.Role == "assistant" {
			typ = "output_text"
		}
		items = append(items, map[string]any{"type": "message", "role": t.Role, "content": []any{map[string]string{"type": typ, "text": t.Content}}})
	}
	return items
}

// readSSE parses either Responses-API events or Chat Completions chunks and emits text deltas.
func readSSE(body io.Reader, responses bool, emit func(string)) error {
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	for sc.Scan() {
		data, ok := strings.CutPrefix(sc.Text(), "data:")
		if !ok {
			continue
		}
		data = strings.TrimSpace(data)
		if data == "[DONE]" {
			return nil
		}
		if responses {
			var ev struct {
				Type     string `json:"type"`
				Delta    string `json:"delta"`
				Message  string `json:"message"`
				Response struct {
					Error             *struct{ Code, Message string } `json:"error"`
					IncompleteDetails *struct{ Reason string }        `json:"incomplete_details"`
				} `json:"response"`
			}
			if json.Unmarshal([]byte(data), &ev) != nil {
				continue
			}
			switch ev.Type {
			case "response.output_text.delta":
				emit(ev.Delta)
			case "response.completed":
				return nil
			case "response.failed", "error":
				msg := ev.Message
				if e := ev.Response.Error; e != nil {
					msg = explainPlanError(e.Code, e.Message)
				}
				return errors.New("model error: " + msg)
			case "response.incomplete":
				reason := "unknown reason"
				if d := ev.Response.IncompleteDetails; d != nil {
					reason = d.Reason
				}
				return errors.New("the model stopped early (" + reason + ")")
			}
			continue
		}
		var ch struct {
			Choices []struct {
				Delta struct{ Content string } `json:"delta"`
			} `json:"choices"`
			Error *struct{ Message string } `json:"error"`
		}
		if json.Unmarshal([]byte(data), &ch) != nil {
			continue
		}
		if ch.Error != nil {
			return errors.New("model error: " + ch.Error.Message)
		}
		if len(ch.Choices) > 0 && ch.Choices[0].Delta.Content != "" {
			emit(ch.Choices[0].Delta.Content)
		}
	}
	return sc.Err()
}

// models lists model ids for a provider so the UI can offer a picker.
func (s *server) models(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("provider")
	var url string
	h := http.Header{}
	switch p {
	case "chatgpt":
		c, err := s.chatgptCred(false)
		if err != nil {
			http.Error(w, err.Error(), http.StatusUnauthorized)
			return
		}
		url = siwcResource + "/models"
		h.Set("Authorization", "Bearer "+c.Access)
	case "opencode-go", "openrouter":
		url = opencodeGoBase + "/models"
		if p == "openrouter" {
			url = openrouterBase + "/models"
		}
		if c, ok := s.auth.get(p); ok {
			h.Set("Authorization", "Bearer "+c.Key)
		}
	default:
		http.Error(w, "unknown provider", http.StatusBadRequest)
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, url, nil)
	req.Header = h
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		http.Error(w, "model list: "+resp.Status, http.StatusBadGateway)
		return
	}
	// ChatGPT plan: {models:[{slug, visibility}]}, keep visibility=="list"; OpenAI-compatible: {data:[{id}]}
	var out struct {
		Models []struct {
			Slug       string `json:"slug"`
			Visibility string `json:"visibility"`
		} `json:"models"`
		Data []struct{ ID string } `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	ids := []string{}
	for _, m := range out.Models {
		if m.Visibility == "list" {
			ids = append(ids, m.Slug)
		}
	}
	for _, m := range out.Data {
		ids = append(ids, m.ID)
	}
	writeJSON(w, ids)
}

// explainPlanError turns SIWC plan-usage error codes into something actionable.
func explainPlanError(code, msg string) string {
	switch code {
	case "subscription_sharing_usage_limit_exceeded":
		return "Canon's ChatGPT plan usage limit is reached. Raise or reset it at https://chatgpt.com/settings/usage"
	case "subscription_sharing_user_not_eligible":
		return "this ChatGPT account isn't eligible for plan usage in apps (needs Plus or Pro)"
	case "subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable":
		return "ChatGPT plan usage is temporarily unavailable; try again shortly"
	case "subscription_sharing_unsupported_capability", "subscription_sharing_route_not_supported":
		return "not supported with ChatGPT plan usage: " + msg
	}
	if code != "" {
		return code + ": " + msg
	}
	return msg
}
