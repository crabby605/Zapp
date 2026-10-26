// Monaco from this app's own bundle instead of the loader's default CDN copy:
// one version we control (no third-party script on the public site), with the
// patched DOMPurify that scripts/patch-monaco.js puts in place at install time.
// Browser only — import it dynamically.

import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';

self.MonacoEnvironment = {
    getWorker: () => new Worker(new URL('monaco-editor/editor/editor.worker.start.js', import.meta.url), { type: 'module' }),
};
loader.config({ monaco });

export { loader };
