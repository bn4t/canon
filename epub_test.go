package main

import (
	"archive/zip"
	"bytes"
	"io"
	"strings"
	"testing"
	"time"
)

func TestWriteEPUB(t *testing.T) {
	var b epubBook
	b.Title, b.Author = "Wrong People", "Ben"
	b.Chapters = append(b.Chapters, struct {
		Title string `json:"title"`
		HTML  string `json:"html"`
	}{"Kira & Co", "<p>Rain.</p>"})
	var buf bytes.Buffer
	if err := writeEPUB(&buf, b, time.Unix(0, 0)); err != nil {
		t.Fatal(err)
	}
	z, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if z.File[0].Name != "mimetype" || z.File[0].Method != zip.Store {
		t.Fatalf("mimetype must be first and stored, got %s/%d", z.File[0].Name, z.File[0].Method)
	}
	files := map[string]string{}
	for _, f := range z.File {
		r, _ := f.Open()
		data, _ := io.ReadAll(r)
		files[f.Name] = string(data)
	}
	if !strings.Contains(files["OEBPS/c1.xhtml"], "<h1>Kira &amp; Co</h1>") || !strings.Contains(files["OEBPS/book.opf"], `idref="c1"`) {
		t.Fatalf("chapter missing: %v", files)
	}
}
