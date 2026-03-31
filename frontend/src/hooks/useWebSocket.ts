import { useEffect, useRef, useCallback, useState } from "react";

export interface ConversationEntry {
  type: string;
  role: string;
  uuid: string;
  text: string;
  isThinking?: boolean;
}

interface UseWebSocketOptions {
  url: string;
  onOutput: (data: Uint8Array) => void;
  onExit: () => void;
  onConversation: (entry: ConversationEntry) => void;
}

export function useWebSocket({ url, onOutput, onExit, onConversation }: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "output") {
        const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
        onOutput(bytes);
      } else if (msg.type === "exit") {
        onExit();
      } else if (msg.type === "conversation" && msg.entry) {
        const entry = typeof msg.entry === "string" ? JSON.parse(msg.entry) : msg.entry;
        onConversation(entry);
      }
    };

    ws.onclose = () => {
      setConnected(false);
    };

    return () => {
      ws.close();
    };
  }, [url]);

  const sendInput = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      // Use TextEncoder for multibyte (UTF-8) support
      const bytes = new TextEncoder().encode(data);
      const base64 = btoa(String.fromCharCode(...bytes));
      wsRef.current.send(JSON.stringify({
        type: "input",
        data: base64,
      }));
    }
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: "resize",
        cols,
        rows,
      }));
    }
  }, []);

  return { connected, sendInput, sendResize };
}
