'use client';

import { useCallback, useRef, useState } from 'react';

// In-app replacements for window.confirm / window.prompt, so the IDE never
// shows a browser dialog. `await confirm(...)` → true/false,
// `await prompt(...)` → the text, or null if cancelled.

interface Ask {
    title: string;
    body?: string;
    confirmLabel?: string;
    danger?: boolean;
    input?: { initial: string; placeholder?: string };
}

export function useDialogs() {
    const [ask, setAsk] = useState<Ask | null>(null);
    const resolver = useRef<((value: string | boolean | null) => void) | null>(null);

    const open = useCallback(<T,>(a: Ask) => new Promise<T>((resolve) => {
        resolver.current?.(a.input ? null : false);   // a newer question replaces an older one
        resolver.current = resolve as (value: string | boolean | null) => void;
        setAsk(a);
    }), []);

    const confirm = useCallback((a: Omit<Ask, 'input'>) => open<boolean>(a), [open]);
    const prompt = useCallback((a: Ask & { input: NonNullable<Ask['input']> }) => open<string | null>(a), [open]);

    const close = (value: string | boolean | null) => {
        resolver.current?.(value);
        resolver.current = null;
        setAsk(null);
    };

    const element = ask && <Dialog ask={ask} onDone={close} />;
    return { confirm, prompt, element };
}

function Dialog({ ask, onDone }: { ask: Ask; onDone: (value: string | boolean | null) => void }) {
    const [text, setText] = useState(ask.input?.initial ?? '');
    const cancel = () => onDone(ask.input ? null : false);
    const ok = () => {
        if (!ask.input) return onDone(true);
        if (text.trim()) onDone(text.trim());
    };

    return (
        <div className="palette-backdrop" onMouseDown={cancel}>
            <form className="dialog small" role="alertdialog" aria-label={ask.title}
                  onMouseDown={(e) => e.stopPropagation()}
                  onSubmit={(e) => { e.preventDefault(); ok(); }}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }}>
                <h2>{ask.title}</h2>
                {ask.body && <p className="dialog-body">{ask.body}</p>}
                {ask.input && (
                    <input className="side-search" autoFocus value={text} placeholder={ask.input.placeholder}
                           spellCheck={false} onChange={(e) => setText(e.target.value)}
                           onFocus={(e) => {
                               const dot = e.target.value.lastIndexOf('.');
                               e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
                           }} />
                )}
                <div className="dialog-actions">
                    <button type="button" className="nav-btn ghost" onClick={cancel}>Cancel</button>
                    <button type="submit" className={`nav-btn ${ask.danger ? 'danger' : 'accent'}`} autoFocus={!ask.input}
                            disabled={!!ask.input && !text.trim()}>
                        {ask.confirmLabel ?? 'OK'}
                    </button>
                </div>
            </form>
        </div>
    );
}
