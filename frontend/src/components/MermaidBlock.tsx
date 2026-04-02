import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  securityLevel: "loose",
});

let mermaidCounter = 0;

export function MermaidBlock({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const id = `mermaid-${++mermaidCounter}`;
    mermaid
      .render(id, chart)
      .then(({ svg }) => {
        setSvg(svg);
        setError("");
      })
      .catch((err) => {
        setError(String(err));
        setSvg("");
      });
  }, [chart]);

  if (error) {
    return <pre className="text-red-400 text-xs p-2">{error}</pre>;
  }

  return (
    <div
      ref={containerRef}
      className="my-2 flex justify-center"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
