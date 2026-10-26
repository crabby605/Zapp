'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

export interface Command {
    id: string;
    title: string;
    group: string;
    keys?: string;
    run: () => void;
}

// Subsequence match, the way every palette works: "rsim" finds "Run in the simulator".
function score(query: string, text: string): number | null {
    if (!query) return 0;
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    let index = 0;
    let hits = 0;
    for (const char of q) {
        const found = t.indexOf(char, index);
        if (found === -1) return null;
        if (found === index) hits++;      // reward runs
        index = found + 1;
    }
    return -(index - hits);               // earlier + contiguous wins
}

export function CommandPalette({ commands, onClose }: {
    commands: Command[];
    onClose: () => void;
}) {
    const [query, setQuery] = useState('');
    const [cursor, setCursor] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { inputRef.current?.focus(); }, []);

    const matches = useMemo(() => {
        const scored = commands
            .map((command) => ({ command, rank: score(query, `${command.group} ${command.title}`) }))
            .filter((entry): entry is { command: Command; rank: number } => entry.rank !== null);
        scored.sort((a, b) => b.rank - a.rank);
        return scored.slice(0, 40).map((entry) => entry.command);
    }, [commands, query]);

    useEffect(() => { setCursor(0); }, [query]);

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') return onClose();
        if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, matches.length - 1)); }
        if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
        if (e.key === 'Enter') {
            e.preventDefault();
            const chosen = matches[cursor];
            if (chosen) { onClose(); chosen.run(); }
        }
    };

    return (
        <div className="palette-backdrop" onMouseDown={onClose}>
            <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
                <input ref={inputRef} value={query} onKeyDown={onKeyDown}
                       onChange={(e) => setQuery(e.target.value)}
                       placeholder="Search files and commands" />
                <ul>
                    {matches.map((command, i) => (
                        <li key={command.id}
                            className={i === cursor ? 'active' : ''}
                            onMouseEnter={() => setCursor(i)}
                            onMouseDown={(e) => { e.preventDefault(); onClose(); command.run(); }}>
                            <span className="palette-group">{command.group}</span>
                            <span className="palette-title">{command.title}</span>
                            {command.keys && <kbd>{command.keys}</kbd>}
                        </li>
                    ))}
                    {matches.length === 0 && <li className="palette-empty">No matches</li>}
                </ul>
            </div>
        </div>
    );
}
