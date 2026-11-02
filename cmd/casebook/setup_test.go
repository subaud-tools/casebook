package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/BurntSushi/toml"
)

// Exercise the shipped entry point, not an alternate test dispatcher.
func TestSetupBundleBuildOnly(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "casebook")
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	canonical, err := os.ReadFile("kempt.toml")
	if err != nil {
		t.Fatal(err)
	}
	var original map[string]any
	if _, err := toml.Decode(string(canonical), &original); err != nil {
		t.Fatal(err)
	}
	var previous []byte
	for _, invalid := range []bool{false, true} {
		home := t.TempDir()
		if invalid {
			if err := os.WriteFile(filepath.Join(home, "config"), []byte("invalid config path"), 0600); err != nil {
				t.Fatal(err)
			}
		}
		dest := filepath.Join(dir, "setup.tar.gz")
		cmd := exec.Command(bin, "setup-bundle", "--version", "0.25.0-rc.7", "--out", dest)
		cmd.Env = append(os.Environ(), "HOME="+home, "CASEBOOK_HOME="+home, "XDG_CONFIG_HOME="+home, "XDG_STATE_HOME="+home, "XDG_CACHE_HOME="+home)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("setup-bundle: %v %s", err, out)
		}
		entries, err := os.ReadDir(home)
		if err != nil {
			t.Fatal(err)
		}
		want := 0
		if invalid {
			want = 1
		}
		if len(entries) != want {
			t.Fatalf("personal writes: %v", entries)
		}
		data, err := os.ReadFile(dest)
		if err != nil {
			t.Fatal(err)
		}
		if previous != nil && !bytes.Equal(previous, data) {
			t.Fatal("bundle is not deterministic")
		}
		previous = data
	}
	zr, err := gzip.NewReader(bytes.NewReader(previous))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := zr.Close(); err != nil {
			t.Error(err)
		}
	}()
	tr := tar.NewReader(zr)
	files := map[string][]byte{}
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		files[h.Name] = body
	}
	if len(files) != 2 {
		t.Fatalf("unexpected assets: %v", files)
	}
	var meta map[string]any
	if err := json.Unmarshal(files["setup.json"], &meta); err != nil {
		t.Fatal(err)
	}
	if meta["tool"] != "casebook" || meta["version"] != "0.25.0-rc.7" {
		t.Fatalf("identity: %v", meta)
	}
	var doc map[string]any
	if _, err := toml.Decode(string(files["setup.toml"]), &doc); err != nil {
		t.Fatal(err)
	}
	if doc["kempt"].(map[string]any)["spec"] != int64(2) {
		t.Fatal("release binding needs spec 2")
	}
	packages := doc["packages"].(map[string]any)
	if len(packages) != 1 {
		t.Fatal("not integration-only")
	}
	pkg := packages["integration"].(map[string]any)
	steps := pkg["json-merge"].([]map[string]any)
	for i, want := range []struct{ event, matcher, command string }{{"PostToolUse", "Bash", "~/.local/bin/casebook record --harness claude"}, {"SessionStart", "startup|resume", "~/.local/bin/casebook brief"}} {
		rules := steps[i]["remove-hooks"].([]map[string]any)
		expected := []map[string]any{{"event": want.event, "matcher": want.matcher, "commands": []any{want.command}}}
		if !reflect.DeepEqual(rules, expected) {
			t.Fatalf("exact removal: %#v", rules)
		}
		delete(steps[i], "remove-hooks")
	}
	originalPkg := original["packages"].(map[string]any)["casebook"].(map[string]any)
	delete(originalPkg, "download")
	gotJSON, err := json.Marshal(pkg)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON, err := json.Marshal(originalPkg)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotJSON, wantJSON) {
		t.Fatalf("canonical declaration changed: got %#v want %#v", pkg, originalPkg)
	}
}
