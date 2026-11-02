package main

import (
	"bytes"
	_ "embed"
	"slices"

	"github.com/BurntSushi/toml"
	"github.com/subaud-tools/tools-common/setupbundle"
)

//go:embed kempt.toml
var setupManifest string

// setupSource derives the release fragment from the direct-install declaration.
// The owning download supplies the binary; personal data and global Git hook
// chaining remain explicit actions, not release setup operations.
func setupSource() setupbundle.Source {
	var doc map[string]any
	if _, err := toml.Decode(setupManifest, &doc); err != nil {
		panic(err) // The embedded declaration is validated by the producer test.
	}
	pkg := doc["packages"].(map[string]any)["casebook"].(map[string]any)
	delete(pkg, "download")
	for _, step := range pkg["json-merge"].([]map[string]any) {
		merge, _ := step["merge"].(map[string]any)
		hooks, _ := merge["hooks"].(map[string]any)
		var events []string
		for event := range hooks {
			events = append(events, event)
		}
		slices.Sort(events)
		var removals []map[string]any
		for _, event := range events {
			for _, value := range hooks[event].([]any) {
				group := value.(map[string]any)
				var commands []string
				for _, value := range group["hooks"].([]any) {
					hook := value.(map[string]any)
					if hook["type"] == "command" {
						commands = append(commands, hook["command"].(string))
					}
				}
				if len(commands) > 0 {
					removals = append(removals, map[string]any{
						"event": event, "matcher": group["matcher"], "commands": commands,
					})
				}
			}
		}
		if len(removals) > 0 {
			// The shared engine removes these exact identities before merging.
			step["remove-hooks"] = removals
		}
	}
	doc["kempt"] = map[string]int{"spec": 2}
	doc["packages"] = map[string]any{"integration": pkg}
	var manifest bytes.Buffer
	if err := toml.NewEncoder(&manifest).Encode(doc); err != nil {
		panic(err) // Only TOML-decoded values and the declarations above occur.
	}
	return setupbundle.Source{Manifest: manifest.Bytes()}
}
