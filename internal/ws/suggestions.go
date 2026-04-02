package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os/exec"
	"time"
)

type suggestion struct {
	Label   string `json:"label"`
	Message string `json:"message"`
}

type suggestionsResult struct {
	Suggestions []suggestion `json:"suggestions"`
}

const suggestionsJSONSchema = `{"type":"object","properties":{"suggestions":{"type":"array","items":{"type":"object","properties":{"label":{"type":"string","description":"Short button label (under 40 chars)"},"message":{"type":"string","description":"Full message to send"}},"required":["label","message"]},"minItems":3,"maxItems":5}},"required":["suggestions"]}`

const suggestionsPrompt = "Based on the conversation so far, suggest 3-5 possible next messages the user might want to send. Focus on natural follow-up actions like asking for refinements, requesting tests, committing changes, or exploring related topics. Keep labels short and messages actionable. Return ONLY the JSON."

// generateSuggestions calls claude CLI to generate reply suggestions for a session.
func (h *Handler) generateSuggestions(claudeSessionID string) ([]suggestion, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, h.command,
		"--resume", claudeSessionID,
		"--fork-session",
		"-p",
		"--output-format", "json",
		"--json-schema", suggestionsJSONSchema,
		"--no-session-persistence",
		suggestionsPrompt,
	)

	log.Printf("Generating suggestions for session %s", claudeSessionID)

	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("claude CLI failed: %w (stderr: %s)", err, stderr.String())
	}

	// Parse the JSON output — the structured_output field contains our data
	var result struct {
		StructuredOutput suggestionsResult `json:"structured_output"`
	}
	if err := json.Unmarshal(output, &result); err != nil {
		return nil, fmt.Errorf("parse suggestions: %w", err)
	}

	return result.StructuredOutput.Suggestions, nil
}
