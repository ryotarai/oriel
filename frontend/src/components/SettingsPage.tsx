import { useState, useEffect } from "react";

interface Config {
  swapEnterKeys: boolean;
  swapPaneWidthOnFocus: boolean;
}

export function SettingsPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setConfig({ swapEnterKeys: true, swapPaneWidthOnFocus: false }));
  }, []);

  const updateConfig = async (updates: Partial<Config>) => {
    if (!config) return;
    const next = { ...config, ...updates };
    setSaving(true);
    try {
      await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      setConfig(next);
    } catch {}
    setSaving(false);
  };

  if (!config) return <div className="text-gray-500 text-sm p-4">Loading...</div>;

  return (
    <div className="p-6 max-w-lg">
      <div className="space-y-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={config.swapEnterKeys}
            onChange={(e) => updateConfig({ swapEnterKeys: e.target.checked })}
            disabled={saving}
            className="accent-blue-500 w-4 h-4"
          />
          <div>
            <div className="text-gray-200 text-sm">Swap Enter / Cmd+Enter</div>
            <div className="text-gray-500 text-xs mt-0.5">
              When enabled, Enter inserts a newline and Cmd+Enter sends the message (at Claude's ❯ prompt)
            </div>
          </div>
        </label>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={config.swapPaneWidthOnFocus}
            onChange={(e) => updateConfig({ swapPaneWidthOnFocus: e.target.checked })}
            disabled={saving}
            className="accent-blue-500 w-4 h-4"
          />
          <div>
            <div className="text-gray-200 text-sm">Swap Pane Width on Focus</div>
            <div className="text-gray-500 text-xs mt-0.5">
              When enabled, pane widths are swapped when focus moves to another pane
            </div>
          </div>
        </label>
      </div>
    </div>
  );
}
