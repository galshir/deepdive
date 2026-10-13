import { useEffect, useState } from 'react';

type Mode = 'light' | 'dark';

function current(): Mode {
  return document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light') ? 'light' : 'dark';
}

/** Follows the VS Code theme (the body class changes when the user switches themes). */
export function useColorMode(): Mode {
  const [mode, setMode] = useState<Mode>(current);
  useEffect(() => {
    const obs = new MutationObserver(() => setMode(current()));
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return mode;
}
