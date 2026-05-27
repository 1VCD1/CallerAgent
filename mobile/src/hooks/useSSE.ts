import { useEffect, useRef } from 'react';

export function useSSE(
  url: string | null,
  onEvent: (event: string, data: unknown) => void
) {
  // Keep onEvent stable so the effect doesn't re-run on every render
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!url) return;

    const xhr = new XMLHttpRequest();
    let offset = 0;
    let active = true;

    xhr.open('GET', url, true);

    xhr.onprogress = () => {
      if (!active) return;
      const chunk = xhr.responseText.slice(offset);
      offset = xhr.responseText.length;

      // SSE blocks are separated by \n\n
      for (const block of chunk.split('\n\n')) {
        if (!block.trim()) continue;
        let eventName = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) eventName = line.slice(7).trim();
          else if (line.startsWith('data: ')) data = line.slice(6).trim();
        }
        if (data) {
          try { onEventRef.current(eventName, JSON.parse(data)); }
          catch { onEventRef.current(eventName, data); }
        }
      }
    };

    xhr.onerror = () => { active = false; };
    xhr.send();

    return () => {
      active = false;
      xhr.abort();
    };
  }, [url]);
}
