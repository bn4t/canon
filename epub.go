package main

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"time"
)

type epubBook struct {
	Title    string `json:"title"`
	Author   string `json:"author"`
	Chapters []struct {
		Title string `json:"title"`
		HTML  string `json:"html"` // XHTML body fragment, already escaped by the client
	} `json:"chapters"`
}

// compileEPUB zips a minimal EPUB 3 (mimetype, container, OPF, nav, one XHTML file per chapter).
func (s *server) compileEPUB(w http.ResponseWriter, r *http.Request) {
	var b epubBook
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<20)).Decode(&b); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/epub+zip")
	if err := writeEPUB(w, b, time.Now()); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func writeEPUB(out io.Writer, b epubBook, now time.Time) error {
	z := zip.NewWriter(out)
	// The mimetype entry must come first and be stored uncompressed.
	m, err := z.CreateHeader(&zip.FileHeader{Name: "mimetype", Method: zip.Store})
	if err != nil {
		return err
	}
	io.WriteString(m, "application/epub+zip")
	file := func(name, body string) error {
		f, err := z.Create(name)
		if err == nil {
			_, err = io.WriteString(f, body)
		}
		return err
	}
	esc := html.EscapeString
	page := func(title, body string) string {
		return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><meta charset="utf-8"/><title>` + esc(title) + `</title>
<style>body{font-family:serif;line-height:1.5} p{margin:0;text-indent:1.4em} h1+p,h2+p,.sep+p{text-indent:0} .sep{text-align:center;text-indent:0;margin:1em 0} h2{font-size:1em;font-style:italic;font-weight:normal}</style></head><body>` + body + `</body></html>`
	}
	files := []error{
		file("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
	}
	manifest, spine, nav := "", "", ""
	for i, c := range b.Chapters {
		name := fmt.Sprintf("c%d.xhtml", i+1)
		files = append(files, file("OEBPS/"+name, page(c.Title, "<h1>"+esc(c.Title)+"</h1>\n"+c.HTML)))
		manifest += fmt.Sprintf(`<item id="c%d" href="%s" media-type="application/xhtml+xml"/>`, i+1, name)
		spine += fmt.Sprintf(`<itemref idref="c%d"/>`, i+1)
		nav += fmt.Sprintf(`<li><a href="%s">%s</a></li>`, name, esc(c.Title))
	}
	files = append(files,
		file("OEBPS/nav.xhtml", page(b.Title, `<nav epub:type="toc"><h1>Contents</h1><ol>`+nav+`</ol></nav>`)),
		file("OEBPS/book.opf", `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">urn:canon:`+fmt.Sprint(now.UnixNano())+`</dc:identifier><dc:title>`+esc(b.Title)+`</dc:title><dc:creator>`+esc(b.Author)+`</dc:creator><dc:language>en</dc:language>
<meta property="dcterms:modified">`+now.UTC().Format("2006-01-02T15:04:05Z")+`</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`+manifest+`</manifest><spine>`+spine+`</spine></package>`),
	)
	for _, err := range files {
		if err != nil {
			return err
		}
	}
	return z.Close()
}
