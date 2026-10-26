'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// Right-click menu, JetBrains-style: shortcut hints on the right, separators,
// arrow keys + Enter, Escape or a click elsewhere closes it.

export type MenuItem = { label: string; keys?: string; run: () => void; danger?: boolean; disabled?: boolean } | 'sep';

export interface MenuState { x: number; y: number; items: MenuItem[] }

export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ left: menu.x, top: menu.y });
    const actionable = menu.items.map((item, i) => (item !== 'sep' && !item.disabled ? i : -1)).filter((i) => i >= 0);
    const [cursor, setCursor] = useState(actionable[0] ?? -1);

    // Keep it on screen.
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const { width, height } = el.getBoundingClientRect();
        setPos({
            left: Math.max(4, Math.min(menu.x, window.innerWidth - width - 4)),
            top: Math.max(4, Math.min(menu.y, window.innerHeight - height - 4)),
        });
        el.focus();
    }, [menu]);

    useEffect(() => {
        const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
        window.addEventListener('mousedown', away, true);
        window.addEventListener('blur', onClose);
        window.addEventListener('resize', onClose);
        return () => {
            window.removeEventListener('mousedown', away, true);
            window.removeEventListener('blur', onClose);
            window.removeEventListener('resize', onClose);
        };
    }, [onClose]);

    const choose = (i: number) => {
        const item = menu.items[i];
        if (!item || item === 'sep' || item.disabled) return;
        onClose();
        item.run();
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        e.stopPropagation();
        const at = actionable.indexOf(cursor);
        if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(actionable[(at + 1) % actionable.length] ?? -1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(actionable[(at - 1 + actionable.length) % actionable.length] ?? -1); }
        else if (e.key === 'Enter') { e.preventDefault(); choose(cursor); }
    };

    return (
        <div ref={ref} className="ctx-menu" role="menu" tabIndex={-1} style={pos} onKeyDown={onKeyDown}
             onContextMenu={(e) => e.preventDefault()}>
            {menu.items.map((item, i) => item === 'sep'
                ? <hr key={i} />
                : (
                    <button key={i} role="menuitem" disabled={item.disabled}
                            className={`${i === cursor ? 'on' : ''} ${item.danger ? 'danger' : ''}`}
                            onMouseEnter={() => setCursor(i)} onClick={() => choose(i)}>
                        <span>{item.label}</span>
                        {item.keys && <kbd>{item.keys}</kbd>}
                    </button>
                ))}
        </div>
    );
}
